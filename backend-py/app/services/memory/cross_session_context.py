"""User-global active_projects + current_context writers for cross-session recall.

Sessions stay isolated for messages; these KV keys bridge Blender-style
facts so a new chat does not cold-start.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import cast

from app.json_narrowing import as_dict, as_list, as_str
from app.services.memory_store import get_memory, save_memory
from app.type_aliases import JsonValue

MAX_ACTIVE_PROJECTS = 5


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def upsert_active_project(
    *,
    name: str = '',
    path: str = '',
    kind: str = '',
) -> list[dict[str, object]]:
    """Promote a workspace/project into ``active_projects`` (most-recent first)."""
    path = (path or '').strip()
    name = (name or '').strip() or (Path(path).name if path else '')
    if not name and not path:
        return _read_projects()

    projects = _read_projects()
    key = path.lower() if path else name.lower()
    rest = [
        p
        for p in projects
        if (as_str(p.get('path')).lower() if as_str(p.get('path')) else as_str(p.get('name')).lower())
        != key
    ]
    entry: dict[str, object] = {
        'name': name or path,
        'path': path or None,
        'kind': kind or None,
        'lastActiveAt': _now(),
    }
    merged = [entry, *rest][:MAX_ACTIVE_PROJECTS]
    save_memory('active_projects', cast(JsonValue, merged))
    return merged


def refresh_current_context(text: str) -> str:
    """Replace ``current_context`` with a short “what the user is doing now” blurb."""
    cleaned = ' '.join((text or '').split()).strip()
    if not cleaned:
        return as_str(get_memory('current_context'))
    snippet = cleaned[:400]
    save_memory('current_context', snippet)
    return snippet


def sync_from_turn(
    *,
    workspace_path: str = '',
    last_user_text: str = '',
    session_title: str = '',
) -> None:
    """Post-turn write path: project + context from workspace and last user msg."""
    path = (workspace_path or '').strip()
    if path:
        upsert_active_project(path=path, kind='workspace')
    elif session_title and not session_title.startswith('Automation:'):
        # Soft signal when no workspace — do not invent a project from titles alone.
        pass

    if last_user_text.strip():
        # Prefer workspace-aware context sentence.
        if path:
            project = Path(path).name
            refresh_current_context(
                f'Working on {project}: {last_user_text.strip()[:280]}'
            )
        else:
            refresh_current_context(last_user_text.strip()[:400])


def _read_projects() -> list[dict[str, object]]:
    raw = get_memory('active_projects')
    out: list[dict[str, object]] = []
    for item in as_list(raw):
        d = as_dict(item)
        if d:
            out.append(d)
    return out


def glance() -> dict[str, object]:
    """Compact payload for Brain UI."""
    return {
        'activeProjects': _read_projects()[:MAX_ACTIVE_PROJECTS],
        'currentContext': get_memory('current_context') or '',
    }
