"""User-extensible hooks (JSON config -> shell command -> HookResult).

Covers: exit-code semantics (0 allow / 2 deny / other non-blocking), the
JSON stdout verdict (allow/deny/modify), matcher filtering, workspace
scoping (a ws hook must not gate other workspaces), mtime reload with
deleted-entry cleanup, and the /api/hooks listing.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest
from app.lib.paths import dataDir
from app.services.hooks import user_hooks
from app.services.hooks.registry import registry
from app.services.hooks.types import HookContext, HookEvent

_ALLOW = "import sys; sys.stdin.read(); sys.exit(0)"
_DENY2 = "import sys; sys.stdin.read(); sys.stderr.write('not on the allowlist'); sys.exit(2)"
_MODIFY = (
    "import sys, json; sys.stdin.read(); "
    "print(json.dumps({'action':'modify','args':{'path':'sanitized.txt'},'message':'fixed'}))"
)
_BAD_OTHER = "import sys; sys.stdin.read(); sys.stderr.write('crashed'); sys.exit(3)"


def _cmd(script: str) -> str:
    return f'"{sys.executable}" -c "{script}"'


@pytest.fixture()
def _cfg(tmp_path, monkeypatch):
    """Point dataDir at tmp_path and run against an EMPTY registry.

    The full suite boots the app lifespan in some module, which registers
    the built-in guards (blast_radius matches '*') on the global singleton —
    asserting exact result lists would then depend on test order. Snapshot,
    clear, and restore: hermetic in isolation AND in the full run.
    """
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path / 'data'))
    user_hooks.reset_for_tests()
    saved = list(registry._hooks)  # noqa: SLF001 — test isolation, restored below
    registry._hooks.clear()  # noqa: SLF001
    yield tmp_path
    for h in list(registry._hooks):
        registry.unregister(h.name)
    registry._hooks.extend(saved)  # noqa: SLF001
    user_hooks.reset_for_tests()


def _write(path: Path, hooks: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'hooks': hooks}), 'utf-8')


async def _emit(tool='write_file', workspace=None, event=HookEvent.PRE_TOOL_USE):
    ctx = HookContext(event=event, session_id='s1', tool_name=tool,
                      tool_args={'path': 'a.txt'}, workspace_path=workspace)
    return await registry.emit(event, ctx)


@pytest.mark.asyncio
async def test_deny_via_exit_two(_cfg):
    _write(dataDir() / 'hooks.json', [
        {'name': 'gate', 'event': 'pre_tool_use', 'matcher': 'write_file',
         'command': _cmd(_DENY2)},
    ])
    assert user_hooks.ensure_hooks_loaded() == 1
    results = await _emit()
    assert len(results) == 1 and results[0].action == 'deny'
    assert 'not on the allowlist' in (results[0].message or '')


@pytest.mark.asyncio
async def test_allow_via_exit_zero(_cfg):
    _write(dataDir() / 'hooks.json', [
        {'name': 'ok', 'event': 'pre_tool_use', 'matcher': '*', 'command': _cmd(_ALLOW)},
    ])
    user_hooks.ensure_hooks_loaded()
    results = await _emit(tool='read_file')
    assert [r.action for r in results] == ['allow']


@pytest.mark.asyncio
async def test_json_modify_verdict(_cfg):
    _write(dataDir() / 'hooks.json', [
        {'name': 'fix', 'event': 'pre_tool_use', 'matcher': 'write_*',
         'command': _cmd(_MODIFY)},
    ])
    user_hooks.ensure_hooks_loaded()
    results = await _emit(tool='write_file')
    assert results[0].action == 'modify'
    assert results[0].modified_args == {'path': 'sanitized.txt'}


@pytest.mark.asyncio
async def test_other_exit_is_non_blocking(_cfg):
    _write(dataDir() / 'hooks.json', [
        {'name': 'crashy', 'event': 'pre_tool_use', 'matcher': '*', 'command': _cmd(_BAD_OTHER)},
    ])
    user_hooks.ensure_hooks_loaded()
    results = await _emit()
    assert [r.action for r in results] == ['allow']


@pytest.mark.asyncio
async def test_matcher_miss_runs_nothing(_cfg):
    _write(dataDir() / 'hooks.json', [
        {'name': 'w-only', 'event': 'pre_tool_use', 'matcher': 'write_file',
         'command': _cmd(_DENY2)},
    ])
    user_hooks.ensure_hooks_loaded()
    assert await _emit(tool='run_command') == []


@pytest.mark.asyncio
async def test_workspace_hook_scoped_to_its_workspace(_cfg, tmp_path):
    ws = tmp_path / 'proj'
    (ws / '.aug').mkdir(parents=True)
    _write(ws / '.aug' / 'hooks.json', [
        {'name': 'wsdeny', 'event': 'pre_tool_use', 'matcher': '*', 'command': _cmd(_DENY2)},
    ])
    assert user_hooks.ensure_hooks_loaded(str(ws)) == 1
    # Other workspace: passthrough.
    assert all(r.action == 'allow' for r in await _emit(workspace=str(tmp_path / 'other')))
    # Own workspace: fires.
    assert any(r.action == 'deny' for r in await _emit(workspace=str(ws)))


@pytest.mark.asyncio
async def test_reload_picks_up_edits_and_removals(_cfg, tmp_path):
    cfgp = dataDir() / 'hooks.json'
    _write(cfgp, [
        {'name': 'a', 'event': 'pre_tool_use', 'matcher': '*', 'command': _cmd(_ALLOW)},
        {'name': 'b', 'event': 'pre_tool_use', 'matcher': '*', 'command': _cmd(_ALLOW)},
    ])
    assert user_hooks.ensure_hooks_loaded() == 2
    assert user_hooks.ensure_hooks_loaded() == 0  # mtime unchanged: no work
    # Edit drops 'b'.
    os.utime(cfgp, ns=(cfgp.stat().st_atime_ns, cfgp.stat().st_mtime_ns + 10**9))
    _write(cfgp, [
        {'name': 'a', 'event': 'pre_tool_use', 'matcher': '*', 'command': _cmd(_ALLOW)},
    ])
    os.utime(cfgp, ns=(cfgp.stat().st_atime_ns, cfgp.stat().st_mtime_ns + 2 * 10**9))
    user_hooks.ensure_hooks_loaded()
    names = {h.name for h in registry._hooks}  # noqa: SLF001
    assert any(n.endswith(':a') for n in names)
    assert not any(n.endswith(':b') for n in names), 'removed entry must be unregistered'


def test_unknown_event_skipped(_cfg):
    _write(dataDir() / 'hooks.json', [
        {'name': 'x', 'event': 'tool_exploded', 'matcher': '*', 'command': _cmd(_ALLOW)},
    ])
    assert user_hooks.ensure_hooks_loaded() == 0


@pytest.mark.asyncio
async def test_api_lists_hooks(isolatedData):
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        r = await ac.get('/api/hooks')
        assert r.status_code == 200
        body = r.json()
        assert 'hooks' in body and 'userHooks' in body
