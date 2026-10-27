"""The markdown mirror — a derived, human-readable view of the facts store.

The store of record is the brain SQLite database; every read door (recall,
BM25, the boot index, brain_query) reads ONLY the database. These files are
the readable surface the 2026-08-26 readability ruling asked for: one file
per active fact under ``<dataDir>/memory/`` plus a ``MEMORY.md`` index in
the ZCode shape, maintained as a side effect of every mutating write and
rebuilt wholesale at boot.

That derivation goes one way, and the fences keep it honest:

* Hand edits are a preview, not a write path — they are overwritten at the
  next mutation or boot. Nothing reads these files back, so the two can
  never disagree about what recall injects.
* The directory is in the model write fence (``hardline._AGENT_STATE_DIRS``),
  for the same reason the proposal inbox is: a model that can write the
  human-readable view can install instruction-shaped content beside the
  facts a human reads to audit it. The sanctioned writer is this module.
* Sensitive rows and other people's details (``subject_type='person'``) are
  excluded — the same exclusions the boot index applies. They stay in the
  database where the read doors can filter them.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from app.json_narrowing import as_str
from app.services.best_effort import best_effort
from app.type_aliases import FactDict

_INDEX_NAME = 'MEMORY.md'
_MAX_FILE_STEM = 72
_SANITIZE_RE = re.compile(r'[^A-Za-z0-9._-]+')

# The ZCode memory vocabulary, accepted as INPUT aliases and mapped onto the
# record's canonical subject types. `user` covers who the user is (profile)
# and how they want the assistant to behave (preference) in ZCode's single
# bucket, so it maps to the closest canonical; the mirror frontmatter still
# prints the canonical word.
_SUBJECT_ALIASES = {
    'user': 'profile',
    'feedback': 'preference',
    'project': 'area',
    'reference': 'topic',
}


def normalize_subject_type(subject_type: str) -> str:
    """Map a ZCode-vocabulary type onto the canonical subject type.

    Unknown words are returned unchanged — the caller's own validation
    decides whether they are legal.
    """
    return _SUBJECT_ALIASES.get((subject_type or '').strip().lower(), (subject_type or '').strip().lower())


def mirror_root() -> Path:
    from app.lib.paths import dataPath

    return dataPath('memory')


def _safe_stem(fact_key: str) -> str:
    """A stable, readable filename for a key, with a hash suffix when the
    sanitization or the length cap actually changed something — so two keys
    that sanitize alike cannot share a file."""
    stem = _SANITIZE_RE.sub('_', fact_key).strip('.')[:_MAX_FILE_STEM].strip('.')
    if stem != fact_key or len(fact_key) > _MAX_FILE_STEM:
        digest = hashlib.sha1(fact_key.encode('utf-8')).hexdigest()[:8]
        stem = f'{stem}.{digest}'
    return stem or 'fact'


def _zcode_type(subject_type: str, kind: str) -> str:
    """The frontmatter `type:` — ZCode's vocabulary, best-effort."""
    st = (subject_type or '').strip().lower()
    kind_l = (kind or '').strip().lower()
    if st == 'profile' or kind_l == 'profile':
        return 'user'
    if st == 'preference' or kind_l == 'preference':
        return 'feedback'
    if st == 'area':
        return 'project'
    return 'reference' if kind_l in ('skill-note', 'reference') else 'project' if kind_l == 'project' else 'user'


def _body_text(row: FactDict) -> str:
    """The fact value (JSON-encoded on the row) rendered as the file body."""
    raw = row.get('factValue') if 'factValue' in row else row.get('fact_value')
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        value = raw
    if isinstance(value, dict):
        parts = [str(value.get('fact') or '').strip()]
        details = str(value.get('details') or '').strip()
        if details:
            parts.append(details)
        return '\n\n'.join(p for p in parts if p)
    return str(value or '').strip()


def _fact_file(key: str) -> Path:
    return mirror_root() / f'{_safe_stem(key)}.md'


