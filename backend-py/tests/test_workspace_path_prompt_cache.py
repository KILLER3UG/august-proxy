"""Regression: changing a session's workspace path must invalidate the cached
Tier-1/Tier-2 system prompt.

The system prompt bakes the workspace `Path:` line (plus the VCS branch and
AUG.md derived from it) into a per-session-id cache with a 5-minute TTL, and a
cache hit skips rebuilding Tier 2 entirely. The only post-creation writer of
``workspacePath`` is ``_apply_sandbox_body``; if it does not drop the cache, a
session switch leaves the model "thinking" it is in the previous folder while
the file/shell tools already execute in the new one — the cross-session path
leak reported on switch.
"""

from __future__ import annotations

import asyncio

import pytest
from app.routers.workbench import _apply_sandbox_body
from app.services.workbench import sessions as sess
from app.services.workbench.prompt_cache import getCache
from app.services.workbench.sessions import (
    create_workbench_session,
    get_workbench_session,
)


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.config import settings
    from app.lib import paths

    monkeypatch.setattr(paths, 'dataDir', lambda: tmp_path)
    settings.dataDir = tmp_path
    sess._sessions.clear()
    getCache().clear()
    yield
    sess._sessions.clear()
    getCache().clear()


def test_workspace_path_change_invalidates_prompt_cache():
    s = create_workbench_session(provider='test', guardMode='full')
    s.workspacePath = 'C:/projA'
    getCache().set(s.id, 'STALE_PROMPT_WITH_PATH_A')
    assert getCache().get(s.id) == 'STALE_PROMPT_WITH_PATH_A'

    asyncio.run(_apply_sandbox_body(s.id, {'workspacePath': 'C:/projB'}))

    # Cache dropped so the next turn rebuilds Tier 2 against projB.
    assert getCache().get(s.id) is None
    assert get_workbench_session(s.id).workspacePath == 'C:/projB'


def test_workspace_path_set_from_empty_invalidates_prompt_cache():
    s = create_workbench_session(provider='test', guardMode='full')
    s.workspacePath = ''
    getCache().set(s.id, 'STALE_PROMPT_NO_PATH')

    asyncio.run(_apply_sandbox_body(s.id, {'workspacePath': 'C:/projB'}))

    assert getCache().get(s.id) is None


def test_workspace_path_unchanged_keeps_prompt_cache():
    s = create_workbench_session(provider='test', guardMode='full')
    s.workspacePath = 'C:/projA'
    getCache().set(s.id, 'GOOD_PROMPT')

    # Touching only the sandbox mode (no path change) must not evict.
    asyncio.run(_apply_sandbox_body(s.id, {'sandboxMode': 'workspace-write'}))

    assert getCache().get(s.id) == 'GOOD_PROMPT'
