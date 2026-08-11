"""
ToolCallTracker — loop and failure guardrails for tool calls (Phase 6).

Port of backend/services/security/tool-guardrails.js.

Tracks:
- Identical tool-call sequences: warn at 3 identical calls, block at 6
- Same-tool failure patterns: warn at 4 failures on the same tool, block at 8
- Reset tracker state when the model produces a text response (not just tool calls)
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
        self._failureCount: defaultdict[str, int] = defaultdict(int)
        self._lastTextResponse: float = time.monotonic()

    WARN_IDENTICAL = 3
    BLOCK_IDENTICAL = 6
    WARN_ALTERNATING = 8
    BLOCK_ALTERNATING = 10
    WARN_FAILURE = 4
    BLOCK_FAILURE = 8

    def check(self, toolName: str, arguments: dict[str, object]) -> tuple[str, str]:
        """Check a tool call against the guardrails.

        Returns (status, message):
            ("ok", "") — call is allowed
            ("warn", "msg") — call is allowed but with a warning
            ("block", "msg") — call is blocked
        """
        argsHash = self._hashArgs(arguments)
        now = time.monotonic()
        self._callSequence.append((toolName, argsHash, now))
        if len(self._callSequence) > 50:
            self._callSequence = self._callSequence[-50:]
        identicalCount = 0
        for name, ah, __ in reversed(self._callSequence):
            if name == toolName and ah == argsHash:
                identicalCount += 1
            else:
                break
        if identicalCount >= self.BLOCK_IDENTICAL:
            return (
                'block',
                f"Blocked: '{toolName}' called with identical arguments {identicalCount} times. Try a different approach.",
            )
        if identicalCount >= self.WARN_IDENTICAL:
            return ('warn', f"Warning: '{toolName}' called with identical arguments {identicalCount} times in a row.")
        # Alternating ping-pong (OpenHands stuck-detector pattern): the
        # identical-call detector only catches CONTIGUOUS repeats — a model
        # oscillating read_file(a)/read_file(b)/read_file(a) never trips it.
        altRun, toneA, toneB = self._alternating_run()
        if altRun >= self.BLOCK_ALTERNATING:
            return (
                'block',
                f"Blocked: alternating between the same two calls {altRun} times in a row "
                f"({toneA} ↔ {toneB}). Try a different approach.",
            )
        if altRun >= self.WARN_ALTERNATING:
            return (
                'warn',
                f"Warning: alternating between the same two calls {altRun} times in a row "
                f"({toneA} ↔ {toneB}).",
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

    def record_text_response(self) -> None:
        """Record that the model produced a text response (not a tool call).

        Resets the call sequence tracker — the model is back to reasoning
        mode, not stuck in a loop.
        """
        self._callSequence.clear()
        self._failureCount.clear()
        self._lastTextResponse = time.monotonic()

    def get_stats(self) -> dict[str, object]:
        """Return current tracker stats for debugging."""
        return {
            'sequence_length': len(self._callSequence),
            'failure_counts': dict(self._failureCount),
            'last_text_response_ago': time.monotonic() - self._lastTextResponse,
        }

    @staticmethod
    def _hashArgs(args: dict[str, object]) -> str:
        """Create a stable hash of tool arguments for comparison."""
        import json

        return json.dumps(args, sort_keys=True, ensure_ascii=False)
