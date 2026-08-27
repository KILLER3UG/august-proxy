"""T16 guardrail pack (plan §9.4) — unit tests.

Covers:
  (a) ToolCallTracker rework: advisory identical-call reminders at 3/5/8
      (never blocking within a run), cross-turn nudge/break, reset on user
      messages, alternating + failure blocks retained.
  (c) _truncateToolOutput: JSON-aware cut plus the single-line overrun
      guard (never returns empty/near-empty when one line exceeds the cap).
  (d) _isRetryableModelError: deterministic 400s (orphaned tool-use id,
      malformed message structure) are never retryable.
"""

from __future__ import annotations

import pytest
from app.services.workbench import workbench as wb
from app.services.workbench.tool_guardrails import ToolCallTracker


class TestIdenticalCallAdvisories:
    def testFirstTwoCallsPassSilently(self):
        t = ToolCallTracker()
        assert t.check('read_file', {'path': 'a.py'})[0] == 'ok'
        assert t.check('read_file', {'path': 'a.py'})[0] == 'ok'

    def testAdvisoriesAtThreeFiveEight(self):
        t = ToolCallTracker()
        statuses = []
        for _ in range(9):
            status, msg = t.check('read_file', {'path': 'a.py'})
            statuses.append(status)
        assert statuses[2] == 'warn'  # 3rd call
        assert statuses[4] == 'warn'  # 5th call
        assert statuses[7] == 'warn'  # 8th call
        # Calls 4, 6, 7, 9 are silent; NONE are blocked within a run.
        assert statuses[3] == 'ok'
        assert statuses[5] == 'ok'
        assert statuses[8] == 'ok'
        assert 'block' not in statuses

    def testAdvisoryCarriesArgPreview(self):
        t = ToolCallTracker()
        for _ in range(2):
            t.check('run_command', {'command': 'pytest -q'})
        status, msg = t.check('run_command', {'command': 'pytest -q'})
        assert status == 'warn'
        assert 'pytest -q' in msg

    def testDifferentArgsDoNotAccumulate(self):
        t = ToolCallTracker()
        for i in range(10):
            status, _ = t.check('read_file', {'path': f'file_{i}.py'})
            assert status == 'ok'

    def testUserMessageResetsAdvisories(self):
        t = ToolCallTracker()
        for _ in range(3):
            t.check('read_file', {'path': 'a.py'})
        t.record_user_message()
        # The 3/5/8 counters restart: a fresh call is silent again...
        assert t.check('read_file', {'path': 'other.py'})[0] == 'ok'
        assert t.check('read_file', {'path': 'other.py'})[0] == 'ok'
        # ...while re-issuing the pre-boundary call is the cross-turn nudge.
        status, msg = t.check('read_file', {'path': 'a.py'})
        assert status == 'warn'
        assert 'previous turn' in msg


class TestCrossTurnLoop:
    def testReissueAfterUserMessageNudgesThenBreaks(self):
        t = ToolCallTracker()
        assert t.check('run_command', {'command': 'npm test'})[0] == 'ok'
        t.record_user_message()
        # First re-issue across the boundary: advisory nudge, still runs.
        status, msg = t.check('run_command', {'command': 'npm test'})
        assert status == 'warn'
        assert 'previous turn' in msg
        # Second re-issue: break.
        status, msg = t.check('run_command', {'command': 'npm test'})
        assert status == 'block'
        assert 'across' in msg

    def testTextResponseAlsoHandsOffTurnHistory(self):
        t = ToolCallTracker()
        assert t.check('read_file', {'path': 'a.py'})[0] == 'ok'
        t.record_text_response()
        status, _ = t.check('read_file', {'path': 'a.py'})
        assert status == 'warn'  # cross-turn nudge

    def testFreshCallAfterBoundaryIsUnaffected(self):
        t = ToolCallTracker()
        t.check('read_file', {'path': 'a.py'})
        t.record_user_message()
        assert t.check('read_file', {'path': 'b.py'})[0] == 'ok'


