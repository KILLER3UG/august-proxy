"""T17 read-before-edit gate with version freshness (plan §9.4).

Per-session in-memory map ``file -> observed version`` (sha256 of content at
last read). Editing a file the session never observed fails with a distinct
``[edit-unseen]`` error code + remedy text ("read the file, then retry");
editing a file whose content changed since the last observation fails with
``[edit-stale]`` + "re-read, then retry".

No prompt or schema changes — the gate is a listener on file mutations in
the workbench loop and can be removed without breaking the tools. The map
is session-scoped and dropped on restart. Hash anchors inside the tools
remain the staleness gate; this adds the *observation requirement* in front
of it (the two are complementary, per the T4/T17 split).
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import TYPE_CHECKING

from app.json_narrowing import as_str

if TYPE_CHECKING:
    from app.services.workbench.sessions import WorkbenchSession

# Registered mutation tools that carry a single-file ``path`` input.
# (Multi-file surfaces like code-mode writes are out of scope — the gate is
# a workbench-loop listener.)
GATED_EDIT_TOOLS = frozenset({'write_file', 'edit_lines', 'apply_patch'})

UNSEEN_CODE = '[edit-unseen]'
STALE_CODE = '[edit-stale]'
_ATTR = '_observedFiles'
_SHA_HEADER_RE = re.compile(r'^\[sha256 ([0-9a-f]{64})\]')


def _observed_map(session: 'WorkbenchSession') -> dict[str, str]:
    m = getattr(session, _ATTR, None)
    if not isinstance(m, dict):
        m = {}
        setattr(session, _ATTR, m)
    return m


def _key(session: 'WorkbenchSession', path_raw: str) -> str | None:
    """Normalize a tool path input to an absolute key ('' → None)."""
    if not path_raw:
        return None
    try:
        p = Path(path_raw)
        if not p.is_absolute():
            workspace = as_str(getattr(session, 'workspacePath', None), '')
            if not workspace:
                return None
            p = Path(workspace) / p
        return str(p.resolve())
    except (OSError, ValueError):
        return None


def _file_version(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def check_read_before_edit(
    session: 'WorkbenchSession', tool_name: str, tool_input: dict[str, object]
) -> str | None:
    """Pre-dispatch gate: error text when the edit must be refused, else None.

    Creating a new file is always allowed; editing an unseen or stale file
    fails fast with a distinct code + remedy so the model can self-correct.
    """
    if tool_name not in GATED_EDIT_TOOLS:
        return None
    key = _key(session, as_str(tool_input.get('path'), ''))
    if key is None:
        return None
    target = Path(key)
    if not target.exists():
        return None  # creation — nothing to observe yet
    observed = _observed_map(session).get(key)
    if observed is None:
        return (
            f'Error: {UNSEEN_CODE} {target.name} has not been read in this session. '
            'Read the file with read_file first, then retry the edit.'
        )
    current = _file_version(target)
    if current is not None and current != observed:
        return (
            f'Error: {STALE_CODE} {target.name} changed since you last read it '
            f'(observed {observed[:12]}…, now {current[:12]}…). '
            'Re-read the file, then retry the edit.'
        )
    return None


def observe_from_read_result(
    session: 'WorkbenchSession', tool_name: str, tool_input: dict[str, object], result: str
) -> None:
    """Record the version a successful read_file showed the model."""
    if tool_name != 'read_file' or not isinstance(result, str):
        return
    m = _SHA_HEADER_RE.match(result)
    if not m:
        return  # error result or header drift — not an observation
    key = _key(session, as_str(tool_input.get('path'), ''))
    if key:
        _observed_map(session)[key] = m.group(1)


def observe_after_mutation(
    session: 'WorkbenchSession', tool_name: str, tool_input: dict[str, object]
) -> None:
    """After a successful mutation, record the new version so follow-up edits
    in the same session pass the gate without another read."""
    if tool_name not in GATED_EDIT_TOOLS:
        return
    key = _key(session, as_str(tool_input.get('path'), ''))
    if key is None:
        return
    version = _file_version(Path(key))
    if version is not None:
        _observed_map(session)[key] = version
