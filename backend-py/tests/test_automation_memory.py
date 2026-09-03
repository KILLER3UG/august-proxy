"""Part 21 M-11 — automation persistent memory (ledger, notepad, incidents,
wake context, retention sweep) + Part 19 Phase B delivery/tools.

The brain-DB stores live next to turn_outcomes (migration 031). Everything
here is best-effort machine state: never raises into a run, caps enforced in
service code, wake context empty (byte-identical prompt) on first run.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest


@pytest.fixture()
def store(isolatedData):
    from app.services.memory_store import init as init_store

    init_store()
    from app.services import automation_memory

    return automation_memory


# ── runs ledger ────────────────────────────────────────────────────────────


class TestRunsLedger:
    def test_start_finish_roundtrip(self, store):
        rid = store.start_run(job_id='j1', trigger='cron', agent_id='agent_a')
        assert rid > 0
        store.finish_run(
            rid, status='succeeded', result_excerpt='done', duration_ms=1234
        )
        row = store.last_run('j1')
        assert row is not None
        assert row['status'] == 'succeeded'
        assert row['result_excerpt'] == 'done'
        assert row['duration_ms'] == 1234
        assert row['finished_at']

    def test_finish_run_ignores_non_terminal_and_bogus_ids(self, store):
        rid = store.start_run(job_id='j2')
        store.finish_run(rid, status='running')  # non-terminal → no stamp
        assert store.last_run('j2')['status'] == 'running'
        store.finish_run(999999, status='succeeded')  # unknown id → no raise
        store.finish_run(0, status='succeeded')  # failed start (0) → no raise

    def test_excerpt_capped_4k(self, store):
        rid = store.start_run(job_id='j3')
        store.finish_run(rid, status='succeeded', result_excerpt='x' * 9000)
        assert len(store.last_run('j3')['result_excerpt']) == 4 * 1024


# ── notepad ────────────────────────────────────────────────────────────────


class TestNotes:
    def test_set_get_delete(self, store):
        assert store.set_note('j1', 'cursor', 'abc') == ''
        assert store.get_notes('j1') == {'cursor': 'abc'}
        assert store.delete_note('j1', 'cursor') == ''
        assert store.get_notes('j1') == {}

    def test_caps(self, store):
        assert 'over' in store.set_note('j1', 'big', 'x' * (4 * 1024 + 1))
        assert 'key' in store.set_note('j1', '  ', 'v')
        # Job cap: 4 KiB per key × 5 keys > 16 KiB job budget.
        for i in range(5):
            err = store.set_note('j1', f'k{i}', 'y' * 3500)
        assert 'over' in err

    def test_empty_value_deletes(self, store):
        store.set_note('j1', 'k', 'v')
        assert store.set_note('j1', 'k', '') == ''
        assert store.get_notes('j1') == {}


# ── incidents ──────────────────────────────────────────────────────────────


class TestIncidents:
    def test_failed_runs_dedupe_success_closes(self, store):
        r1 = store.start_run(job_id='j1')
        store.finish_run(r1, status='failed', error_sig='boom: head')
        open1 = store.open_incidents('j1')
        assert len(open1) == 1 and open1[0]['occurrences'] == 1

        r2 = store.start_run(job_id='j1')
        store.finish_run(r2, status='failed', error_sig='boom: head')
        open2 = store.open_incidents('j1')
        assert len(open2) == 1 and open2[0]['occurrences'] == 2, 'same signature must dedupe'

        r3 = store.start_run(job_id='j1')
        store.finish_run(r3, status='succeeded')
        assert store.open_incidents('j1') == [], 'a succeeding run closes incidents'

    def test_all_jobs_listing(self, store):
        r = store.start_run(job_id='jA')
        store.finish_run(r, status='failed', error_sig='x')
        r = store.start_run(job_id='jB')
        store.finish_run(r, status='timeout', error_sig='y')
        assert {i['job_id'] for i in store.open_incidents()} >= {'jA', 'jB'}


# ── wake context ───────────────────────────────────────────────────────────


class TestWakeContext:
    def test_first_run_prompt_stays_byte_identical(self, store):
        assert store.wake_context({'id': 'fresh-job'}) == ''

    def test_history_prepend_block(self, store):
        rid = store.start_run(job_id='j1')
        store.finish_run(rid, status='failed', result_excerpt='traceback head', error_sig='e')
        store.set_note('j1', 'cursor', 'abc')
        ctx = store.wake_context({'id': 'j1'})
        assert ctx.startswith('<routine_context>')
        assert 'failed' in ctx and 'traceback head' in ctx
        assert 'cursor: abc' in ctx
        assert ctx.rstrip().endswith('</routine_context>')

    def test_continuity_tail_only_when_flagged(self, store):
        rid = store.start_run(job_id='j1')
        store.finish_run(rid, status='succeeded', result_excerpt='work output tail')
        plain = store.wake_context({'id': 'j1'})
        cont = store.wake_context({'id': 'j1', 'continuity': True})
        assert 'last time' not in plain
        assert 'last time' in cont and 'work output tail' in cont


# ── retention sweep ────────────────────────────────────────────────────────


class TestSweep:
    def test_runs_kept_within_window_old_removed(self, store):
        fresh = store.start_run(job_id='j1')
        old = store.start_run(job_id='j1')
        now = datetime.now(timezone.utc)
        from app.services.memory_conn import conn as _conn

        cutoff = (now - timedelta(days=40)).date().isoformat()
        _conn().execute(
            'UPDATE automation_runs SET started_at = ? WHERE id = ?', (cutoff, old)
        )
        _conn().commit()
        removed = store.sweep(days=30, now=now)
        assert removed >= 1
        ids = {r['id'] for r in store.runs_for_job('j1', limit=10)}
        assert fresh in ids and old not in ids

    def test_closed_incidents_past_90d_removed_open_kept(self, store):
        from app.services.memory_conn import conn as _conn

        r = store.start_run(job_id='jOld')
        store.finish_run(r, status='failed', error_sig='stale')
        store.close_incident('jOld')
        _conn().execute(
            "UPDATE automation_incidents SET last_seen_at = '2020-01-01T00:00:00' "
            "WHERE job_id = 'jOld'"
        )
        r2 = store.start_run(job_id='jOpen')
        store.finish_run(r2, status='failed', error_sig='live')
        _conn().commit()
        removed = store.sweep(now=datetime.now(timezone.utc))
        assert removed >= 1
        remaining = {i['job_id'] for i in store.open_incidents()}
        assert 'jOpen' in remaining and 'jOld' not in remaining


# ── Part 19 Phase B: delivery + routine tools ─────────────────────────────


def _bot_and_chat():
    from app.services.bot_mode import roster

    # intro=False: these tests must not fire a real model turn at birth.
    bot = roster.create_bot(name='Courier', title='Courier', actor='test', intro=False)
    chat = roster.ensure_canonical_bot_chat(bot['id'])
    return bot, chat


class TestDeliverToBotChat:
    def test_passive_delivery_appends_once_no_turn(self, store):
        from app.services.workbench import sessions as sessions_mod

        bot, chat = _bot_and_chat()
        before = len(chat.messages)
        status = store.deliver_to_bot_chat(
            {'id': 'j1', 'name': 'Brief', 'agentId': bot['id']},
            result_text='all good',
            respond=False,
        )
        assert status == 'delivered-passive'
        fresh = sessions_mod.get_workbench_session(chat.id)
        assert len(fresh.messages) == before + 1
        assert '[routine:Brief]' in fresh.messages[-1]['content']
        assert 'all good' in fresh.messages[-1]['content']

    def test_respond_delivery_runs_exactly_one_turn_no_duplicate(self, store, monkeypatch):
        from app.services.workbench import sessions as sessions_mod
        from app.services.workbench import workbench as wb

        bot, chat = _bot_and_chat()
        calls: list[dict] = []

        async def fake_stream(sessionId, message, **kwargs):
            # Mirror the real loop: the turn itself appends the user message.
            sess = sessions_mod.get_workbench_session(sessionId)
            sess.messages.append({'role': 'user', 'content': message})
            calls.append({'sessionId': sessionId, 'message': message})

        monkeypatch.setattr(wb, 'sendWorkbenchMessageStream', fake_stream)
        status = store.deliver_to_bot_chat(
            {'id': 'j1', 'name': 'Brief', 'agentId': bot['id']},
            result_text='run output',
            respond=True,
        )
        assert status == 'delivered-respond'
        assert len(calls) == 1
        fresh = sessions_mod.get_workbench_session(chat.id)
        copies = [m for m in fresh.messages if '[routine:Brief]' in str(m.get('content'))]
        assert len(copies) == 1, 'the delivery must not be duplicated in the transcript'

    def test_no_agent_is_a_clean_noop(self, store):
        assert store.deliver_to_bot_chat({'id': 'j1'}, result_text='x') == 'no-agent'


class TestRoutineTools:
    def _bot(self, monkeypatch):
        from app.services.bot_mode import routines

        bot, _chat = _bot_and_chat()
        monkeypatch.setattr(
            routines, '_current_bot', lambda: {'id': bot['id'], 'name': bot['name']}
        )
        return routines, bot

    def test_create_upsert_delete_roundtrip(self, monkeypatch):
        routines, bot = self._bot(monkeypatch)
        from app.services import automations_store

        out = asyncio.run(
            routines.createRoutine(
                title='Morning brief', prompt='Summarize', schedule='every 1h'
            )
        )
        assert '"status": "success"' in out
        job_name = f"[bot:{bot['name']}] Morning brief"
        jobs = [
            j
            for j in automations_store.list_jobs()
            if j.get('name') == job_name
        ]
        assert len(jobs) == 1 and jobs[0].get('deliver') == 'bot-chat'

        # Upsert by title: same namespaced name, no fork.
        asyncio.run(routines.createRoutine(title='Morning brief', prompt='V2', schedule='every 1h'))
        jobs = [j for j in automations_store.list_jobs() if j.get('name') == job_name]
        assert len(jobs) == 1

        listing = asyncio.run(routines.listRoutines())
        assert 'Morning brief' in listing

        gone = asyncio.run(routines.deleteRoutine('Morning brief'))
        assert '"status": "success"' in gone
        assert not [j for j in automations_store.list_jobs() if j.get('name') == job_name]

    def test_create_requires_bot_and_inputs(self, monkeypatch):
        from app.services.bot_mode import routines

        monkeypatch.setattr(routines, '_current_bot', lambda: {})
        out = asyncio.run(routines.createRoutine(title='x', prompt='p', schedule='every 1h'))
        assert '"status": "error"' in out and 'Bot session' in out

        monkeypatch.setattr(
            routines, '_current_bot', lambda: {'id': 'agent_x', 'name': 'c'}
        )
        out = asyncio.run(routines.createRoutine(title='x', prompt='', schedule='every 1h'))
        assert 'prompt' in out or 'command' in out
        out = asyncio.run(routines.createRoutine(title='x', prompt='p', schedule=''))
        assert 'schedule' in out

    def test_job_notes_tool_gate(self, store, monkeypatch):
        from app.services.bot_mode import routines
        from app.services.workbench import context as wb_context
        from app.services.workbench import sessions as sessions_mod
        from app.services.workbench.sessions import create_workbench_session

        # Outside any session → structured error, no write.
        out = asyncio.run(routines.jobNotes(action='set', key='k', value='v'))
        assert '"status": "error"' in out
        # An explicit jobId must NOT widen the gate: a non-automation session
        # cannot write notes that would land in an unattended routine's wake
        # context (the docstring's double-check is the gate, not a default).
        out = asyncio.run(routines.jobNotes(action='set', key='k', value='v', jobId='j9'))
        assert '"status": "error"' in out

        # Inside an automation-run session (metadata carries its job id) the
        # notepad door opens for THAT job.
        sess = create_workbench_session()
        sess.metadata = {'automationJobId': 'j9'}
        sessions_mod._sessions[sess.id] = sess
        token = wb_context.currentSessionId.set(sess.id)
        try:
            out = asyncio.run(routines.jobNotes(action='set', key='k', value='v', jobId='j9'))
            assert '"status": "success"' in out
            assert store.get_notes('j9') == {'k': 'v'}
            out = asyncio.run(routines.jobNotes(action='get', jobId='j9'))
            assert 'k' in out
        finally:
            wb_context.currentSessionId.reset(token)
