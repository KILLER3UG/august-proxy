"""Import a Claude memory export into the facts store, merged with what August already knows.

The export is a directory (or a ``.zip`` of one) of Markdown files: ``profile.md``,
``preferences.md`` and ``areas/`` + ``topics/`` folders, each file a small
frontmatter block (``name``, ``description``) over a flat bullet list. The import
maps that shape onto August's own store instead of parking it beside it —
one memory store, ``facts`` as the system of record:

* **file → lane.** ``profile.md`` lands as ``kind='profile'`` and
  ``preferences.md`` as ``kind='preference'``, the two kinds the always-in-context
  lane reads (no BM25 slot to win). ``areas/*`` become ``category='project'`` rows
  and ``topics/*`` ``category='reference'`` rows, so they join keyword recall like
  every other fact.
* **bullet → one fact.** A bullet is one statement, so it gets one row, keyed by
  the same slug the ``remember`` door derives: re-importing the same export
  updates those rows instead of restating them.
* **an existing near-duplicate under a different key is a merge, not a write.**
  The row already in the store wins and the report names what it folded into,
  because "already known, under another key" is the difference between a
  migration and a duplicate corpus.

Writes go through ``save_fact`` — the door that already refuses credential-shaped
content — so an import cannot smuggle a secret into memory.
"""

from __future__ import annotations

import json
import logging
import re
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

logger = logging.getLogger(__name__)

MAX_FILES = 200
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
#: Entries per file and across one import. A 600-bullet dump is a document, not
#: a memory export, and importing it would flood recall rather than inform it.
MAX_FILE_ENTRIES = 200
MAX_IMPORT_ENTRIES = 600

SOURCE_PREFIX = 'imported:claude'

_FRONTMATTER_RE = re.compile(r'\A---\s*\r?\n(.*?)\r?\n---\s*\r?\n', re.DOTALL)
_BULLET_RE = re.compile(r'^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*\S)\s*$')
_HEADING_RE = re.compile(r'^\s{0,3}#{1,6}\s+(.*\S)\s*$')
_LABEL_RE = re.compile(r'^\s*(?:(?:\*\*|__)(.+?)(?:\*\*|__)|\*([^*]+)\*)\s*:?\s*$')
_NOISE_RE = re.compile(r'^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|```|~~~)\s*$')
_CODE_RE = re.compile(r'`([^`\n]*)`')
_BOLD_RE = re.compile(r'(\*\*|__)(.+?)\1', re.DOTALL)
_EM_RE = re.compile(r'(?<![A-Za-z0-9])\*([^*\n]+)\*(?![A-Za-z0-9])')


def _clean(text: str) -> str:
    """Drop the Markdown decoration, keep the sentence."""
    out = _BOLD_RE.sub(r'\2', text)
    out = _EM_RE.sub(r'\1', out)
    out = _CODE_RE.sub(r'\1', out)
    return re.sub(r'\s+', ' ', out).strip()


def _slug(text: str) -> str:
    """The key the `remember` door would derive for the same sentence."""
    words = re.sub(r'[^a-z0-9\s-]', ' ', text.lower()).split()
    return re.sub(r'[^a-z0-9-]+', '-', '-'.join(words[:6])).strip('-')[:48]


def _lane_for(rel_path: str) -> tuple[str, str]:
    """(kind, category) for one export file, from its position in the export."""
    name = rel_path.rsplit('/', 1)[-1].lower()
    if name in ('profile.md', 'me.md', 'identity.md'):
        return 'profile', 'user'
    if name in ('preferences.md', 'feedback.md', 'style.md'):
        return 'preference', 'feedback'
    folder = rel_path.split('/')[0].lower() if '/' in rel_path else ''
    if folder == 'areas':
        return 'fact', 'project'
    if folder == 'topics':
        return 'fact', 'reference'
    return 'fact', 'general'


def _frontmatter(text: str) -> tuple[dict[str, str], str]:
    match = _FRONTMATTER_RE.match(text)
    fields: dict[str, str] = {}
    body = text
    if match:
        body = text[match.end():]
        for line in match.group(1).splitlines():
            key, sep, value = line.partition(':')
            if sep:
                fields[key.strip().lower()] = value.strip().strip('"').strip("'")
    return fields, body


