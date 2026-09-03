"""S-1 rider (2026-09-04) — unattended runs must never hang on approval prompts.

Bot routines ship with ``headless=True`` run sessions (automations_store) but
the never-ask stance never consulted the session, so an ask-policy routine
either queued a desktop-only ApprovalBanner (soft-lock: the model is told
"do not retry" and no human is present) or created a pending mutation that
expires unused. The rider:

1. ``_approval_never_ask`` returns True for headless sessions.
2. Denied asks become ``blocked-step`` rows in the M-11 ledger
   (automation_incidents) + a passive Bot Chat notice on first detection.
3. The denial extends to the mutation-gate path (``_checkToolGuard``): an
   unattended session gets a deny receipt instead of a pending mutation.
4. Gateway run contexts (session_bridge) are stamped headless — a remote
   paired owner has no desktop banner to answer.
"""

from __future__ import annotations

import types

import pytest
from app.services.workbench import workbench as wb


def _make_session(*, headless: bool, guardMode: str = 'ask', job_id: str = ''):
    sess = wb.createWorkbenchSession(
        provider='', agentId='build', guardMode=guardMode, headless=headless
    )
    if job_id:
        meta = dict(sess.metadata or {})
        meta['automationJobId'] = job_id
        sess.metadata = meta
    return sess


# ── 1. never-ask consults the session ──────────────────────────────────────


class TestNeverAskConsultsHeadless:
    def test_headless_session_is_never_ask(self, isolatedData):
        sess = _make_session(headless=True)
        policy = wb._loadApprovalPolicy(sess)
        assert wb._approval_never_ask(policy, sess) is True

    def test_interactive_session_is_not_never_ask(self, isolatedData):
        sess = _make_session(headless=False)
        policy = wb._loadApprovalPolicy(sess)
        assert wb._approval_never_ask(policy, sess) is False

    def test_policy_never_ask_still_wins_without_session(self, isolatedData):
        from app.services.workbench.permissions import policy_from_dict

        policy = policy_from_dict({'neverAsk': True})
        assert wb._approval_never_ask(policy) is True

    def test_missing_headless_attr_is_safe(self):
        bare = types.SimpleNamespace()
        from app.services.workbench.permissions import policy_from_dict

        assert wb._approval_never_ask(policy_from_dict(None), bare) is False


# ── 2/3. mutation-gate denial (the hang path) ──────────────────────────────


class TestMutationGateDenial:
    def test_headless_ask_mode_denies_without_pending_mutation(self, isolatedData):
        sess = _make_session(headless=True, guardMode='ask')
        reason = wb._checkToolGuard(
            sess, 'write_file', {'path': 'notes/a.txt', 'content': 'x'}
        )
        assert reason is not None
        assert 'unattended' in reason.lower()
        assert sess.pendingMutations == []
        assert sess.status != 'awaiting_approval'

    def test_headless_ask_mode_denies_shell(self, isolatedData):
        sess = _make_session(headless=True, guardMode='ask')
        reason = wb._checkToolGuard(
            sess, 'run_command', {'command': 'rm -rf build'}
        )
        assert reason is not None
        assert 'unattended' in reason.lower()
        assert sess.pendingMutations == []

    def test_interactive_ask_mode_still_queues_approval(self, isolatedData):
        sess = _make_session(headless=False, guardMode='ask')
        reason = wb._checkToolGuard(
            sess, 'write_file', {'path': 'notes/b.txt', 'content': 'x'}
        )
        assert reason is not None
        assert 'approval' in reason.lower()
        assert len(sess.pendingMutations) == 1

    def test_headless_denial_writes_blocked_step_ledger(self, isolatedData):
        from app.services import automation_memory
        from app.services.memory_store import init as init_store

        init_store()
        sess = _make_session(headless=True, guardMode='ask', job_id='j-block')
        wb._checkToolGuard(
            sess, 'write_file', {'path': 'notes/c.txt', 'content': 'x'}
        )
        incidents = automation_memory.open_incidents('j-block')
        assert any(
            str(i.get('error_signature', '')).startswith('blocked-step')
            for i in incidents
        )

    def test_headless_denial_without_job_id_does_not_raise(self, isolatedData):
        sess = _make_session(headless=True, guardMode='ask')
        reason = wb._checkToolGuard(
            sess, 'write_file', {'path': 'notes/d.txt', 'content': 'x'}
        )
        assert reason is not None  # denial still returned, no ledger, no crash

    def test_readonly_tool_not_affected(self, isolatedData):
        sess = _make_session(headless=True, guardMode='ask')
        assert wb._checkToolGuard(sess, 'read_file', {'path': 'x.txt'}) is None