class TestRetainedBlocks:
    def testAlternatingPingPongStillBlocks(self):
        t = ToolCallTracker()
        statuses = []
        for _ in range(10):
            statuses.append(t.check('read_file', {'path': 'a.py'})[0])
            statuses.append(t.check('write_file', {'path': 'a.py', 'content': 'x'})[0])
        assert 'block' in statuses

    def testFailureSpiralStillBlocks(self):
        t = ToolCallTracker()
        for _ in range(8):
            t.record_failure('web_fetch')
        status, _ = t.check('web_fetch', {'url': 'https://example.com'})
        assert status == 'block'


class TestTruncateToolOutput:
    def testUnderCapUntouched(self):
        text, truncated = wb._truncateToolOutput('hello', 100)
        assert text == 'hello'
        assert truncated is False

    def testPrefersNewlineBoundary(self):
        text = 'line one\n' + 'x' * 200
        trimmed, truncated = wb._truncateToolOutput(text, 50)
        assert truncated is True
        assert trimmed == 'line one'

    def testSingleLineOverrunNeverEmpty(self):
        """T16(c): one line longer than the budget must not truncate to
        empty or near-empty — the hard cut wins."""
        text = 'X' * 10_000  # no newlines, no JSON boundary
        trimmed, truncated = wb._truncateToolOutput(text, 1024)
        assert truncated is True
        assert len(trimmed) == 1024  # full hard cut, nothing dropped silently

    def testSingleLineWithEarlyNewlineFallsBackToHardCut(self):
        # Newline at position 5 is the only boundary — cutting there would
        # leave almost nothing, so the guard falls back to the hard cut.
        text = 'head\n' + 'Y' * 10_000
        trimmed, truncated = wb._truncateToolOutput(text, 1024)
        assert truncated is True
        assert len(trimmed) == 1024

    def testJsonBoundaryCut(self):
        text = '{"a": 1,' * 200 + '}'
        trimmed, truncated = wb._truncateToolOutput(text, 100)
        assert truncated is True
        # Cut at the last ',' inside the budget (index 95), not the hard
        # 100-char cut — the boundary char itself is excluded.
        assert len(trimmed) == 95
        assert trimmed == '{"a": 1,' * 11 + '{"a": 1'


class TestDeterministic400Classification:
    def _err(self, msg: str, status: int | None) -> dict[str, object]:
        out: dict[str, object] = {'error': msg}
        if status is not None:
            out['errorStatus'] = status
        return out

    def testOrphanedToolUseIdIsNeverRetryable(self):
        resp = self._err('Invalid parameter: messages.20.content.1.tool_use_id: no matching tool_use found', 400)
        assert wb._isRetryableModelError(resp) is False

    def testMalformedMessageStructureIsNeverRetryable(self):
        assert wb._isRetryableModelError(self._err('messages must alternate between user and assistant', 400)) is False
        assert wb._isRetryableModelError(self._err('unexpected role "tool" in messages', 400)) is False

    def testDeterministic400NotRescuedByTransientMarker(self):
        # Even though the message contains "timeout" (a retry marker), the
        # deterministic-400 classification wins.
        resp = self._err('tool_call_id orphaned after request timeout', 400)
        assert wb._isRetryableModelError(resp) is False

    def testOrdinary400WithTransientMarkerStillRetries(self):
        resp = self._err('upstream timeout while contacting gateway', 400)
        assert wb._isRetryableModelError(resp) is True

    def testRateLimitAnd5xxStillRetry(self):
        assert wb._isRetryableModelError(self._err('rate limit exceeded', 429)) is True
        assert wb._isRetryableModelError(self._err('bad gateway', 502)) is True

    def testQuotaStillNeverRetries(self):
        assert wb._isRetryableModelError(self._err('insufficient_quota', 429)) is False
        assert wb._isRetryableModelError(self._err('payment required', 402)) is False
