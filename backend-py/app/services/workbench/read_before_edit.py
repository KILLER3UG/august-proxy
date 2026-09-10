"""Read-before-edit gate with version freshness.

Per-session in-memory map ``file -> observed version`` (sha256 of content at
last read). Editing a file the session never observed fails with a distinct
``[edit-unseen]`` error code + remedy text ("File has not been read yet.
Read it first before writing to it."); editing a file whose content changed
since the last observation fails with ``[edit-stale]`` + "re-read, then
retry".

A successful mutation records the new bytes in a second ``written`` map
INSTEAD of forgetting the observation: this is what makes MULTI-EDITING
work — the model can issue several edits to the same file in one turn
without re-reading. A follow-up edit whose provided ``fileHash`` still
matches the ORIGINAL observation is accepted when the only intervening
change was August's own write (the gate normalizes the stale hash to the
current bytes before dispatch). Any foreign change (user edit, formatter,
another process) still fails fast as stale.

No prompt or schema changes — the gate is a listener on file mutations in
the workbench loop and can be removed without breaking the tools. The map
is session-scoped and dropped on restart. Hash anchors inside the tools
remain the staleness gate; this adds the *observation requirement* in front
of it (the two are complementary).
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import TYPE_CHECKING

from app.json_narrowing import as_str

if TYPE_CHECKING:
    from app.services.workbench.sessions import WorkbenchSession

# Shared staleness receipt sentence (ZCode-style). Every stale-write guard in
# the product — the read-before-edit gate, edit_lines' fileHash check,
# apply_patch's hash check, and the workbench-level hash gate — composes this
# constant so the model sees ONE wording for one failure class regardless of
# which gate catches it. Each site supplies its own "has"/"have" auxiliary.
STALE_WRITE_HEADLINE = 'been modified since read, either by the user or by a linter'

# Registered mutation tools that write workspace files. ``bulk`` is gated
# only when its operation resolves to write_files. Code-mode's child-process
# write_file stays out of scope — it runs in a spawned interpreter that
# cannot see this ledger; its sandbox containment still applies.
GATED_EDIT_TOOLS = frozenset({'write_file', 'edit_lines', 'apply_patch', 'write_files'})

BULK_TOOL = 'bulk'
UNSEEN_CODE = '[edit-unseen]'
STALE_CODE = '[edit-stale]'
_ATTR = '_observedFiles'
# Hashes of bytes August itself wrote (chained multi-edit support).
_WRITTEN_ATTR = '_writtenFiles'
_SHA_HEADER_RE = re.compile(r'^\[sha256 ([0-9a-f]{64})\]')
# Bulk read report blocks: "===== <path> =====" followed by the read_file
# body whose first line is the sha256 header.
_BULK_READ_BLOCK_RE = re.compile(
    r'^===== (.+?) =====\r?\n\[sha256 ([0-9a-f]{64})\]', re.MULTILINE
)


def _observed_map(session: 'WorkbenchSession') -> dict[str, str]:
    m = getattr(session, _ATTR, None)
    if not isinstance(m, dict):
        m = {}
        setattr(session, _ATTR, m)
    return m


def _written_map(session: 'WorkbenchSession') -> dict[str, str]:
    m = getattr(session, _WRITTEN_ATTR, None)
    if not isinstance(m, dict):
        m = {}
        setattr(session, _WRITTEN_ATTR, m)
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


def _input_keys(
    session: 'WorkbenchSession', tool_name: str, tool_input: dict[str, object]
) -> list[str]:
    """Every absolute file key the gated call targets (empty entries dropped)."""
    if tool_name == BULK_TOOL:
        op = as_str(tool_input.get('operation'), '').strip().lower().replace('-', '_')
        if op != 'write_files':
            return []
        entries: list[object] = []
        for field in ('files', 'items'):
            raw = tool_input.get(field)
            if isinstance(raw, list):
                entries.extend(raw)
    elif tool_name == 'write_files':
        raw = tool_input.get('files')
        entries = list(raw) if isinstance(raw, list) else []
    else:
        key = _key(session, as_str(tool_input.get('path'), ''))
        return [key] if key else []
    keys: list[str] = []
    for entry in entries:
        path = ''
        if isinstance(entry, dict):
            path = as_str(entry.get('path') or entry.get('filePath') or entry.get('file'), '')
        key = _key(session, path)
        if key and key not in keys:
            keys.append(key)
    return keys


def _refusal(names: list[str], code: str, unseen: bool) -> str:
    shown = ', '.join(names[:3]) + (f' … +{len(names) - 3} more' if len(names) > 3 else '')
    if unseen:
        return (
            f'Error: {code} {shown} — File has not been read yet. '
            'Read it first before writing to it: call read_file on the path, '
            'then retry the edit (copy the anchor text from that output).'
        )
    verb = 'have' if len(names) > 1 else 'has'
    obj = 'them' if len(names) > 1 else 'it'
    return (
        f'Error: {code} {shown} {verb} {STALE_WRITE_HEADLINE}. Read {obj} '
        f'again before attempting to write {obj}: call read_file on the '
        'path, then retry the edit.'
    )


def check_read_before_edit(
    session: 'WorkbenchSession', tool_name: str, tool_input: dict[str, object]
) -> str | None:
    """Pre-dispatch gate: error text when the edit must be refused, else None.

    Creating a new file is always allowed; editing an unseen or stale file
    fails fast with a distinct code + remedy so the model can self-correct.
    A batch write is refused whole when any target is unseen or stale.

    Chained multi-edit: when the file changed ONLY because of August's own
    previous write this session, and the model still passes the hash from
    its original read (or no hash at all), the edit is legitimate follow-up
    work — the stale ``fileHash`` in ``tool_input`` is normalized to the
    current bytes so the tool's internal anchor check passes too.
    """
    if tool_name not in GATED_EDIT_TOOLS and tool_name != BULK_TOOL:
        return None
    keys = _input_keys(session, tool_name, tool_input)
    if not keys:
        return None
    observed_map = _observed_map(session)
    written_map = _written_map(session)
    unseen: list[str] = []
    stale: list[str] = []
    for key in keys:
        target = Path(key)
        if not target.exists():
            continue  # creation — nothing to observe yet
        observed = observed_map.get(key)
        if observed is None:
            unseen.append(target.name)
            continue
        current = _file_version(target)
        if current is None or current == observed:
            continue
        provided = as_str(tool_input.get('fileHash'), '')
        if written_map.get(key) == current and (not provided or provided == observed):
            if provided:
                tool_input['fileHash'] = current
            continue
        stale.append(target.name)
    if unseen:
        return _refusal(unseen, UNSEEN_CODE, unseen=True)
    if stale:
        return _refusal(stale, STALE_CODE, unseen=False)
    return None


def observe_from_read_result(
    session: 'WorkbenchSession', tool_name: str, tool_input: dict[str, object], result: str
) -> None:
    """Record the versions a successful read showed the model."""
    if not isinstance(result, str):
        return
    if tool_name == 'read_file':
        m = _SHA_HEADER_RE.match(result)
        if not m:
            return  # error result or header drift — not an observation
        key = _key(session, as_str(tool_input.get('path'), ''))
        if key:
            _observed_map(session)[key] = m.group(1)
            # A fresh read re-anchors: prior August-write tracking is moot.
            _written_map(session).pop(key, None)
        return
    if tool_name == 'read_files' or tool_name == BULK_TOOL:
        # Bulk read report: observe every per-file block that carries a
        # sha256 header (failed reads appear in the error list, not as
        # blocks, so they are never observed).
        observed = _observed_map(session)
        written = _written_map(session)
        for m in _BULK_READ_BLOCK_RE.finditer(result):
            key = _key(session, m.group(1))
            if key:
                observed[key] = m.group(2)
                written.pop(key, None)


def observe_after_mutation(
    session: 'WorkbenchSession', tool_name: str, tool_input: dict[str, object]
) -> None:
    """After a successful mutation, record the bytes August just wrote.

    The observation from the model's read STAYS — that is what lets the
    model chain several edits to the same file in one turn: the gate sees
    ``current == written``, recognizes the only change was its own, and
    normalizes the next call's stale hash instead of refusing it. A foreign
    change (user edit, formatter) matches neither map and still fails as
    stale.
    """
    if tool_name not in GATED_EDIT_TOOLS and tool_name != BULK_TOOL:
        return
    written = _written_map(session)
    for key in _input_keys(session, tool_name, tool_input):
        target = Path(key)
        if target.exists():
            version = _file_version(target)
            if version is not None:
                written[key] = version
