"""SKILL.md version history (audit P2#13).

A skill is a file a human edits, a proposal applier rewrites, and a distiller
rewrites again. Until this module existed, "what did it used to say?" had no
answer: the only record was ``.usage.json``'s counters. Every content write
site now calls :func:`snapshot_before_write` FIRST, so the content being
replaced is on disk before the replacement lands.

Layout — deliberately inside the skill directory, beside the file it versions::

    <dataDir>/skills/<name>/SKILL.md          the live skill
    <dataDir>/skills/<name>/.versions/<ts>.md a snapshot of the PREVIOUS content
    <dataDir>/skills/<name>/.versions/meta.json  [{ts, actor, rationale, prevSha256}, …]

``ts`` is a unixts string; it is also the filename stem, so a version id can
never point at two different snapshots and the listing needs no index of its
own (meta.json is the human-readable record, not the lookup authority).

Rules this module keeps:

* **Best effort, always.** Every public function swallows I/O failure and logs
  at DEBUG. A history that cannot be written must never take a skill write
  down with it — the write is the user's actual intent, the snapshot is a
  convenience for undo.
* **Bounded.** History is capped at :data:`MAX_VERSIONS` entries; the oldest
  snapshot file is unlinked with the record that named it, so a long-lived
  skill cannot grow an unbounded directory.
* **A create is not a change.** With no live ``SKILL.md`` there is no prior
  content to preserve, so :func:`snapshot_before_write` is a no-op — the first
  version of a file is not a revision of one.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Any

from app.services.best_effort import best_effort

logger = logging.getLogger(__name__)

# The retention cap. 20 revisions is deep enough to walk back through a
# long editing session and shallow enough that 20 copies of every skill in a
# large library stays trivially small.
MAX_VERSIONS = 20

_VERSIONS_DIRNAME = '.versions'
_META_FILENAME = 'meta.json'


def _versions_dir(skill_dir: Path) -> Path:
    return Path(skill_dir) / _VERSIONS_DIRNAME


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def _read_meta(versions_dir: Path) -> list[dict[str, Any]]:
    """Parse ``meta.json`` into records. A missing or corrupt file reads empty."""
    raw: object = None
    with best_effort('skill-versions.read-meta'):
        raw = json.loads((versions_dir / _META_FILENAME).read_text(encoding='utf-8'))
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        ts = str(item.get('ts') or '').strip()
        if not ts.isdigit():
            continue
        out.append(
            {
                'ts': ts,
                'actor': str(item.get('actor') or '')[:64],
                'rationale': str(item.get('rationale') or '')[:500],
                'prevSha256': str(item.get('prevSha256') or '')[:64],
            }
        )
    return out


def _write_meta(versions_dir: Path, records: list[dict[str, Any]]) -> None:
    (versions_dir / _META_FILENAME).write_text(
        json.dumps(records, indent=2, ensure_ascii=False), encoding='utf-8'
    )


def list_versions(skill_dir: Path) -> list[dict[str, str]]:
    """Every retained snapshot for one skill, newest first.

    Shape is the API's: ``{ts, actor, rationale, sha}`` where ``sha`` is the
    SHA-256 of the snapshotted content — the thing a caller can compare
    against the live file's own hash to tell "restored" from "still on it".
    """
    versions_dir = _versions_dir(skill_dir)
    records = _read_meta(versions_dir)
    out: list[dict[str, str]] = []
    for rec in sorted(records, key=lambda r: str(r.get('ts') or ''), reverse=True):
        ts = str(rec.get('ts') or '')
        out.append(
            {
                'ts': ts,
                'actor': str(rec.get('actor') or ''),
                'rationale': str(rec.get('rationale') or ''),
                'sha': str(rec.get('prevSha256') or ''),
            }
        )
    return out


def read_version(skill_dir: Path, ts: str) -> str | None:
    """The content of one snapshot, or ``None`` when it is not retained.

    ``ts`` must be a bare unixts string. The digit check is the traversal
    guard: this value reaches a URL path segment, and a skill directory is a
    real place a write could land.
    """
    key = str(ts or '').strip()
    if not key.isdigit():
        return None
    path = _versions_dir(skill_dir) / f'{key}.md'
    text: str | None = None
    with best_effort('skill-versions.read-version'):
        text = path.read_text(encoding='utf-8')
    return text


def snapshot_before_write(
    skill_dir: Path,
    new_content: str,
    *,
    actor: str,
    rationale: str,
) -> str:
    """Preserve the CURRENT ``SKILL.md`` before ``new_content`` replaces it.

    Returns the id the snapshot was stored under, or ``''`` when nothing was
    written. The id is what makes an undo addressable: the auto-apply path
    records it, so probation can name the exact bytes to put back instead of
    guessing at "the previous version" after someone else has written one.

    ``new_content`` is not written here — this records what is about to be
    lost, so a caller keeps ONE write site and the history cannot disagree
    with the file. ``actor`` names who is doing it (``user`` / ``distiller`` /
    ``curator``) and ``rationale`` says why, because a snapshot with no
    reason attached is a list of files nobody will ever read.

    No live ``SKILL.md`` means a create, not a change: nothing is stored.
    Any failure is logged at DEBUG and swallowed — a skill write is never
    blocked on its history.
    """
    with best_effort('skill-versions.snapshot'):
        directory = Path(skill_dir)
        md = directory / 'SKILL.md'
        if not md.is_file():
            return ''  # a create has no previous content to preserve
        current = md.read_text(encoding='utf-8')
        if current == new_content:
            return ''  # a no-op write is not a revision
        versions_dir = _versions_dir(directory)
        versions_dir.mkdir(parents=True, exist_ok=True)
        ts = int(time.time())
        while (versions_dir / f'{ts}.md').exists():
            ts += 1  # two writes in the same second stay two distinct versions
        (versions_dir / f'{ts}.md').write_text(current, encoding='utf-8')
        records = _read_meta(versions_dir)
        records.append(
            {
                'ts': str(ts),
                'actor': str(actor or '')[:64],
                'rationale': str(rationale or '')[:500],
                'prevSha256': _sha256(current),
            }
        )
        # Cap history: the oldest record AND its snapshot file go together,
        # so meta.json never names a file that is no longer there.
        while len(records) > MAX_VERSIONS:
            dropped = records.pop(0)
            stale = versions_dir / f"{dropped.get('ts')}.md"
            with best_effort('skill-versions.prune'):
                stale.unlink(missing_ok=True)
        _write_meta(versions_dir, records)
        return str(ts)
    # Reached only when best_effort swallowed a failure: the write went ahead
    # with no snapshot, so there is no id to name.
    return ''
