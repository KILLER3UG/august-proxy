"""Filesystem checkpoints — snapshot/restore files before mutating tools.

Save points live under ``data/checkpoints/{sessionId}/{checkpointId}/``.
Each checkpoint stores a ``manifest.json`` and copies of file contents
(relative paths under the session workspace when possible).
"""

from __future__ import annotations

import json
import logging
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.json_narrowing import as_list, as_str

logger = logging.getLogger('workbench.checkpoints')

MAX_FILE_BYTES = 2 * 1024 * 1024  # 2 MiB per file
MAX_CHECKPOINTS_PER_SESSION = 20


def _data_root() -> Path:
    try:
        from app.lib.paths import dataDir

        return Path(dataDir())
    except Exception:
        from app.config import settings

        return Path(settings.dataDir)


def _session_dir(session_id: str) -> Path:
    return _data_root() / 'checkpoints' / session_id


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _paths_from_tool_args(tool_name: str, args: dict[str, Any] | None) -> list[str]:
    args = args or {}
    name = (tool_name or '').lower()
    paths: list[str] = []
    for key in ('path', 'file_path', 'filePath', 'file', 'target', 'destination', 'src', 'dest'):
        v = as_str(args.get(key))
        if v:
            paths.append(v)
    # apply_patch / multi-file style
    for key in ('paths', 'files'):
        raw = args.get(key)
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, str):
                    paths.append(item)
                elif isinstance(item, dict):
                    p = as_str(item.get('path'))
                    if p:
                        paths.append(p)
    if any(m in name for m in ('bash', 'shell', 'command', 'exec')):
        # Shell may touch anything — no path snapshot unless cwd file is known
        pass
    return paths


def _resolve_under_workspace(path_str: str, workspace: str) -> Path | None:
    try:
        p = Path(path_str)
        if not p.is_absolute() and workspace:
            p = Path(workspace) / path_str
        p = p.resolve()
        if workspace:
            ws = Path(workspace).resolve()
            try:
                p.relative_to(ws)
            except ValueError:
                # Allow absolute paths outside workspace only if they exist and are files
                if not p.is_file():
                    return None
        return p
    except OSError:
        return None


def create_checkpoint(
    session_id: str,
    *,
    workspace_path: str = '',
    paths: list[str] | None = None,
    tool_name: str = '',
    label: str = '',
    reason: str = 'mutation',
) -> dict[str, Any] | None:
    """Snapshot existing files that will be changed. Returns checkpoint meta or None."""
    if not session_id:
        return None
    resolved: list[Path] = []
    for raw in paths or []:
        rp = _resolve_under_workspace(raw, workspace_path)
        if rp is not None and rp.is_file():
            try:
                if rp.stat().st_size <= MAX_FILE_BYTES:
                    resolved.append(rp)
            except OSError:
                continue
    # Always create a checkpoint record even if no files existed yet (new file write)
    # so restore can delete newly created files tracked in manifest.
    ck_id = f'cp_{uuid.uuid4().hex[:12]}'
    base = _session_dir(session_id) / ck_id
    files_dir = base / 'files'
    try:
        files_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.exception('checkpoint mkdir failed')
        return None

    entries: list[dict[str, Any]] = []
    ws = Path(workspace_path).resolve() if workspace_path else None
    for src in resolved:
        try:
            rel = src.name
            if ws is not None:
                try:
                    rel = str(src.relative_to(ws)).replace('\\', '/')
                except ValueError:
                    rel = src.name
            # Flatten nested paths safely under files/
            dest = files_dir / rel.replace('..', '_')
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            entries.append(
                {
                    'path': str(src),
                    'rel': rel,
                    'existed': True,
                    'size': src.stat().st_size,
                }
            )
        except OSError:
            logger.debug('skip snapshot %s', src, exc_info=True)

    # Track intended paths that did not exist (for delete-on-restore of new files)
    for raw in paths or []:
        rp = _resolve_under_workspace(raw, workspace_path)
        if rp is None:
            continue
        if any(e['path'] == str(rp) for e in entries):
            continue
        rel = rp.name
        if ws is not None:
            try:
                rel = str(rp.relative_to(ws)).replace('\\', '/')
            except ValueError:
                pass
        entries.append({'path': str(rp), 'rel': rel, 'existed': False, 'size': 0})

    meta: dict[str, Any] = {
        'id': ck_id,
        'sessionId': session_id,
        'createdAt': _now(),
        'label': label or (f'Before {tool_name}' if tool_name else 'Save point'),
        'reason': reason,
        'toolName': tool_name,
        'workspacePath': workspace_path,
        'fileCount': len(entries),
        'files': entries,
    }
    try:
        (base / 'manifest.json').write_text(json.dumps(meta, indent=2), encoding='utf-8')
    except OSError:
        logger.exception('checkpoint manifest write failed')
        shutil.rmtree(base, ignore_errors=True)
        return None

    _prune_old(session_id)
    return meta


