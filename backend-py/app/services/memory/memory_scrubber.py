"""Memory write scrubbing — refuse or drop credential-like content.

The model-facing memory tools and the background reflection both persist
user-derived text; secrets the model read from the workspace must never
land in long-lived memory. This module reuses the hook layer's secret
patterns and applies them on the memory WRITE path. User-added memories
(via the UI / API, ``source='user'``) are the user's own choice and are
not scanned.
"""

from __future__ import annotations

from app.services.hooks.secret_guard import scan_secrets


def find_secrets(text: str) -> list[str]:
    """Return labels of secret patterns found in ``text`` (never the values)."""
    return scan_secrets(text)


def refuse_reason(text: str) -> str | None:
    """Human-readable refusal reason when ``text`` contains secrets, else None."""
    found = scan_secrets(text)
    if not found:
        return None
    return (
        'Refused: memory content contains a credential pattern '
        f'({", ".join(found)}). Store credentials in provider settings, not memory.'
    )


def emit_scrub_event(layer: str = 'auto_memory') -> None:
    """Brain event noting a skipped memory write (no content — never echo secrets)."""
    try:
        from app.services.brain_event_bus import emitBrainEvent

        emitBrainEvent(
            category='memory',
            layer=f'memory_scrubber.{layer}',
            summary='Skipped memory write: content contains a credential pattern',
        )
    except Exception:
        pass
