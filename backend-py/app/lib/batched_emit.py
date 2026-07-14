"""Coalesce streaming ``finalOutput`` text chunks without delaying first token.

The first content event flushes immediately so time-to-first-token stays low.
Later ``finalOutput`` text chunks are merged until a non-text event, size
threshold, or explicit flush (done / error / toolCall).
"""

from __future__ import annotations

from collections.abc import Callable

EmitFn = Callable[[dict[str, object]], None]


class BatchedEmit:
    """Sync emit wrapper — safe for workbench's sync emit callback."""

    def __init__(
        self,
        emit: EmitFn | None,
        *,
        max_chars: int = 256,
        on_first_content: Callable[[], None] | None = None,
    ) -> None:
        self._emit = emit
        self._max_chars = max_chars
        self._on_first = on_first_content
        self._buf: list[str] = []
        self._buf_chars = 0
        self._seen_content = False

    def __call__(self, ev: dict[str, object]) -> None:
        if self._emit is None:
            return
        t = ev.get('type')
        if t == 'finalOutput' and isinstance(ev.get('content'), str):
            text = str(ev.get('content') or '')
            if not self._seen_content:
                self._seen_content = True
                if self._on_first:
                    self._on_first()
                # TTFT: first chunk immediately
                self._emit(ev)
                return
            self._buf.append(text)
            self._buf_chars += len(text)
            if self._buf_chars >= self._max_chars:
                self.flush_text()
            return
        # Any other event flushes pending text first
        self.flush_text()
        if t in ('thinking', 'toolCall') and not self._seen_content:
            self._seen_content = True
            if self._on_first:
                self._on_first()
        self._emit(ev)

    def flush_text(self) -> None:
        if not self._buf or self._emit is None:
            return
        merged = ''.join(self._buf)
        self._buf.clear()
        self._buf_chars = 0
        if merged:
            self._emit({'type': 'finalOutput', 'content': merged})

    def flush(self) -> None:
        self.flush_text()
