"""Harness polish batch — clarify previews, session_context focus,
recurring pause/history, daemon re-wake (one test file per batch)."""

from __future__ import annotations

import pytest

# ── Clarify previews (submit_clarify payload normalization) ──────────────


def test_submit_clarify_keeps_previews_single_select(isolatedData):
    from app.services.workbench import workbench as wb

    session = wb.createWorkbenchSession()
    wb.submitClarify(session, {
        'questions': [{
            'question': 'Which layout?',
            'choices': ['A', 'B'],
            'previews': ['## A\nmonospace preview', '## B\nother'],
        }],
    })
    qs = session.clarify['questions']  # type: ignore[index]
    assert qs[0]['previews'] == ['## A\nmonospace preview', '## B\nother']


def test_submit_clarify_drops_previews_for_multiselect(isolatedData):
    from app.services.workbench import workbench as wb

    session = wb.createWorkbenchSession()
    wb.submitClarify(session, {
        'questions': [{
            'question': 'Pick many',
            'choices': ['A', 'B'],
            'previews': ['pa', 'pb'],
            'multiSelect': True,
        }],
    })
    qs = session.clarify['questions']  # type: ignore[index]
    assert 'previews' not in qs[0]


# ── session_context focused digest ───────────────────────────────────────


def test_context_capsule_focus_selects_matching_turns():
    from app.services.tool_registrations.session_tools import _contextCapsule

    blob = {
        'id': 'wb_x', 'title': 'Long chat',
        'messages': [
            {'role': 'user', 'content': 'hello there'},
            {'role': 'assistant', 'content': 'hi! what should we do?'},
            {'role': 'user', 'content': 'fix the quartus license parsing error'},
            {'role': 'assistant', 'content': 'License file absent — pointing LM_LICENSE_FILE'},
            {'role': 'user', 'content': 'thanks, done'},
        ],
    }
    full = _contextCapsule(blob, 6000)
    assert full.count('USER:') == 3
    focused = _contextCapsule(blob, 6000, focus='quartus license')
    assert 'focused digest' in focused
    assert 'fix the quartus license' in focused
    assert 'hi! what should we do?' in focused  # one turn of context kept
    assert 'hello there' not in focused and 'thanks, done' not in focused


@pytest.mark.asyncio
async def test_session_context_tool_passes_query(isolatedData, monkeypatch):
    from app.services.tool_registrations import session_tools as st

    blob = {
        'id': 'wb_q', 'title': 'T',
        'messages': [{'role': 'user', 'content': 'needle in the haystack'},
                     {'role': 'assistant', 'content': 'totally unrelated'}],
    }
    monkeypatch.setattr(
        'app.services.memory_store.sessions.get_workbench_blob', lambda sid: blob
    )
    out = await st._sessionContext(sessionId='wb_q', query='needle')
    assert 'needle' in out and 'unrelated' not in out


# ── Recurring tasks: pause + runs history ────────────────────────────────


def test_recurring_pause_and_history(isolatedData):
    from app.services import recurring_tasks as rt

    task_id = rt.add_task('every 1 minutes', 'stand up and stretch')
    assert task_id
    fired = rt.check_and_fire('s1')
    assert any('stretch' in m for m, _model in fired)
    runs = rt.get_runs(task_id)
    assert len(runs) == 1 and 'stretch' in runs[0]['message']

    assert rt.set_active(task_id, False) is True
    # Clear the elapsed gate so a NON-paused task would definitely fire —
    # only the pause can be why it doesn't.
    conn = rt._conn()
    conn.execute('UPDATE recurring_tasks SET last_fired_at = NULL WHERE id = ?', (task_id,))
    conn.commit()
    again = rt.check_and_fire('s1')
    assert not any('stretch' in m for m, _model in again)

    assert rt.set_active(task_id, True) is True
    assert any('stretch' in m for m, _model in rt.check_and_fire('s1'))
    assert rt.delete_task(task_id) is True
    assert rt.get_runs(task_id) == []  # delete cascades the ledger


def test_recurring_runs_capped_at_20(isolatedData):
    from app.services import recurring_tasks as rt

    task_id = rt.add_task('every 1 minutes', 'water the plants')
    conn = rt._conn()
    for _ in range(25):
        rt._record_run(conn, task_id, 'water the plants')
    conn.commit()
    # The cap lives in the table, not just the read limit.
    stored = conn.execute(
        'SELECT COUNT(*) FROM recurring_task_runs WHERE task_id = ?', (task_id,)
    ).fetchone()[0]
    assert stored == 20


# ── Daemon re-wake notification ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_daemon_notify_enqueues_and_schedules(monkeypatch):
    import app.routers.workbench as rw
    from app.services import daemon_manager as dm
    from app.services.workbench import workbench as wb_module

    captured: list[tuple] = []
    scheduled: list[str] = []
    monkeypatch.setattr(
        wb_module, 'enqueueUserMessage',
        lambda sid, text, kind='': captured.append((sid, text, kind)) or True,
    )
    monkeypatch.setattr(rw, 'scheduleSubagentAutoTurn', lambda sid: scheduled.append(sid))

    mgr = dm.DaemonManager()
    r = dm.DaemonResult(status='completed', output='build green')
    mgr._daemons['d1'] = {  # noqa: SLF001 — white-box
        'id': 'd1', 'session_id': 's1', 'name': 'watcher',
        'watch_condition': 'exit code 0', 'result': r,
    }
    mgr._notifyParent('d1', 'triggered')
    assert captured and captured[0][0] == 's1' and captured[0][2] == 'daemon'
    assert 'DAEMON_TRIGGERED' in captured[0][1] and 'build green' in captured[0][1]
    assert scheduled == ['s1']

    # Shutdown suppresses notifications (no waking on app teardown).
    captured.clear()
    mgr._shutting_down = True
    mgr._notifyParent('d1', 'finished')
    assert captured == []
