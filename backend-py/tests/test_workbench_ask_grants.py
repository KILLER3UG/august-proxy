"""Ask-mode grants + pending mutation flow."""

from __future__ import annotations

import pytest
from app.services.workbench import workbench as wb
from app.services.workbench.sessions import create_workbench_session


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.config import settings
    from app.lib import paths
    from app.services.workbench import sessions as sess

    monkeypatch.setattr(paths, 'dataDir', lambda: tmp_path)
    settings.dataDir = tmp_path
    sess._sessions.clear()
    yield
    sess._sessions.clear()


def test_ask_mode_creates_pending_mutation():
    s = create_workbench_session(guardMode='ask')
    s.guardMode = 'ask'
    blocked = wb._checkToolGuard(s, 'write_file', {'path': '/tmp/a.txt', 'content': 'hello'})
    assert blocked is not None
    assert 'approval' in blocked.lower() or 'approved' in blocked.lower() or 'permission' in blocked.lower()
    assert len(s.pendingMutations) == 1
    pm = s.pendingMutations[0]
    assert pm['toolName'] == 'write_file'
    assert pm.get('token')
    assert s.status == 'awaiting_approval'


def test_session_grant_allows_retry():
    s = create_workbench_session(guardMode='ask')
    s.guardMode = 'ask'
    args = {'path': '/tmp/a.txt', 'content': 'x'}
    wb._checkToolGuard(s, 'write_file', args)
    token = s.pendingMutations[0]['token']
    result = wb.consumePendingMutation(token, reject=False, scope='session')
    assert result is not None
    assert result['status'] == 'approved'
    assert len(s.pendingMutations) == 0
    # Next call with same path should pass
    assert wb._checkToolGuard(s, 'write_file', args) is None


def test_reject_clears_pending():
    s = create_workbench_session(guardMode='ask')
    s.guardMode = 'ask'
    wb._checkToolGuard(s, 'run_command', {'command': 'rm -rf /'})
    token = s.pendingMutations[0]['token']
    result = wb.consumePendingMutation(token, reject=True)
    assert result is not None
    assert result['status'] == 'rejected'
    assert result.get('args', {}).get('command') == 'rm -rf /'
    assert s.status == 'idle'
    assert len(s.pendingMutations) == 0


def test_multi_pending_keeps_awaiting_after_one_approve():
    """Approving one of several mutations must not hide the rest of the stack."""
    s = create_workbench_session(guardMode='ask')
    s.guardMode = 'ask'
    wb._checkToolGuard(s, 'write_file', {'path': '/tmp/a.txt', 'content': 'a'})
    wb._checkToolGuard(s, 'write_file', {'path': '/tmp/b.txt', 'content': 'b'})
    wb._checkToolGuard(s, 'write_file', {'path': '/tmp/c.txt', 'content': 'c'})
    assert len(s.pendingMutations) == 3
    assert s.status == 'awaiting_approval'
    first = s.pendingMutations[0]['token']
    result = wb.consumePendingMutation(first, reject=False, scope='once')
    assert result is not None
    assert result['status'] == 'approved'
    assert result.get('remainingPending') == 2
    assert len(s.pendingMutations) == 2
    assert s.status == 'awaiting_approval'
    # Clear the rest
    while s.pendingMutations:
        tok = s.pendingMutations[0]['token']
        wb.consumePendingMutation(tok, reject=True)
    assert s.status == 'idle'


def test_submit_clarify_merges_stacked_questions():
    s = create_workbench_session()
    wb.submitClarify(s, {'question': 'First?', 'choices': ['A', 'B']})
    wb.submitClarify(s, {'question': 'Second?', 'choices': ['C']})
    qs = (s.clarify or {}).get('questions') or []
    assert len(qs) == 2
    assert qs[0]['question'] == 'First?'
    assert qs[1]['question'] == 'Second?'


def test_approve_returns_args_for_pre_apply():
    s = create_workbench_session(guardMode='ask')
    s.guardMode = 'ask'
    args = {'path': 'preapply.txt', 'content': 'accepted'}
    wb._checkToolGuard(s, 'write_file', args)
    token = s.pendingMutations[0]['token']
    result = wb.consumePendingMutation(token, reject=False, scope='once')
    assert result is not None
    assert result['status'] == 'approved'
    assert result['toolName'] == 'write_file'
    assert result['args']['path'] == 'preapply.txt'
    assert result['args']['content'] == 'accepted'
    assert 'preview' in result


@pytest.mark.asyncio
async def test_execute_approved_mutation_runs_tool(tmp_path, monkeypatch):
    s = create_workbench_session(guardMode='ask')
    s.workspacePath = str(tmp_path)
    target = tmp_path / 'accepted.txt'
    args = {'path': str(target), 'content': 'from-pre-apply'}

    async def _fake_exec(tool_name, tool_args, session):
        assert tool_name == 'write_file'
        target.write_text(str(tool_args.get('content') or ''), encoding='utf-8')
        return f'Wrote {tool_args.get("path")}'

    monkeypatch.setattr(wb, '_executeTool', _fake_exec)
    out = await wb.execute_approved_mutation(s, 'write_file', args)
    assert 'Wrote' in out
    assert target.read_text(encoding='utf-8') == 'from-pre-apply'
    assert s.mutationCount >= 1


