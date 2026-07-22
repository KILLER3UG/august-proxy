"""Deterministic per-turn signals that require no LLM inference.

Tracks tool failures per tool name (not a global counter). When a specific
tool's failure count crosses the threshold, saves a targeted heuristic naming
that tool and the failure pattern — e.g. "web_search failed 4 times recently
— check network/API key configuration".

This replaces the old self_evolution.py tool-failure detection which was:
1. A global counter (not per-tool)
2. Saved a vague "High tool failure rate: N errors" memory
3. Did not name the specific tool that was failing

The per-tool approach gives the model actionable information it cannot
infer on its own (each session starts with fresh context, so cross-session
patterns are invisible without persistent tracking).
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)

_TOOL_FAILURE_THRESHOLD = 3
_failure_counts: dict[str, int] = {}


def trackToolFailure(toolName: str, error: str = '') -> None:
    """Called by tool executor on each tool error. Tracks per-tool counts.

    When a specific tool crosses the threshold, saves a targeted heuristic
    naming that tool. Only fires once per tool per threshold crossing
    (at count == threshold) to avoid spamming heuristics.
    """
    if not toolName:
        return
    _failure_counts[toolName] = _failure_counts.get(toolName, 0) + 1
    count = _failure_counts[toolName]
    if count == _TOOL_FAILURE_THRESHOLD:
        try:
            from app.services.heuristics_service import addHeuristic

            rule = f'{toolName} failed {count} times recently - check configuration or API key'
            added = addHeuristic(rule, source='deterministic-signal', category='tool_reliability')
            if added is not None:
                log.info('deterministic_signals: saved tool failure heuristic for %s', toolName)
                try:
                    from app.services.brain_event_bus import emitBrainEvent

                    emitBrainEvent(
                        category='heuristic',
                        layer='deterministic_signals.track_tool_failure',
                        summary=f'Tool failure pattern detected: {toolName} ({count} failures)',
                        meta={'tool': toolName, 'count': count, 'error_sample': error[:200]},
                    )
                except Exception:
                    pass
        except Exception as exc:
            log.debug('deterministic_signals: failed to save heuristic: %s', exc)


def resetCounts() -> None:
    """Reset failure counts. Called at session start."""
    _failure_counts.clear()


def getCounts() -> dict[str, int]:
    """Return current failure counts (for debugging/dashboard)."""
    return dict(_failure_counts)
