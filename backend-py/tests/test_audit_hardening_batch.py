"""Audit hardening batch 2026-09-09 — tests for the review-driven fixes:

- MCP launch validation (shell / catastrophic args refused) + response redaction
- read-only sandbox pre-check now uses the central is_mutating classifier
  (edit_lines + bulk writes were missing from the old hand list; shell stays
  a documented passthrough)
- recurring sub-agent tasks are registered at creation, so session teardown
  cancels them even before the task self-registers
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from app.services.tools import mcp_client
from app.services.workbench.subagent import (
    cancel_subagent_tasks_for_session,
    register_recurring_task,
)
from app.services.workbench.workbench import _checkToolGuard

# ── MCP launch validation ──────────────────────────────────────────────────


class TestValidateStdioLaunch:
    def test_shell_commands_refused(self) -> None:
        for cmd in ('cmd', 'cmd.exe', 'powershell', 'bash', '/bin/sh', 'C:\\Windows\\System32\\cmd.exe'):
            refusal = mcp_client.validateStdioLaunch(cmd, ['-c', 'anything'])
            assert refusal is not None, cmd

    def test_catastrophic_args_refused(self) -> None:
        assert mcp_client.validateStdioLaunch('rm', ['-rf', '/'])
        assert mcp_client.validateStdioLaunch('dd', ['if=/dev/zero', 'of=/dev/sda'])
        assert mcp_client.validateStdioLaunch('mkfs.ext4', ['/dev/sda1'])

    def test_real_launchers_allowed(self) -> None:
        assert mcp_client.validateStdioLaunch('npx', ['-y', '@modelcontextprotocol/server-filesystem', '.']) is None
        assert mcp_client.validateStdioLaunch('uvx', ['workspace-mcp', '--tool-tier', 'core']) is None
        assert mcp_client.validateStdioLaunch('python', ['-m', 'mcp_server']) is None

    def test_url_only_row_not_scanned(self) -> None:
        # A URL stored under the legacy stdio transport is not a local launch.
        assert mcp_client.validateStdioLaunch('https://mcp.example.com/bash', []) is None

    def test_register_server_raises_for_shell(self) -> None:
        with pytest.raises(ValueError, match='shell'):
            mcp_client.registerServer('evil', 'cmd', args=['/c', 'del'])


class TestRedactedServerRow:
    def test_values_masked_keys_kept(self) -> None:
        row = mcp_client.redactedServerRow({
            'id': 'mcp_x',
            'name': 'GitHub',
            'env': {'GITHUB_TOKEN': 'ghp_supersecret123456'},
            'headers': {'Authorization': 'Bearer sk-abcdefghijklmnop'},
        })
        assert 'ghp_supersecret123456' not in str(row)
        assert 'sk-abcdefghijklmnop' not in str(row)
        assert 'GITHUB_TOKEN' in row['env']  # type: ignore[operator]
        assert 'Authorization' in row['headers']  # type: ignore[operator]
        assert '•' in str(row['env'])  # type: ignore[arg-type]

    def test_original_row_untouched(self) -> None:
        src = {'env': {'K': 'value123'}}
        mcp_client.redactedServerRow(src)
        assert src == {'env': {'K': 'value123'}}


# ── Read-only sandbox pre-check via the central classifier ────────────────


def _ro_session() -> SimpleNamespace:
    return SimpleNamespace(guardMode='full', sandboxMode='read-only', id='s1')


class TestReadOnlyPrecheckClassifier:
    def test_edit_lines_now_blocked(self) -> None:
        # The old 11-name list missed edit_lines entirely.
        assert _checkToolGuard(_ro_session(), 'edit_lines', {'path': 'a.py'})

    def test_bulk_write_blocked_bulk_read_allowed(self) -> None:
        assert _checkToolGuard(_ro_session(), 'bulk', {'operation': 'write_files'})
        assert _checkToolGuard(_ro_session(), 'bulk', {'operation': 'read_files'}) is None

    def test_reads_allowed(self) -> None:
        for tool in ('read_file', 'search_files', 'list_directory', 'list_facts'):
            assert _checkToolGuard(_ro_session(), tool, {}) is None, tool

    def test_shell_passthrough_kept(self) -> None:
        # run_command carries reads (type/cat/grep); its mutating forms are
        # denied by the sandbox backend, not this pre-check (documented).
        assert _checkToolGuard(_ro_session(), 'run_command', {'command': 'type readme.txt'}) is None

    def test_write_file_still_blocked(self) -> None:
        assert _checkToolGuard(_ro_session(), 'write_file', {'path': 'a'})

    def test_workspace_write_mode_unaffected(self) -> None:
        s = SimpleNamespace(guardMode='full', sandboxMode='workspace-write', id='s1')
        assert _checkToolGuard(s, 'edit_lines', {'path': 'a.py'}) is None


# ── Recurring sub-agent registration at creation ──────────────────────────


@pytest.mark.asyncio
async def test_recurring_task_cancellable_before_self_registration() -> None:
    """The handle is tracked at create_task time, so teardown that lands
    before the coroutine's first await still cancels it (the audit's race)."""
    started = asyncio.Event()

    async def _never_returns() -> None:
        started.set()
        await asyncio.sleep(3600)

    task = asyncio.create_task(_never_returns())
    register_recurring_task('sess-race', task)
    await asyncio.wait_for(started.wait(), timeout=2)
    # The coroutine is running but executeSubAgent's self-registration never
    # happened (it isn't even on that path) — the creation-time registry must
    # still see it.
    assert cancel_subagent_tasks_for_session('sess-race') == 1
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_recurring_task_registry_self_cleans_on_completion() -> None:
    async def _quick() -> None:
        return None

    task = asyncio.create_task(_quick())
    register_recurring_task('sess-clean', task)
    await task
    await asyncio.sleep(0)  # let the done-callback run
    assert cancel_subagent_tasks_for_session('sess-clean') == 0


# ── Daemon blocklist is now LIVE (context set by the daemon loop) ─────────


@pytest.mark.asyncio
async def test_daemon_context_blocks_mutating_run_command() -> None:
    """Restored + wired: with the daemon context set (as DaemonManager._runLoop
    now does), a mutating run_command is refused at dispatch — previously this
    gate was dead code because nothing ever set the contextvar."""
    from app.services import tool_registry
    from app.services.tool_registrations import register_all

    register_all()  # run_command must be registered so dispatch reaches the gate
    tool_registry.setDaemonContext()
    try:
        assert tool_registry.isDaemonContext() is True
        assert tool_registry.isCommandBlocked('rm -rf /tmp/x') is True
        assert tool_registry.isCommandBlocked('ls -la') is False
        # dispatch() consults the gate before the handler runs.
        result = await tool_registry.dispatch('run_command', {'command': 'rm -rf /'})
        assert '[BLOCKED]' in result and 'daemon context' in result
    finally:
        tool_registry.clearDaemonContext()
    assert tool_registry.isDaemonContext() is False


@pytest.mark.asyncio
async def test_non_daemon_run_command_not_blocked_by_daemon_gate() -> None:
    """Outside the daemon context the gate must not fire — the handler is
    reached. The handler is stubbed so no real subprocess spawns (a leaked
    child transport races the event-loop teardown on Python 3.14)."""
    from app.services import tool_registry
    from app.services.tool_registrations import register_all

    register_all()
    assert tool_registry.isDaemonContext() is False

    reached = {'hit': False}

    async def _stub(**_kw: object) -> str:
        reached['hit'] = True
        return 'handler-ran'

    original = tool_registry._registry['run_command']['handler']  # noqa: SLF001
    tool_registry._registry['run_command']['handler'] = _stub  # noqa: SLF001
    try:
        result = await tool_registry.dispatch('run_command', {'command': 'rm -rf /'})
    finally:
        tool_registry._registry['run_command']['handler'] = original  # noqa: SLF001
    # No daemon context → gate does not short-circuit → handler ran, and the
    # daemon-specific [BLOCKED] reason is absent.
    assert reached['hit'] is True
    assert result == 'handler-ran'
    assert 'daemon context' not in str(result)


# ── ZCode-style "modified since read" wording ─────────────────────────────


def test_stale_gate_uses_modified_since_read_wording(tmp_path) -> None:
    from app.services.workbench import read_before_edit as rbe

    f = tmp_path / 'a.txt'
    f.write_text('v1')
    s = SimpleNamespace(workspacePath=str(tmp_path))
    rbe.observe_from_read_result(
        s, 'read_file', {'path': 'a.txt'},
        f'[sha256 {__import__("hashlib").sha256(f.read_bytes()).hexdigest()}]\nv1',
    )
    f.write_text('v2 external change')
    err = rbe.check_read_before_edit(s, 'edit_lines', {'path': 'a.txt'})
    assert err is not None
    assert 'modified since read' in err
    assert 'Read it again before attempting to write it' in err
