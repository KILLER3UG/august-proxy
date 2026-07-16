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
