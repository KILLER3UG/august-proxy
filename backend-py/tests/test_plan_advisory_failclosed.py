"""Regression tests for round 3: plan-mode advisory risk gate is fail-closed.

bf0b5f49 introduced the advisory escape hatch keyed on session.planRisk but
never shipped a setter, so the '' default made every non-shell mutation pass
in plan mode. These tests pin the corrected contract: UNASSESSED risk blocks.
"""

from __future__ import annotations


def _plan_session():
    from app.services.workbench.sessions import create_workbench_session

    s = create_workbench_session(provider='test', guardMode='plan')
    s.planApproved = False
    return s


class TestPlanAdvisoryRiskGate:
    def test_unassessed_risk_blocks_mutations(self):
        """Default (no planRisk set) must BLOCK — fail closed."""
        from app.services.workbench.workbench import _checkToolGuard

        s = _plan_session()
        assert getattr(s, 'planRisk', '') == '', 'precondition: risk unassessed'
        assert _checkToolGuard(s, 'write_file', {'path': '/x', 'content': 'y'}) is not None
        assert _checkToolGuard(s, 'edit_file', {'path': '/x'}) is not None

    def test_explicit_low_risk_takes_advisory_allowance(self):
        from app.services.workbench.workbench import _checkToolGuard

        s = _plan_session()
        s.planRisk = 'low'
        # Non-shell, non-hardcoded-high tool passes under an explicit low risk.
        assert _checkToolGuard(s, 'write_file', {'path': '/x', 'content': 'y'}) is None

    def test_high_risk_tools_block_even_at_low_assessment(self):
        """Shell/destructive tools stay hard-blocked regardless of assessment."""
        from app.services.workbench.workbench import _checkToolGuard

        s = _plan_session()
        s.planRisk = 'low'
        assert _checkToolGuard(s, 'run_command', {'command': 'ls'}) is not None
        assert _checkToolGuard(s, 'delete_file', {'path': '/x'}) is not None
        s.planRisk = 'high'
        assert _checkToolGuard(s, 'write_file', {'path': '/x', 'content': 'y'}) is not None

    def test_integration_mutations_block_in_plan_mode(self):
        """connect_* / install_mcp_server are mutating and must be gated."""
        from app.services.workbench.workbench import _checkToolGuard

        s = _plan_session()
        for tool in ('connect_github', 'connect_slack', 'connect_google',
                     'install_mcp_server', 'disconnect_integration'):
            assert _checkToolGuard(s, tool, {}) is not None, f'{tool} must be gated in plan mode'

    def test_plan_file_write_still_allowed(self):
        """The plan file itself remains writable in plan mode (needs a workspace)."""
        import tempfile

        from app.services.workbench.sessions import create_workbench_session
        from app.services.workbench.workbench import _checkToolGuard, plan_file_path, plan_file_relpath

        ws = tempfile.mkdtemp(prefix='plan_ws_')
        s = create_workbench_session(provider='test', guardMode='plan', workspacePath=ws)
        s.planApproved = False
        allowed = plan_file_path(ws, s.id)
        if not allowed:
            return  # plan file path unavailable in this env; nothing to assert
        result = _checkToolGuard(
            s, 'write_file', {'path': allowed, 'content': '# Plan'}
        )
        assert result is None, 'the plan file itself must remain writable in plan mode'
