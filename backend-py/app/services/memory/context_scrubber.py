"""
Context scrubber — streaming state machine that strips <memory_context> blocks
from text output. Prevents raw memory content from leaking to the UI.

Port of backend/services/memory/context-scrubber.js (189 lines).
"""

from __future__ import annotations

import re

# ── Constants ─────────────────────────────────────────────────────────

_PATTERN = re.compile(r"<memory_context>.*?</memory_context>", re.DOTALL)


def strip_memory_blocks(text: str) -> str:
    """Strip all <memory_context>...</memory_context> blocks from text.

    Batch operation — replaces all occurrences at once. Use for complete text
    where all tags are known to be paired.
    """
    return _PATTERN.sub("", text)


# ── Streaming state machine ──────────────────────────────────────────

OUTSIDE = 0
INSIDE = 1


class ContextScrubber:
    """Streaming state machine that strips <memory_context> blocks on-the-fly.

    Use feed() for incremental text chunks (SSE streaming).
    Use the strip_memory_blocks() function for batch text cleanup.
    """

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._state = OUTSIDE
        self._buffer = ""

    def feed(self, chunk: str) -> str:
        """Feed a text chunk through the scrubber.

        Returns cleaned text. Content inside <memory_context> tags
        is stripped.
        """
        if not chunk:
            return ""

        self._buffer += chunk
        return self._process_buffer()

    def flush(self) -> str:
        """Flush any remaining buffered text."""
        remaining = self._buffer
        self._buffer = ""
        if self._state == INSIDE:
            return ""
        return remaining

    def _process_buffer(self) -> str:
        """Process the buffer and return cleaned output."""
        output = ""
        processed = ""

        if self._state == OUTSIDE:
            # Find opening tags in the buffer
            while True:
                idx = self._buffer.find("<memory_context>")
                if idx == -1:
                    # No tag found — emit everything except maybe a partial tag at the end
                    # Check if the buffer ends with a partial opening
                    partial_idx = self._buffer.rfind("<")
                    if partial_idx > 0 and "<memory_context>" not in self._buffer[partial_idx:]:
                        partial_idx = -1

                    if partial_idx >= 0:
                        # Could be start of a tag — buffer it
                        output += self._buffer[:partial_idx]
                        self._buffer = self._buffer[partial_idx:]
                    else:
                        output += self._buffer
                        self._buffer = ""
                    break

                # Emit everything before the tag
                output += self._buffer[:idx]
                self._buffer = self._buffer[idx:]
                # Find the closing tag
                close_idx = self._buffer.find("</memory_context>")
                if close_idx == -1:
                    # Opening tag without closing — enter INSIDE state
                    self._state = INSIDE
                    self._buffer = self._buffer[len("<memory_context>"):]
                    break
                else:
                    # Complete block — strip everything including closing tag
                    self._buffer = self._buffer[close_idx + len("</memory_context>"):]

            processed = output

        elif self._state == INSIDE:
            # Look for closing tag
            while True:
                close_idx = self._buffer.find("</memory_context>")
                if close_idx == -1:
                    # Stay inside, buffer everything
                    processed = ""
                    break
                else:
                    # Found closing tag — transition to outside
                    remaining = self._buffer[close_idx + len("</memory_context>"):]
                    self._buffer = remaining
                    self._state = OUTSIDE
                    # Re-process the remaining buffer
                    processed = self._process_buffer()
                    break

        return processed
