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

    def __init__(self):
        self._callSequence: list[tuple[str, str, float]] = []
        self._failureCount: defaultdict[str, int] = defaultdict(int)
        self._lastTextResponse: float = time.monotonic()
    WARN_IDENTICAL = 3
    BLOCK_IDENTICAL = 6
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
            return ('block', f"Blocked: '{toolName}' called with identical arguments {identicalCount} times. Try a different approach.")
        if identicalCount >= self.WARN_IDENTICAL:
            return ('warn', f"Warning: '{toolName}' called with identical arguments {identicalCount} times in a row.")
        failCount = self._failureCount.get(toolName, 0)
        if failCount >= self.BLOCK_FAILURE:
            return ('block', f"Blocked: '{toolName}' has failed {failCount} times. Try a different approach.")
        if failCount >= self.WARN_FAILURE:
            return ('warn', f"Warning: '{toolName}' has failed {failCount} times.")
        return ('ok', '')

    def recordFailure(self, toolName: str) -> None:
        """Record a tool failure (call returned an error)."""
        self._failureCount[toolName] += 1

    def recordTextResponse(self) -> None:
        """Record that the model produced a text response (not a tool call).

        Resets the call sequence tracker — the model is back to reasoning
        mode, not stuck in a loop.
        """
        self._callSequence.clear()
        self._failureCount.clear()
        self._lastTextResponse = time.monotonic()

    def getStats(self) -> dict[str, object]:
        """Return current tracker stats for debugging."""
        return {'sequence_length': len(self._callSequence), 'failure_counts': dict(self._failureCount), 'last_text_response_ago': time.monotonic() - self._lastTextResponse}

    @staticmethod
    def _hashArgs(args: dict[str, object]) -> str:
        """Create a stable hash of tool arguments for comparison."""
        import json
        return json.dumps(args, sort_keys=True, ensure_ascii=False)