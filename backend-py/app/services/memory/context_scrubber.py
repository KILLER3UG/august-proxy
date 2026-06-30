"""
Context scrubber — streaming state machine that strips <memory_context> blocks
from text output. Prevents raw memory content from leaking to the UI.

Port of backend/services/memory/context-scrubber.js (189 lines).
"""
from __future__ import annotations
import re
_PATTERN = re.compile('<memory_context>.*?</memory_context>', re.DOTALL)

def stripMemoryBlocks(text: str) -> str:
    """Strip all <memory_context>...</memory_context> blocks from text.

    Batch operation — replaces all occurrences at once. Use for complete text
    where all tags are known to be paired.
    """
    return _PATTERN.sub('', text)
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
        self._buffer = ''

    def feed(self, chunk: str) -> str:
        """Feed a text chunk through the scrubber.

        Returns cleaned text. Content inside <memory_context> tags
        is stripped.
        """
        if not chunk:
            return ''
        self._buffer += chunk
        return self._processBuffer()

    def flush(self) -> str:
        """Flush any remaining buffered text."""
        remaining = self._buffer
        self._buffer = ''
        if self._state == INSIDE:
            return ''
        return remaining

    def _processBuffer(self) -> str:
        """Process the buffer and return cleaned output."""
        output = ''
        processed = ''
        if self._state == OUTSIDE:
            while True:
                idx = self._buffer.find('<memory_context>')
                if idx == -1:
                    partialIdx = self._buffer.rfind('<')
                    if partialIdx > 0 and '<memory_context>' not in self._buffer[partialIdx:]:
                        partialIdx = -1
                    if partialIdx >= 0:
                        output += self._buffer[:partialIdx]
                        self._buffer = self._buffer[partialIdx:]
                    else:
                        output += self._buffer
                        self._buffer = ''
                    break
                output += self._buffer[:idx]
                self._buffer = self._buffer[idx:]
                closeIdx = self._buffer.find('</memory_context>')
                if closeIdx == -1:
                    self._state = INSIDE
                    self._buffer = self._buffer[len('<memory_context>'):]
                    break
                else:
                    self._buffer = self._buffer[closeIdx + len('</memory_context>'):]
            processed = output
        elif self._state == INSIDE:
            while True:
                closeIdx = self._buffer.find('</memory_context>')
                if closeIdx == -1:
                    processed = ''
                    break
                else:
                    remaining = self._buffer[closeIdx + len('</memory_context>'):]
                    self._buffer = remaining
                    self._state = OUTSIDE
                    processed = self._processBuffer()
                    break
        return processed