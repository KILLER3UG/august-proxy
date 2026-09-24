"""Code-mode trust boundary: the model may not grant itself raw Python.

Code mode executes model-authored Python locally (plus a ``call_tool`` bridge
into the full managed tool surface). The contract under test:

  * a model-initiated ``set_agent_mode('code')`` never switches silently — it
    queues the normal ApprovalBanner mutation, or is refused outright;
  * both the warm and the cold cell paths run the SAME parent gate first, so
    neither can be the way around plan / ask / edit / read-only;
  * the user picking Code mode in the composer (the REST endpoint) still works
    and cells then run under the session's normal guard/approval policy.
"""

from __future__ import annotations

import pytest
from app.services.tool_registrations.system_tools import _setAgentMode
from app.services.workbench import code_runner, kernel
from app.services.workbench import workbench as wb
from app.services.workbench.sessions import WorkbenchSession


def _session(**over: object) -> WorkbenchSession:
    s = WorkbenchSession(id='code-trust-1', guardMode='edit', sandboxMode='workspace-write')
    s.workspacePath = ''
    for key, val in over.items():
        setattr(s, key, val)
    return s


def _as_model(s: WorkbenchSession):
    """Bind the session to the tool-dispatch context the handler resolves."""
    from app.services.workbench.context import currentSessionId

    return currentSessionId.set(s.id)


# ── Mode escalation ───────────────────────────────────────────────────────


class TestModeEscalation:
    @pytest.mark.asyncio
    async def test_model_switch_to_code_asks_the_user_first(self):
        s = _session()
        wb._sessions[s.id] = s
        tok = _as_model(s)
        try:
            out = await _setAgentMode('code')
        finally:
            current_reset = tok
            from app.services.workbench.context import currentSessionId

            currentSessionId.reset(current_reset)

        assert s.agent_mode != 'code', 'model escalated itself into code mode'
        assert 'confirmation' in out.lower()
        assert len(s.pendingMutations) == 1
        pm = s.pendingMutations[0]
        assert pm['toolName'] == 'set_agent_mode'
        assert pm['args'] == {'mode': 'code'}
        assert pm['kind'] == 'code_mode'
        assert 'CODE MODE' in pm['preview']

    @pytest.mark.asyncio
    async def test_repeat_request_does_not_stack_prompts(self):
        s = _session()
        wb._sessions[s.id] = s
        tok = _as_model(s)
        try:
            await _setAgentMode('code')
            before = len(s.pendingMutations)
            out = await _setAgentMode('code')
        finally:
            from app.services.workbench.context import currentSessionId

            currentSessionId.reset(tok)

        assert len(s.pendingMutations) == before
        assert 'already waiting' in out.lower()

    def test_user_approved_switch_is_allowed_and_marked_trusted(self):
        s = _session()
        # What the ApprovalBanner accept path records before re-running the tool.
        wb.add_tool_grant(s, 'set_agent_mode', {'mode': 'code'}, scope='session')
        allowed, msg = code_runner.code_mode_switch_decision(s)
        assert allowed, msg
        assert code_runner.is_code_mode_trusted(s)

    def test_switching_away_revokes_trust(self):
        s = _session(agent_mode='code')
        code_runner.mark_code_mode_trusted(s)
        code_runner.clear_code_mode_trust(s)
        assert not code_runner.is_code_mode_trusted(s)


# ── Refusals ──────────────────────────────────────────────────────────────


class TestRefusals:
    def test_plan_mode_refuses_code_mode_without_prompting(self):
        s = _session(guardMode='plan', agent_mode='agent')
        allowed, msg = code_runner.code_mode_switch_decision(s)
        assert not allowed
        assert 'Plan mode' in msg
        assert s.pendingMutations == []

    def test_read_only_sandbox_refuses_code_mode_without_prompting(self):
        s = _session(guardMode='full', sandboxMode='read-only')
        allowed, msg = code_runner.code_mode_switch_decision(s)
        assert not allowed
        assert 'read-only' in msg
        assert s.pendingMutations == []

    def test_unattended_run_refuses_instead_of_soft_locking(self):
        s = _session(guardMode='full', headless=True)
        allowed, msg = code_runner.code_mode_switch_decision(s)
        assert not allowed
        assert 'unattended' in msg
        assert s.pendingMutations == []


