"""Late subagent/daemon completions must always reach the parent conversation.

Background completions land after the parent turn may already have ended. The
auto-turn machinery exists to fold them in, but it had a race: when a
completion arrived after the running turn's LAST queue drain, the wake had
already given up (it saw the turn still streaming) and nothing re-armed it, so
the result sat in ``queuedUserMessages`` until the user sent an unrelated
message — the parent model never saw it.

These tests pin:
  * the re-arm fires when subagent/daemon entries remain at turn end,
  * it does NOT fire for a user's own queued message (that must wait for the
    user, and an auto-turn must never consume it),
  * the runaway cap is surfaced on an event the desktop bridge handles.
"""

from __future__ import annotations

import pytest
from app.routers import workbench as router
from app.services.workbench import workbench as wb


@pytest.fixture
def sessionId():
    session = wb.createWorkbenchSession(provider='test')
    sid = session.id
    try:
        yield sid
    finally:
        try:
            wb._sessions.pop(sid, None)
        except Exception:
            pass


def _enqueueSubagent(sessionId: str, text: str = 'subagent finished') -> None:
    session = wb.getWorkbenchSession(sessionId)
    session.queuedUserMessages.append(
        {'id': f'm{rand()}', 'text': text, 'kind': 'subagent', 'at': 0.0}
    )


def _enqueueUser(sessionId: str, text: str = 'user follow-up') -> None:
    session = wb.getWorkbenchSession(sessionId)
    session.queuedUserMessages.append(
        {'id': f'm{rand()}', 'text': text, 'kind': 'queue', 'at': 0.0}
    )


def rand() -> str:
    import uuid

    return uuid.uuid4().hex[:8]


class TestRearmOnTurnEnd:
    def test_rearms_when_subagent_result_is_pending(self, sessionId, monkeypatch):
        _enqueueSubagent(sessionId)
        called: list[str] = []
        monkeypatch.setattr(
            router, 'scheduleSubagentAutoTurn', lambda sid: called.append(sid)
        )
        router._rearmAutoTurnIfPending(sessionId)
        assert called == [sessionId]

    def test_does_not_rearm_for_a_plain_user_message(self, sessionId, monkeypatch):
        """An auto-turn must never consume the user's own queued message — it
        would answer a turn the user never explicitly started."""
        _enqueueUser(sessionId)
        called: list[str] = []
        monkeypatch.setattr(
            router, 'scheduleSubagentAutoTurn', lambda sid: called.append(sid)
        )
        router._rearmAutoTurnIfPending(sessionId)
        assert called == []

    def test_does_nothing_when_queue_is_empty(self, sessionId, monkeypatch):
        called: list[str] = []
        monkeypatch.setattr(
            router, 'scheduleSubagentAutoTurn', lambda sid: called.append(sid)
        )
        router._rearmAutoTurnIfPending(sessionId)
        assert called == []

    def test_rearm_never_consumes_the_queue(self, sessionId, monkeypatch):
        """The peek must be non-destructive — the drain is the auto-turn's job."""
        _enqueueSubagent(sessionId)
        before = len(wb.listQueuedMessages(sessionId))
        monkeypatch.setattr(router, 'scheduleSubagentAutoTurn', lambda sid: None)
        router._rearmAutoTurnIfPending(sessionId)
        assert len(wb.listQueuedMessages(sessionId)) == before

    def test_survives_an_unknown_session(self):
        """A torn-down session must not raise out of the turn's finally block."""
        router._rearmAutoTurnIfPending('no-such-session-id')


class TestCapIsSurfaced:
    def test_cap_emits_a_handled_event(self, sessionId, monkeypatch):
        """The runaway guard stays, but it must not swallow the reason.

        Uses ``session.updated`` because that is one of the event names the
        desktop realtime bridge actually handles; an unhandled name would be
        silently dropped by the client's default branch.
        """
        _enqueueSubagent(sessionId)
        session = wb.getWorkbenchSession(sessionId)
        session._autoTurnsSinceUser = router._AUTO_TURN_MAX_CONSECUTIVE

        emitted: list[tuple] = []
        import app.services.realtime_bus as bus

        monkeypatch.setattr(
            bus, 'emit_realtime', lambda *a, **k: emitted.append((a, k))
        )

        router._notifyAutoTurnCapReached(sessionId, router._AUTO_TURN_MAX_CONSECUTIVE)

        assert emitted, 'capping silently is what made this look like data loss'
        args, kwargs = emitted[0]
        name = args[0] if args else kwargs.get('event')
        assert name == 'session.updated'
        assert kwargs.get('action') == 'auto_turn_cap_reached'
        assert kwargs.get('pendingSubagentResults') == 1

    def test_cap_is_silent_when_nothing_is_pending(self, sessionId, monkeypatch):
        """Don't emit noise when the queue drained in the meantime."""
        emitted: list[tuple] = []
        import app.services.realtime_bus as bus

        monkeypatch.setattr(
            bus, 'emit_realtime', lambda *a, **k: emitted.append((a, k))
        )
        router._notifyAutoTurnCapReached(sessionId, 4)
        assert not emitted
