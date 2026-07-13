"""
AUG artifact service — persist the model's plans and todo lists to the
workspace-local ``.aug/`` directory so they survive inspection and can be
cleaned up.

Layout (workspace-relative, mirroring AUG.md scope):
    .aug/plans/<slug>/plan.json      → { sessionId, title, slug, createdAt, updatedAt, status, plan }
    .aug/todoList/<slug>/todos.json  → { sessionId, title, slug, createdAt, updatedAt, status, todos }

Lifecycle: artifacts are written when the model calls ``submit_plan`` /
``submit_todos`` and removed automatically when the owning session is
reset, rejected, or deleted (see ``deleteForSession``). A Settings ▸ Plans
section lists survivors (e.g. artifacts left behind by an error) so the
user can delete them manually.

The leading-dot ``.aug`` form from the original spec is normalized for both
kinds so the directory stays hidden and consistent.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from app.jsonUtils import write_json_atomic

_PLANS_DIR = 'plans'
_TODOS_DIR = 'todoList'
_MAX_SLUG = 50


def _augDir(workspacePath: str | None) -> Path:
    """Resolve the ``.aug`` directory for a workspace (fallback: project root)."""
    if workspacePath:
        ws = Path(workspacePath)
        if ws.is_dir():
            return ws / '.aug'
    try:
        from app.config import settings

        return Path(settings.projectRoot) / '.aug'
    except Exception:
        return Path.cwd() / '.aug'


def slugify(title: str) -> str:
    """Convert a title to a filesystem-safe slug (≤ ``_MAX_SLUG`` chars)."""
    s = (title or '').lower().strip()
    s = re.sub(r'[^a-z0-9]+', '-', s)
    s = re.sub(r'-+', '-', s).strip('-')
    if not s:
        s = 'untitled'
    return s[:_MAX_SLUG]


def _sessionSuffix(sessionId: str) -> str:
    """Short, human-readable session id for slug disambiguation.

    Uses the final ``_``-separated segment (e.g. ``wb_session123`` → ``session123``)
    so artifacts are easy to recognize, falling back to the tail of the id.
    """
    if not sessionId:
        return 'unknown'
    seg = sessionId.split('_')[-1]
    return seg or sessionId[-8:]


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _titleFromPlan(plan: dict[str, object]) -> str:
    """Best-effort title extraction from a plan dict."""
    if isinstance(plan, dict):
        for key in ('summary', 'title'):
            val = plan.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        body = plan.get('plan') or plan.get('markdown') or ''
        if isinstance(body, str):
            for line in body.split('\n'):
                line = line.strip().lstrip('#').strip()
                if line:
                    return line
    return 'plan'


def savePlan(
    workspacePath: str | None, sessionId: str, plan: dict[str, object], *, status: str = 'pending'
) -> dict[str, object]:
    """Persist a plan to ``.aug/plans/<slug>/plan.json``."""
    base = _augDir(workspacePath)
    title = _titleFromPlan(plan)
    slug = slugify(title) + '-' + _sessionSuffix(sessionId)
    dirPath = base / _PLANS_DIR / slug
    dirPath.mkdir(parents=True, exist_ok=True)
    meta: dict[str, object] = {
        'sessionId': sessionId,
        'title': title,
        'slug': slug,
        'createdAt': _now(),
        'updatedAt': _now(),
        'status': status,
        'plan': plan,
    }
    write_json_atomic(dirPath / 'plan.json', meta, indent=2)
    meta['path'] = str(dirPath / 'plan.json')
    return meta


def saveTodos(
    workspacePath: str | None,
    sessionId: str,
    todos: list[dict[str, object]],
    *,
    title: str = '',
    status: str = 'active',
) -> dict[str, object]:
    """Persist a todo list to ``.aug/todoList/<slug>/todos.json``."""
    base = _augDir(workspacePath)
    effectiveTitle = title or 'todo list'
    slug = slugify(effectiveTitle) + '-' + _sessionSuffix(sessionId)
    dirPath = base / _TODOS_DIR / slug
    dirPath.mkdir(parents=True, exist_ok=True)
    meta: dict[str, object] = {
        'sessionId': sessionId,
        'title': effectiveTitle,
        'slug': slug,
        'createdAt': _now(),
        'updatedAt': _now(),
        'status': status,
        'todos': todos,
    }
    write_json_atomic(dirPath / 'todos.json', meta, indent=2)
    meta['path'] = str(dirPath / 'todos.json')
    return meta


def deleteForSession(workspacePath: str | None, sessionId: str) -> int:
    """Delete all ``.aug`` artifacts owned by a session. Returns count removed."""
    base = _augDir(workspacePath)
    removed = 0
    for kind in (_PLANS_DIR, _TODOS_DIR):
        root = base / kind
        if not root.is_dir():
            continue
        for entry in root.iterdir():
            if not entry.is_dir():
                continue
            metaFile = entry / ('plan.json' if kind == _PLANS_DIR else 'todos.json')
            if not metaFile.exists():
                continue
            try:
                meta = json.loads(metaFile.read_text('utf-8'))
            except Exception:
                continue
            if meta.get('sessionId') == sessionId:
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
    return removed


def listArtifacts(workspacePath: str | None) -> list[dict[str, object]]:
    """List all ``.aug`` plan/todo artifacts (survivors for manual cleanup)."""
    base = _augDir(workspacePath)
    artifacts: list[dict[str, object]] = []
    for kind, file in ((_PLANS_DIR, 'plan.json'), (_TODOS_DIR, 'todos.json')):
        root = base / kind
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            if not entry.is_dir():
                continue
            metaFile = entry / file
            if not metaFile.exists():
                continue
            try:
                meta = json.loads(metaFile.read_text('utf-8'))
            except Exception:
                continue
            artifacts.append(
                {
                    'kind': kind,
                    'slug': meta.get('slug', entry.name),
                    'title': meta.get('title', entry.name),
                    'status': meta.get('status', 'unknown'),
                    'createdAt': meta.get('createdAt', ''),
                    'updatedAt': meta.get('updatedAt', ''),
                    'sessionId': meta.get('sessionId', ''),
                    'path': str(metaFile),
                }
            )
    return artifacts


def deleteArtifact(workspacePath: str | None, kind: str, slug: str) -> dict[str, object]:
    """Manually delete a single artifact by kind + slug."""
    base = _augDir(workspacePath)
    if kind not in (_PLANS_DIR, _TODOS_DIR):
        return {'removed': False, 'error': f'Unknown artifact kind: {kind}'}
    file = 'plan.json' if kind == _PLANS_DIR else 'todos.json'
    entry = base / kind / slug
    target = entry / file
    removed = False
    if target.exists():
        shutil.rmtree(entry, ignore_errors=True)
        removed = True
    return {'kind': kind, 'slug': slug, 'removed': removed}


def updatePlanStatus(workspacePath: str | None, sessionId: str, status: str) -> None:
    """Update the status field on a session's persisted plan (if any)."""
    base = _augDir(workspacePath)
    root = base / _PLANS_DIR
    if not root.is_dir():
        return
    for entry in root.iterdir():
        metaFile = entry / 'plan.json'
        if not metaFile.exists():
            continue
        try:
            meta = json.loads(metaFile.read_text('utf-8'))
        except Exception:
            continue
        if meta.get('sessionId') == sessionId:
            meta['status'] = status
            meta['updatedAt'] = _now()
            write_json_atomic(metaFile, meta, indent=2)