def _render_fact_file(row: FactDict) -> str:
    key = as_str(row.get('factKey') if 'factKey' in row else row.get('fact_key'))
    title = as_str(row.get('title')) or key
    description = as_str(row.get('description'))
    subject = as_str(row.get('subjectType') if 'subjectType' in row else row.get('subject_type'))
    kind = as_str(row.get('kind'))
    tag = as_str(row.get('tag'))
    scope = as_str(row.get('scope')) or 'global'
    updated = as_str(row.get('updatedAt') if 'updatedAt' in row else row.get('updated_at'))
    version = row.get('version')
    previous = as_str(row.get('previousValue') if 'previousValue' in row else row.get('previous_value'))
    lines = [
        '---',
        f'name: {title}',
        f'description: {description}',
        f'key: {key}',
        f'type: {_zcode_type(subject, kind)}',
        f'subject: {subject}',
        f'tag: {tag}',
        f'scope: {scope}',
        f'updated: {updated}',
        f'version: {version if version is not None else 1}',
        '---',
        '',
        _body_text(row),
    ]
    if previous:
        lines += ['', f'> Previously: {previous}']
    return '\n'.join(lines) + '\n'


def _load_row(fact_key: str) -> FactDict | None:
    from app.services.memory_store.rest import get_fact

    row = get_fact(fact_key)
    if not row:
        return None
    if row.get('sensitive'):
        return None
    if str(row.get('subjectType') or '') == 'person':
        return None
    if str(row.get('status') or 'active') != 'active':
        return None
    expires = str(row.get('expiresAt') or row.get('expires_at') or '')
    if expires:
        return None  # expired or expiring rows drop out; a write revives them
    return row


def note_fact_changed(fact_key: str) -> None:
    """Maintain ONE fact's file + the index after a write or delete.

    Best-effort by contract: a mirror failure is logged and never blocks or
    fails the store write that triggered it. O(index) per call — the index
    rewrite is a single SELECT plus one file write, not a per-file sweep.
    """
    with best_effort('memory-mirror.note'):
        root = mirror_root()
        root.mkdir(parents=True, exist_ok=True)
        target = _fact_file(fact_key)
        row = _load_row(fact_key)
        if row is None:
            # Deleted, retired, sensitive-stamped or expired: the file goes.
            target.unlink(missing_ok=True)
        else:
            target.write_text(_render_fact_file(row), encoding='utf-8')
        _write_index(root)


def rebuild_mirror() -> int:
    """Regenerate the whole mirror from the store. Returns the file count.

    The boot-time drift repair (hand edits and out-of-band writes are
    overwritten) and the consolidation hook — a pass that touches many rows
    calls this once instead of per row.
    """
    from app.services.memory_store import brain

    with best_effort('memory-mirror.rebuild'):
        root = mirror_root()
        root.mkdir(parents=True, exist_ok=True)
        conn = brain._conn()
        rows = conn.execute(
            "SELECT * FROM facts WHERE (status IS NULL OR status = 'active') "
            "AND COALESCE(sensitive, 0) = 0 "
            "AND COALESCE(subject_type, '') != 'person' "
            "AND (expires_at IS NULL OR expires_at = '')"
        ).fetchall()
        wanted: dict[str, str] = {}
        for raw in rows:
            from app.services.memory_store.rest import _factRow

            row = _factRow(raw)
            key = as_str(row.get('factKey'))
            if not key:
                continue
            stem = _safe_stem(key)
            wanted[stem] = key
            (root / f'{stem}.md').write_text(_render_fact_file(row), encoding='utf-8')
        # Orphan sweep: files whose key no longer qualifies (deleted,
        # retired, now-sensitive) or that were hand-created.
        for child in root.glob('*.md'):
            if child.name == _INDEX_NAME:
                continue
            if child.stem not in wanted:
                child.unlink(missing_ok=True)
        _write_index(root)
        return len(wanted)
    return 0


def _write_index(root: Path) -> None:
    from app.services.memory_store import brain
    from app.services.memory_store.rest import _factRow

    rows = brain._conn().execute(
        "SELECT * FROM facts WHERE (status IS NULL OR status = 'active') "
        "AND COALESCE(sensitive, 0) = 0 "
        "AND COALESCE(subject_type, '') != 'person' "
        "AND (expires_at IS NULL OR expires_at = '') "
        'ORDER BY updated_at DESC'
    ).fetchall()
    lines = [
        '# Memory index',
        '',
        'One line per fact; the full content is in the file beside it. These',
        'files are a readable view of the brain database — the store of record.',
        'Hand edits here are overwritten at the next write or app boot.',
        '',
    ]
    for raw in rows:
        row = _factRow(raw)
        key = as_str(row.get('factKey'))
        title = as_str(row.get('title')) or key
        description = as_str(row.get('description'))
        if not description:
            description = _body_text(row)[:120]
        lines.append(f'- [{title}]({_safe_stem(key)}.md) — {description}')
    (root / _INDEX_NAME).write_text('\n'.join(lines) + '\n', encoding='utf-8')