def parse_export_file(rel_path: str, text: str) -> list[dict[str, str]]:
    """One export file → one entry per bullet, with the file's own line as the hook."""
    fields, body = _frontmatter(text)
    kind, category = _lane_for(rel_path)
    hook = (fields.get('description') or '').strip()
    label = (fields.get('name') or Path(rel_path).stem).strip()
    entries: list[dict[str, str]] = []
    hint = ''
    for raw in body.splitlines():
        line = raw.rstrip()
        if not line.strip() or _NOISE_RE.match(line):
            continue
        bullet = _BULLET_RE.match(line)
        if bullet:
            value = _clean(bullet.group(1))
            if len(value) >= 3:
                key = _slug(value)
                if key:
                    entries.append({
                        'key': key,
                        'value': value,
                        'kind': kind,
                        'category': category,
                        'title': (hint or label or value)[:80],
                        'description': hook[:240],
                        'details': f'source: {rel_path}' + (f' · {hint}' if hint else ''),
                    })
            if len(entries) >= MAX_FILE_ENTRIES:
                break
            continue
        heading = _HEADING_RE.match(line)
        if heading:
            hint = _clean(heading.group(1))
            continue
        section = _LABEL_RE.match(line)
        if section:
            hint = _clean(section.group(1) or section.group(2) or '')
    return entries


def _safe_member(name: str) -> str | None:
    """The validated relative name of one zip member, or None to skip it.

    A zip member name is supplied by the archive, never resolved against the
    filesystem, so an escaping or absolute name is dropped here rather than
    normalised somewhere it could land outside the export.
    """
    normalized = name.replace('\\', '/')
    if re.match(r'^[A-Za-z]:', normalized) or normalized.startswith('/'):
        return None
    pure = PurePosixPath(normalized)
    if any(part == '..' for part in pure.parts) or pure.suffix.lower() != '.md':
        return None
    return pure.as_posix()


def read_export(path: str | Path) -> list[tuple[str, str]]:
    """Every readable ``.md`` of an export, as ``(relative-name, text)`` pairs."""
    root = Path(str(path or '')).expanduser()
    if not root.exists():
        raise ValueError(f'No such file or directory: {root}')
    out: list[tuple[str, str]] = []
    total = 0
    if root.is_dir():
        files = sorted(
            p for p in root.rglob('*.md')
            if p.is_file() and not any(
                part.startswith('.') for part in p.relative_to(root).parts
            )
        )
        for p in files:
            if len(out) >= MAX_FILES:
                break
            try:
                size = p.stat().st_size
            except OSError:
                continue
            if size > MAX_FILE_BYTES or total + size > MAX_TOTAL_BYTES:
                continue
            try:
                text = p.read_text('utf-8', errors='replace')
            except OSError:
                continue
            total += size
            out.append((p.relative_to(root).as_posix(), text))
        return out
    if root.suffix.lower() != '.zip':
        raise ValueError('Point at the Claude export folder or its .zip')
    try:
        archive = zipfile.ZipFile(root)
    except (OSError, zipfile.BadZipFile) as exc:
        raise ValueError(f'That .zip could not be read: {exc}') from exc
    with archive:
        for info in archive.infolist():
            if len(out) >= MAX_FILES:
                break
            if info.is_dir():
                continue
            member = _safe_member(info.filename)
            if member is None or info.file_size > MAX_FILE_BYTES:
                continue
            if total + info.file_size > MAX_TOTAL_BYTES:
                continue
            try:
                raw = archive.read(info)
            except (OSError, zipfile.BadZipFile) as exc:
                logger.debug('memory import: skipped unreadable member %s (%s)', info.filename, exc)
                continue
            total += len(raw)
            out.append((member, raw.decode('utf-8', errors='replace')))
    return out


def _normalized(value: object) -> str:
    return re.sub(r'\s+', ' ', str(value or '')).strip().lower()