def test_status_exposes_flat_pending_fields():
    s = create_workbench_session(guardMode='ask')
    s.guardMode = 'ask'
    wb._checkToolGuard(s, 'write_file', {'path': 'foo.py', 'content': 'print(1)'})
    status = wb.getWorkbenchSessionStatus(s.id)
    assert status is not None
    assert status['status'] == 'awaiting_approval'
    assert status['pendingToken']
    assert status['pendingTool'] == 'write_file'
    assert status['pendingArgs']['path'] == 'foo.py'
    assert status.get('pendingPreview')


@pytest.mark.asyncio
async def test_accept_continues_even_when_stream_still_active(monkeypatch):
    """Accept must start a continuation turn even if the original chat task
    is still registered in _activeStreams (ask-mode already returned [Blocked]).
    """
    import asyncio

    from app.routers import workbench as wr

    s = create_workbench_session(guardMode='ask')
    s.guardMode = 'ask'
    wb._checkToolGuard(s, 'write_file', {'path': 'a.txt', 'content': 'x'})
    token = s.pendingMutations[0]['token']

    async def _hang() -> None:
        await asyncio.Event().wait()

    stale = asyncio.create_task(_hang())
    wr._activeStreams[s.id] = stale
    stale_cancel = asyncio.Event()
    wr._cancelled[s.id] = stale_cancel

    continued_msgs: list[str] = []

    async def _fake_stream(**kwargs):
        continued_msgs.append(str(kwargs.get('message') or ''))

    async def _fake_exec(session, tool_name, args):
        return f'Wrote {args.get("path")}'

    monkeypatch.setattr(wb, 'sendWorkbenchMessageStream', _fake_stream)
    monkeypatch.setattr(wb, 'execute_approved_mutation', _fake_exec)

    class _Req:
        async def json(self):
            return {
                'token': token,
                'reject': False,
                'scope': 'once',
                'continue': True,
            }

    result = await wr.respondMutation(_Req())  # type: ignore[arg-type]
    assert result.get('continued') is True
    assert result.get('executed') is True
    assert result.get('sinceSeq') is not None
    assert stale_cancel.is_set()
    # Cancellation is cooperative; yield until the hang task observes CancelledError.
    for _ in range(50):
        if stale.cancelled() or stale.done():
            break
        await asyncio.sleep(0)
    assert stale.cancelled() or stale.done()

    # Let the continuation task run
    for _ in range(20):
        if continued_msgs:
            break
        await asyncio.sleep(0.01)
    assert continued_msgs, 'continuation turn never called sendWorkbenchMessageStream'
    assert 'accepted' in continued_msgs[0].lower()
    assert 'Tool result' in continued_msgs[0]

    cont = wr._activeStreams.get(s.id)
    if cont and not cont.done():
        cont.cancel()
        try:
            await cont
        except (asyncio.CancelledError, Exception):
            pass
    wr._activeStreams.pop(s.id, None)
    wr._cancelled.pop(s.id, None)
    if not stale.done():
        stale.cancel()
        try:
            await stale
        except (asyncio.CancelledError, Exception):
            pass


def test_full_access_never_pending_for_run_command():
    """Full Access must run terminal tools without ApprovalBanner tokens."""
    s = create_workbench_session(guardMode='full')
    s.guardMode = 'full'
    assert wb._checkToolGuard(s, 'run_command', {'command': 'pip install torch'}) is None
    assert s.pendingMutations == []
    assert s.status != 'awaiting_approval'


def test_edit_mode_still_pending_for_run_command():
    s = create_workbench_session(guardMode='edit')
    s.guardMode = 'edit'
    blocked = wb._checkToolGuard(s, 'run_command', {'command': 'npm install'})
    assert blocked is not None
    assert len(s.pendingMutations) == 1
    assert s.pendingMutations[0]['toolName'] == 'run_command'


def test_full_access_skips_sandbox_escape_banner():
    from app.services.tool_registrations.file_tools import _queue_sandbox_escape

    s = create_workbench_session(guardMode='full')
    s.guardMode = 'full'
    _queue_sandbox_escape(s, 'curl https://example.com', 'network disabled in sandbox')
    assert s.pendingMutations == []


def test_switching_to_full_clears_pending_mutations():
    """setGuardMode(full) must clear leftover ask/edit terminal prompts."""
    import asyncio
    from unittest.mock import AsyncMock, MagicMock

    from app.routers import workbench as wr

    s = create_workbench_session(guardMode='ask')
    s.guardMode = 'ask'
    wb._checkToolGuard(s, 'run_command', {'command': 'ls'})
    assert len(s.pendingMutations) == 1

    req = MagicMock()
    req.json = AsyncMock(return_value={'sessionId': s.id, 'guardMode': 'full'})

    out = asyncio.run(wr.setGuardMode(req))
    assert out.get('guardMode') == 'full'
    s2 = wb.getWorkbenchSession(s.id)
    assert s2 is not None
    assert s2.pendingMutations == []
    assert s2.status != 'awaiting_approval'
