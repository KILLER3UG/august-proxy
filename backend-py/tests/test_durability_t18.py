"""T18 fail-closed session durability barriers (plan §9.4): unit tests for
app/services/workbench/durability.py and the fromDict crash-recovery path.
Loop-level barrier wiring lives in test_workbench_tool_loop.py."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.workbench import durability as dur  # noqa: E402
from app.services.workbench.sessions import WorkbenchSession  # noqa: E402


class TestFlushSessionBarrier:
    def testSyncsMessagesAndPersists(self, monkeypatch: pytest.MonkeyPatch) -> None:
        saved: list[dict[str, object]] = []

        def fake_save(blob: dict[str, object]) -> None:
            saved.append(blob)

        import app.services.memory_store as ms

        monkeypatch.setattr(ms, 'save_workbench_session_sot', fake_save)
        monkeypatch.setattr(ms, 'init', lambda: None)

        session = WorkbenchSession(id='s1', messages=[{'role': 'user', 'content': 'old'}])
        working = [
            {'role': 'user', 'content': 'old'},
            {'role': 'assistant', 'content': 'new'},
        ]
        ok, err = dur.flush_session_barrier(session, dur.BARRIER_MODEL_DISPATCH, working)
        assert ok and err == ''
        assert session.turnOpen is True
        assert session.messages == working
        assert session.messageCount == 2
        assert saved and saved[0]['turnOpen'] is True
        assert saved[0]['messages'] == working

    def testFailureReportedNotRaised(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import app.services.memory_store as ms

        def boom(blob: dict[str, object]) -> None:
            raise OSError('disk full')

        monkeypatch.setattr(ms, 'save_workbench_session_sot', boom)
        monkeypatch.setattr(ms, 'init', lambda: None)

        session = WorkbenchSession(id='s2')
        ok, err = dur.flush_session_barrier(session, dur.BARRIER_STEP_BOUNDARY)
        assert ok is False
        assert 'disk full' in err


class TestCrashRecovery:
    def _blob(self, turnOpen: bool) -> dict[str, object]:
        return {
            'id': 's3',
            'title': 't',
            'status': 'streaming',
            'turnOpen': turnOpen,
            'messages': [{'role': 'user', 'content': 'do the thing'}],
        }

    def testOrphanedOpenTurnClosedWithMarker(self) -> None:
        s = WorkbenchSession.fromDict(self._blob(True))
        assert s.turnOpen is False
        assert s.status == 'idle'
        assert len(s.messages) == 2
        marker = s.messages[-1]
        assert marker.get('interrupted') is True
        assert '[interrupted]' in str(marker.get('content'))
        # Original transcript is never truncated.
        assert s.messages[0] == {'role': 'user', 'content': 'do the thing'}

    def testCleanLoadUntouched(self) -> None:
        s = WorkbenchSession.fromDict(self._blob(False))
        assert s.turnOpen is False
        assert s.status == 'streaming'  # status preserved when no recovery
        assert len(s.messages) == 1

    def testRoundTripAfterRecoveryIsStable(self) -> None:
        s = WorkbenchSession.fromDict(self._blob(True))
        s2 = WorkbenchSession.fromDict(s.toDict())
        # Recovery must not stack markers on repeated loads.
        assert len(s2.messages) == 2
