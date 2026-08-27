"""
ToolCallTracker — loop and failure guardrails for tool calls (Phase 6).

Port of backend/services/security/tool-guardrails.js, reworked by T16(a)
(plan §9.4, audit 2026-08-27): the identical-call doom-loop rule is now
advisory within a run — reminders at cumulative counts 3/5/8 carrying a
preview of the repeated args, never blocking, reset on any new user
message — plus a nudge/break for loops that repeat ACROSS turns (a call
re-issued after a user-message boundary that was already issued before
it: warn on the first re-issue, block on the second). Alternating
ping-pong detection and same-tool failure counts still block — those are
distinct failure classes the advisory rule does not cover.
"""

from __future__ import annotations

import time
from collections import defaultdict


class ToolCallTracker:
    """Tracks tool-call patterns to detect loops and failure spirals.

    Thread-safe per-session instance. Usage:

        tracker = ToolCallTracker()
        result = tracker.check("read_file", {"path": "foo.py"})
        # result: ("ok", "") | ("warn", "message") | ("block", "message")
    """

    def __init__(self) -> None:
        self._callSequence: list[tuple[str, str, float]] = []
        self._runTotals: dict[tuple[str, str], int] = defaultdict(int)
        self._priorTurnCalls: set[tuple[str, str]] = set()
        self._crossTurnStrikes: dict[tuple[str, str], int] = defaultdict(int)
        self._failureCount: defaultdict[str, int] = defaultdict(int)
        self._lastTextResponse: float = time.monotonic()

    # Within-run identical-call reminders: advisory only, never blocking.
    ADVISORY_COUNTS = (3, 5, 8)
    ARG_PREVIEW_CHARS = 500
    WARN_ALTERNATING = 8
    BLOCK_ALTERNATING = 10
    WARN_FAILURE = 4
    BLOCK_FAILURE = 8
    # Bound the cross-turn memory so a very long session cannot grow it
    # without limit; losing old history is acceptable.
    _PRIOR_TURN_CAP = 2000

    def check(self, toolName: str, arguments: dict[str, object]) -> tuple[str, str]:
        """Check a tool call against the guardrails.

        Returns (status, message):
            ("ok", "") — call is allowed
            ("warn", "msg") — call is allowed but with a warning
            ("block", "msg") — call is blocked
        """
        argsHash = self._hashArgs(arguments)
        key = (toolName, argsHash)
        now = time.monotonic()
        self._callSequence.append((toolName, argsHash, now))
        if len(self._callSequence) > 50:
            self._callSequence = self._callSequence[-50:]

        # Cross-turn loop (T16a): the same (tool, args) re-issued after a
        # user-message boundary already ran before it — the previous
        # attempt(s) did not advance the task. Nudge once, then break.
        if key in self._priorTurnCalls:
            self._crossTurnStrikes[key] += 1
            if self._crossTurnStrikes[key] >= 2:
                return (
                    'block',
                    f"Blocked: '{toolName}' with identical arguments keeps repeating across "
                    'turns. The previous attempts did not advance the task — take a '
                    'different approach or report the blocker instead of retrying.',
                )
            return (
                'warn',
                f"Warning: '{toolName}' with these exact arguments was already issued in a "
                'previous turn. If it failed then, retrying unchanged will fail again — '
                'change the approach or the arguments.',
            )

        # Within-run identical-call reminders (T16a): advisory at 3/5/8,
        # never blocking; counters reset on any new user message.
        self._runTotals[key] += 1
        count = self._runTotals[key]
        if count in self.ADVISORY_COUNTS:
            preview = argsHash[: self.ARG_PREVIEW_CHARS]
            return (
                'warn',
                f"Warning: '{toolName}' called with identical arguments {count} times this "
                f'run (args: {preview}). Repeating the same call rarely changes the '
                'outcome — check the result you already got, then try a different step.',
            )

        # Alternating ping-pong (OpenHands stuck-detector pattern): the
        # identical-call detector only catches repeats of ONE call — a model
        # oscillating read_file(a)/read_file(b)/read_file(a) never trips it.
        altRun, toneA, toneB = self._alternating_run()
        if altRun >= self.BLOCK_ALTERNATING:
            return (
                'block',
                f'Blocked: alternating between the same two calls {altRun} times in a row '
                f'({toneA} ↔ {toneB}). Try a different approach.',
            )
        if altRun >= self.WARN_ALTERNATING:
            return (
                'warn',
                f'Warning: alternating between the same two calls {altRun} times in a row '
                f'({toneA} ↔ {toneB}).',
            )
        failCount = self._failureCount.get(toolName, 0)
        if failCount >= self.BLOCK_FAILURE:
            return ('block', f"Blocked: '{toolName}' has failed {failCount} times. Try a different approach.")
        if failCount >= self.WARN_FAILURE:
            return ('warn', f"Warning: '{toolName}' has failed {failCount} times.")
        return ('ok', '')

    def _alternating_run(self) -> tuple[int, str, str]:
        """Length of the trailing A,B,A,B… run, plus the two tone labels.

        Returns ``(run, toneA, toneB)`` — ``run`` counts trailing calls that
        strictly alternate between two distinct (tool, args-hash) tones;
        ``(0, '', '')`` when no alternation is present.
        """
        seq = self._callSequence
        if len(seq) < 4:
            return (0, '', '')
        toneA = f'{seq[-1][0]}'
        toneB = ''
        for name, __, _t in reversed(seq[:-1]):
            if name != seq[-1][0]:
                toneB = name
                break
        if not toneB:
            return (0, '', '')
        run = 0
        for name, __, _t in reversed(seq):
            if run % 2 == 0:
                if name != toneA:
                    break
            else:
                if name != toneB:
                    break
            run += 1
        return (run, toneA, toneB)

    def record_failure(self, toolName: str) -> None:
        """Record a tool failure (call returned an error)."""
        self._failureCount[toolName] += 1

    def _handOffTurnHistory(self) -> None:
        """Calls seen so far become prior-turn history for cross-turn
        detection, then the within-run counters reset."""
        self._priorTurnCalls.update(self._runTotals.keys())
        if len(self._priorTurnCalls) > self._PRIOR_TURN_CAP:
            self._priorTurnCalls.clear()
            self._crossTurnStrikes.clear()
        self._runTotals.clear()
        self._callSequence.clear()

    def record_user_message(self) -> None:
        """A new user message arrived: within-run reminders reset (T16a),
        but the turn's calls stay known so a loop repeating across the
        boundary gets nudged, then broken."""
        self._handOffTurnHistory()

    def record_text_response(self) -> None:
        """Record that the model produced a text response (not a tool call).

        Resets the within-run trackers — the model is back to reasoning
        mode, not stuck in a loop — after handing the turn's calls to the
        cross-turn history.
        """
        self._handOffTurnHistory()
        self._failureCount.clear()
        self._lastTextResponse = time.monotonic()

    def get_stats(self) -> dict[str, object]:
        """Return current tracker stats for debugging."""
        return {
            'sequence_length': len(self._callSequence),
            'failure_counts': dict(self._failureCount),
            'prior_turn_calls': len(self._priorTurnCalls),
            'cross_turn_strikes': dict(
                (f'{name}:{ah[:40]}', n) for (name, ah), n in self._crossTurnStrikes.items()
            ),
            'last_text_response_ago': time.monotonic() - self._lastTextResponse,
        }

    @staticmethod
    def _hashArgs(args: dict[str, object]) -> str:
        """Create a stable hash of tool arguments for comparison."""
        import json

        return json.dumps(args, sort_keys=True, ensure_ascii=False)