def create_checkpoint_for_tool(
    session_id: str,
    workspace_path: str,
    tool_name: str,
    args: dict[str, Any] | None,
) -> dict[str, Any] | None:
    paths = _paths_from_tool_args(tool_name, args)
    if not paths and not any(
        m in (tool_name or '').lower()
        for m in ('write', 'edit', 'delete', 'remove', 'patch', 'str_replace', 'create')
    ):
        return None
    return create_checkpoint(
        session_id,
        workspace_path=workspace_path,
        paths=paths,
        tool_name=tool_name,
        reason='before_mutation',
    )


def list_checkpoints(session_id: str) -> list[dict[str, Any]]:
    root = _session_dir(session_id)
    if not root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for child in sorted(root.iterdir(), reverse=True):
        man = child / 'manifest.json'
        if not man.is_file():
            continue
        try:
            data = json.loads(man.read_text(encoding='utf-8'))
            if isinstance(data, dict):
                # Drop full file content listing for list view size
                slim = {k: v for k, v in data.items() if k != 'files'}
                slim['fileCount'] = data.get('fileCount', len(as_list(data.get('files'))))
                out.append(slim)
        except (OSError, json.JSONDecodeError):
            continue
    return out


def get_checkpoint(session_id: str, checkpoint_id: str) -> dict[str, Any] | None:
    man = _session_dir(session_id) / checkpoint_id / 'manifest.json'
    if not man.is_file():
        return None
    try:
        data = json.loads(man.read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def restore_checkpoint(session_id: str, checkpoint_id: str) -> dict[str, Any]:
    """Restore files from a checkpoint. Deletes files that did not exist at snapshot time."""
    meta = get_checkpoint(session_id, checkpoint_id)
    if not meta:
        return {'ok': False, 'error': 'Checkpoint not found'}
    base = _session_dir(session_id) / checkpoint_id
    files_dir = base / 'files'
    restored = 0
    deleted = 0
    errors: list[str] = []
    for entry in as_list(meta.get('files')):
        if not isinstance(entry, dict):
            continue
        path_str = as_str(entry.get('path'))
        rel = as_str(entry.get('rel')) or Path(path_str).name
        existed = bool(entry.get('existed'))
        target = Path(path_str)
        try:
            if existed:
                src = files_dir / rel.replace('..', '_')
                if not src.is_file():
                    # try basename fallback
                    src = files_dir / Path(rel).name
                if not src.is_file():
                    errors.append(f'missing snapshot for {path_str}')
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, target)
                restored += 1
            else:
                if target.is_file():
                    target.unlink()
                    deleted += 1
        except OSError as exc:
            errors.append(f'{path_str}: {exc}')
    return {
        'ok': True,
        'checkpointId': checkpoint_id,
        'restored': restored,
        'deleted': deleted,
        'errors': errors,
        'label': meta.get('label'),
        'message': (
            f'Restored save point “{meta.get("label")}” '
            f'({restored} file(s) restored, {deleted} new file(s) removed).'
        ),
    }


def _prune_old(session_id: str) -> None:
    root = _session_dir(session_id)
    if not root.is_dir():
        return
    dirs = sorted(
        [d for d in root.iterdir() if d.is_dir() and (d / 'manifest.json').is_file()],
        key=lambda d: d.stat().st_mtime,
        reverse=True,
    )
    for old in dirs[MAX_CHECKPOINTS_PER_SESSION:]:
        shutil.rmtree(old, ignore_errors=True)


# camelCase aliases
createCheckpoint = create_checkpoint
createCheckpointForTool = create_checkpoint_for_tool
listCheckpoints = list_checkpoints
getCheckpoint = get_checkpoint
restoreCheckpoint = restore_checkpoint