def _stored_text(value: object) -> str:
    """The body of a stored fact value — ``save_fact`` JSON-encodes what it keeps.

    Without this, re-importing the same export reads the stored ``'"text"'`` and
    sees a change that is only the encoding, so an idempotent import reports 184
    writes instead of 184 unchanged rows.
    """
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return value
        return _stored_text(decoded)
    if isinstance(value, dict):
        fact = str(value.get('fact') or '').strip()
        details = str(value.get('details') or '').strip()
        return ' '.join(part for part in (fact, details) if part)
    return str(value or '')


def import_claude_export(path: str | Path, dry_run: bool = False) -> dict[str, Any]:
    """Import a Claude export into the global facts store, merged with what is there.

    Never raises for one bad row: a refusal costs exactly that entry and is
    reported with its reason, the same rule the distiller's memory door holds.
    """
    from app.services import memory_store
    from app.services.memory_quality import DEDUPE_SIMILARITY, duplicateOf
    from app.services.rollback_store import record_rollback

    sources = read_export(path)
    if not sources:
        return {'ok': False, 'error': 'No Markdown memory files found in that export'}

    counts = {'created': 0, 'updated': 0, 'unchanged': 0, 'merged': 0, 'refused': 0, 'capped': 0}
    rows: list[dict[str, object]] = []
    seen: set[str] = set()
    parsed = 0

    for rel_path, text in sources:
        for entry in parse_export_file(rel_path, text):
            if parsed >= MAX_IMPORT_ENTRIES:
                counts['capped'] += 1
                continue
            parsed += 1
            key = entry['key']
            if key in seen:
                # Two bullets that slug together describe one memory.
                counts['unchanged'] += 1
                continue
            seen.add(key)
            # The reads happen whether or not this is a dry run: a plan that
            # cannot see the store would report every line as new.
            existing = memory_store.get_fact(key)
            if existing is not None and _normalized(_stored_text(existing.get('factValue'))) == _normalized(
                entry['value']
            ):
                counts['unchanged'] += 1
                continue
            folded_into = ''
            if existing is None:
                ratio, dupKey = duplicateOf(entry['value'], scope='global')
                if ratio >= DEDUPE_SIMILARITY and dupKey != key:
                    folded_into = dupKey
            if folded_into:
                counts['merged'] += 1
                rows.append({
                    'key': key, 'action': 'merged', 'into': folded_into,
                    'title': entry['title'], 'kind': entry['kind'],
                })
                continue
            if dry_run:
                counts['created' if existing is None else 'updated'] += 1
                rows.append({
                    'key': key, 'action': 'planned',
                    'would': 'update' if existing is not None else 'create',
                    'title': entry['title'], 'kind': entry['kind'], 'category': entry['category'],
                })
                continue
            before = dict(existing) if existing else None
            try:
                memory_store.save_fact(
                    key,
                    entry['value'],
                    category=entry['category'],
                    source=SOURCE_PREFIX,
                    title=entry['title'],
                    kind=entry['kind'],
                    description=entry['description'],
                    verified=True,
                )
            except ValueError as exc:
                counts['refused'] += 1
                rows.append({'key': key, 'action': 'refused', 'reason': str(exc)[:200], 'title': entry['title']})
                continue
            except Exception as exc:  # noqa: BLE001 — one bad row costs one row
                counts['refused'] += 1
                rows.append({
                    'key': key, 'action': 'refused',
                    'reason': f'{type(exc).__name__}: {exc}'[:200], 'title': entry['title'],
                })
                continue
            try:
                record_rollback(
                    type='restore_memory_item',
                    target=key,
                    before=before,
                    after={'key': key, 'value': entry['value'], 'source': SOURCE_PREFIX},
                )
            except Exception:  # noqa: BLE001 — a missing rollback row must not fail the import
                logger.debug('memory import: rollback record failed for %s', key, exc_info=True)
            counts['created' if existing is None else 'updated'] += 1
            rows.append({
                'key': key, 'action': 'created' if existing is None else 'updated',
                'title': entry['title'], 'kind': entry['kind'], 'category': entry['category'],
            })

    return {
        'ok': True,
        'dryRun': dry_run,
        'files': len(sources),
        'entries': parsed,
        **counts,
        'rows': rows[:80],
    }
