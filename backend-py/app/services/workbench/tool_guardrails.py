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
from typing import Any


class ToolCallTracker:
    """Tracks tool-call patterns to detect loops and failure spirals.

    Thread-safe per-session instance. Usage:

        tracker = ToolCallTracker()
        result = tracker.check("read_file", {"path": "foo.py"})
        # result: ("ok", "") | ("warn", "message") | ("block", "message")
    """

    def __init__(self):
        # call_sequence: list of (name, args_hash, timestamp)
        self._call_sequence: list[tuple[str, str, float]] = []
        # failure_count: name → count
        self._failure_count: defaultdict[str, int] = defaultdict(int)
        # last_text_response: timestamp of last text response
        self._last_text_response: float = time.monotonic()

    # ── Configuration ───────────────────────────────────────────────────

    WARN_IDENTICAL = 3
    BLOCK_IDENTICAL = 6
    WARN_FAILURE = 4
    BLOCK_FAILURE = 8

    # ── Public API ──────────────────────────────────────────────────────

    def check(self, tool_name: str, arguments: dict[str, Any]) -> tuple[str, str]:
        """Check a tool call against the guardrails.

        Returns (status, message):
            ("ok", "") — call is allowed
            ("warn", "msg") — call is allowed but with a warning
            ("block", "msg") — call is blocked
        """
        args_hash = self._hash_args(arguments)
        now = time.monotonic()

        # Record the call
        self._call_sequence.append((tool_name, args_hash, now))

        # Trim sequence to last 50 calls (memory bound)
        if len(self._call_sequence) > 50:
            self._call_sequence = self._call_sequence[-50:]

        # Check identical call sequence (same tool + same args)
        identical_count = 0
        for name, ah, _ in reversed(self._call_sequence):
            if name == tool_name and ah == args_hash:
                identical_count += 1
            else:
                break

        if identical_count >= self.BLOCK_IDENTICAL:
            return ("block", f"Blocked: '{tool_name}' called with identical arguments {identical_count} times. Try a different approach.")
        if identical_count >= self.WARN_IDENTICAL:
            return ("warn", f"Warning: '{tool_name}' called with identical arguments {identical_count} times in a row.")

        # Check same-tool failure pattern
        fail_count = self._failure_count.get(tool_name, 0)
        if fail_count >= self.BLOCK_FAILURE:
            return ("block", f"Blocked: '{tool_name}' has failed {fail_count} times. Try a different approach.")
        if fail_count >= self.WARN_FAILURE:
            return ("warn", f"Warning: '{tool_name}' has failed {fail_count} times.")

        return ("ok", "")

    def record_failure(self, tool_name: str) -> None:
        """Record a tool failure (call returned an error)."""
        self._failure_count[tool_name] += 1

    def record_text_response(self) -> None:
        """Record that the model produced a text response (not a tool call).

        Resets the call sequence tracker — the model is back to reasoning
        mode, not stuck in a loop.
        """
        self._call_sequence.clear()
        self._failure_count.clear()
        self._last_text_response = time.monotonic()

    def get_stats(self) -> dict[str, Any]:
        """Return current tracker stats for debugging."""
        return {
            "sequence_length": len(self._call_sequence),
            "failure_counts": dict(self._failure_count),
            "last_text_response_ago": time.monotonic() - self._last_text_response,
        }

    # ── Helpers ─────────────────────────────────────────────────────────

    @staticmethod
    def _hash_args(args: dict[str, Any]) -> str:
        """Create a stable hash of tool arguments for comparison."""
        import json
        return json.dumps(args, sort_keys=True, ensure_ascii=False)