# ── command-approval axis (T5 policy) under headless ───────────────────────


class TestCommandApprovalAxisHeadless:
    def _enabled_policy_session(self, *, headless: bool):
        sess = _make_session(headless=headless, guardMode='full')
        meta = dict(sess.metadata or {})
        meta['approvalPolicy'] = {'enabled': True}
        sess.metadata = meta
        return sess

    def test_headless_ask_decision_denies_without_mutation(self, isolatedData):
        sess = self._enabled_policy_session(headless=True)
        receipt = wb._resolveCommandApproval(
            sess, 'run_command', {'command': 'rm -rf node_modules'}
        )
        assert receipt is not None
        assert 'unattended' in receipt.lower()
        assert sess.pendingMutations == []

    def test_interactive_ask_decision_queues_mutation(self, isolatedData):
        sess = self._enabled_policy_session(headless=False)
        receipt = wb._resolveCommandApproval(
            sess, 'run_command', {'command': 'rm -rf node_modules'}
        )
        assert receipt is not None
        assert 'approval' in receipt.lower()
        assert len(sess.pendingMutations) == 1


# ── 2. ledger record + Bot Chat notice ─────────────────────────────────────


class TestRecordBlockedStep:
    @pytest.fixture()
    def store(self, isolatedData):
        from app.services.memory_store import init as init_store

        init_store()
        from app.services import automation_memory

        return automation_memory

    def test_first_detection_writes_incident(self, store):
        store.record_blocked_step(job_id='j1', tool='write_file', reason='mutating')
        incidents = store.open_incidents('j1')
        sigs = [str(i.get('error_signature')) for i in incidents]
        assert any(s.startswith('blocked-step: write_file') for s in sigs)

    def test_repeat_bumps_occurrences(self, store):
        store.record_blocked_step(job_id='j2', tool='run_command', reason='a')
        store.record_blocked_step(job_id='j2', tool='run_command', reason='b')
        incidents = store.open_incidents('j2')
        row = next(
            i for i in incidents
            if str(i.get('error_signature')).startswith('blocked-step: run_command')
        )
        assert int(row.get('occurrences', 0)) == 2

    def test_empty_job_id_is_noop(self, store):
        store.record_blocked_step(job_id='', tool='write_file', reason='x')

    def test_notice_delivered_once_per_incident(self, store, monkeypatch):
        notices: list[str] = []
        monkeypatch.setattr(
            store,
            'deliver_to_bot_chat',
            lambda job, **kw: notices.append(str(kw.get('result_text', ''))) or 'ok',
        )
        monkeypatch.setattr(
            'app.services.automations_store.get_job',
            lambda job_id: {'id': job_id, 'name': 'nightly', 'agentId': 'bot_x'},
        )
        store.record_blocked_step(job_id='j3', tool='write_file', reason='mutating')
        store.record_blocked_step(job_id='j3', tool='write_file', reason='mutating')
        assert len(notices) == 1
        assert 'blocked' in notices[0].lower()


# ── 4. gateway run contexts stamped headless ───────────────────────────────


class TestGatewayHeadlessStamp:
    def test_session_bridge_factory_gets_headless(self, isolatedData, tmp_path):
        from app.services.gateway.session_bridge import SessionBridge

        captured: dict[str, object] = {}

        def fake_factory(**kw):
            captured.update(kw)
            return types.SimpleNamespace(id='wb_fake', metadata={})

        bridge = SessionBridge(
            runner=None,
            sessionFactory=fake_factory,
            deleteSession=lambda sid: True,
            mapPath=tmp_path / 'map.json',
        )
        sid = bridge.sessionIdFor('telegram:42')
        assert sid == 'wb_fake'
        assert captured.get('headless') is True
