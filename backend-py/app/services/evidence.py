"""Evidence states — classify whether agent claims are verified.

Part of Better Harness Plan Phase 3.5.
States: verified (test/lint ran after mutation), unverified (mutation, no verification),
read_only (no mutations in turn).
"""

from __future__ import annotations

import re
from enum import Enum

# Tools that mutate the filesystem
_MUTATING_TOOLS = re.compile(
    r'^(write_file|edit_file|create_file|delete_file|move_file|run_command)$'
)

# Commands/patterns that indicate verification
_VERIFICATION_PATTERNS = re.compile(
    r'(pytest|vitest|jest|npm test|uv run pytest|cargo test|go test'
    r'|ruff|mypy|eslint|tsc|typecheck|lint'
    r'|make test|make check|npm run check)',
    re.I,
)


class EvidenceState(str, Enum):
    VERIFIED = 'verified'
    UNVERIFIED = 'unverified'
    READ_ONLY = 'read_only'


class TurnEvidenceTracker:
    """Track evidence state across a single assistant turn's tool calls.

    Usage:
        tracker = TurnEvidenceTracker()
        tracker.record_tool('write_file', {'path': '...'})
        tracker.record_tool('run_command', {'command': 'pytest'})
        state = tracker.classify()  # EvidenceState.VERIFIED
    """

    def __init__(self) -> None:
        self._had_mutation = False
        self._had_verification_after_mutation = False
        self._verification_tool: str | None = None
        self._verification_output: str | None = None

    def record_tool(self, tool_name: str, args: dict | None = None, result: str | None = None) -> None:
        """Record a tool execution in sequence."""
        is_mutation = bool(_MUTATING_TOOLS.match(tool_name))

        # run_command is only a mutation if it's not a verification command
        if tool_name == 'run_command' and args:
            cmd = str(args.get('command', ''))
            if _VERIFICATION_PATTERNS.search(cmd):
                # This is verification, not mutation
                if self._had_mutation:
                    self._had_verification_after_mutation = True
                    self._verification_tool = tool_name
                    self._verification_output = (result or '')[:200]
                return
            else:
                is_mutation = True

        if is_mutation:
            self._had_mutation = True
            # Reset verification — must come AFTER mutation
            self._had_verification_after_mutation = False
            self._verification_tool = None

    def classify(self) -> EvidenceState:
        """Classify the evidence state for this turn."""
        if not self._had_mutation:
            return EvidenceState.READ_ONLY
        if self._had_verification_after_mutation:
            return EvidenceState.VERIFIED
        return EvidenceState.UNVERIFIED

    def to_dict(self) -> dict:
        """Serialize for SSE emission."""
        state = self.classify()
        return {
            'type': 'evidenceState',
            'state': state.value,
            'verificationTool': self._verification_tool,
            'verificationOutput': self._verification_output,
        }