# ── Cell gate (parent policy, both warm and cold) ─────────────────────────


class TestCellGate:
    def test_untrusted_code_session_cannot_run_a_cell(self):
        s = _session(guardMode='full', agent_mode='code')
        denial = wb._codeModeCellDenial(s)
        assert denial is not None
        assert 'not enabled' in denial

    def test_read_only_denies_cells_even_when_trusted(self):
        s = _session(guardMode='full', agent_mode='code', sandboxMode='read-only')
        code_runner.mark_code_mode_trusted(s)
        denial = wb._codeModeCellDenial(s)
        assert denial is not None
        assert 'read-only' in denial

    def test_plan_mode_denies_cells(self):
        s = _session(guardMode='plan', agent_mode='code')
        code_runner.mark_code_mode_trusted(s)
        denial = wb._codeModeCellDenial(s)
        assert denial is not None
        assert 'plan mode' in denial

    def test_trusted_code_mode_in_edit_queues_approval(self):
        s = _session(guardMode='edit', agent_mode='code')
        code_runner.mark_code_mode_trusted(s)
        denial = wb._codeModeCellDenial(s)
        assert denial is not None and 'approval' in denial.lower()
        assert len(s.pendingMutations) == 1
        assert 'code-mode cell' in s.pendingMutations[0]['preview']

    def test_trusted_code_mode_full_access_runs(self):
        s = _session(guardMode='full', agent_mode='code')
        code_runner.mark_code_mode_trusted(s)
        assert wb._codeModeCellDenial(s) is None

    @pytest.mark.asyncio
    async def test_fenced_block_is_refused_before_any_execution(self, tmp_path):
        s = _session(guardMode='full', agent_mode='code')
        s.workspacePath = str(tmp_path)
        wb._sessions[s.id] = s
        try:
            out = await wb._runFencedCodeBlock(
                s, '```python\nopen("pwned.txt", "w").write("x")\n```', 1
            )
        finally:
            wb._sessions.pop(s.id, None)
        assert out is not None and 'not enabled' in out
        assert not (tmp_path / 'pwned.txt').exists()
        assert not (tmp_path / '.aug' / 'code_runs').exists()


# ── The trusted local path still works ────────────────────────────────────


class TestTrustedExplicitCodeMode:
    def test_composer_selection_marks_the_session_trusted(self):
        from app.routers import workbench as workbench_router
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        s = _session(guardMode='full', agent_mode='agent')
        wb._sessions[s.id] = s
        app = FastAPI()
        app.include_router(workbench_router.router)
        try:
            resp = TestClient(app).post(
                '/api/workbench/agent-mode', json={'sessionId': s.id, 'agentMode': 'code'}
            )
            assert resp.status_code == 200, resp.text
            assert s.agent_mode == 'code'
            assert code_runner.is_code_mode_trusted(s)
            assert wb._codeModeCellDenial(s) is None
        finally:
            wb._sessions.pop(s.id, None)

    @pytest.mark.asyncio
    async def test_user_selected_code_mode_executes_a_real_cell(self, tmp_path):
        s = _session(guardMode='full', agent_mode='code')
        s.workspacePath = str(tmp_path)
        code_runner.mark_code_mode_trusted(s)
        wb._sessions[s.id] = s
        try:
            out = await wb._runFencedCodeBlock(
                s, '```python\nprint("cell-ok")\nresult = 1 + 1\n```', 1
            )
        finally:
            wb._sessions.pop(s.id, None)
            kernel.shutdown_all_warm_kernels()
        assert out is not None
        assert 'cell-ok' in out, out
        assert '[result] 2' in out, out


# ── The bridge keeps its own checks ───────────────────────────────────────


class TestBridgeChecksPreserved:
    @pytest.mark.asyncio
    async def test_bridge_still_refuses_read_only_mutation(self, tmp_path):
        s = _session(guardMode='full', agent_mode='code', sandboxMode='read-only')
        s.workspacePath = str(tmp_path)
        code_runner.mark_code_mode_trusted(s)
        out = await kernel.bridge_call(s, 'write_file', {'path': 'x.txt', 'content': 'y'})
        assert '[Blocked]' in out
        assert not (tmp_path / 'x.txt').exists()
