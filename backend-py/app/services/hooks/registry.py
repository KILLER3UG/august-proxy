"""Hook registry — the central dispatch for lifecycle hooks.

Hooks are registered with an event, a tool-name matcher (fnmatch pattern),
a priority (lower = runs first), and an async handler. The registry emits
events in priority order, short-circuiting on the first 'deny'.

Execution rules:
- Async handlers with a 5s timeout (fail-open on timeout).
- PRE_TOOL_USE handler exceptions fail CLOSED (returned as a deny so a broken
  security guard never silently allows a credential write); POST_TOOL_USE
  exceptions are logged only (the tool already ran).
- Circuit breaker: 3 consecutive timeouts disables a hook for 60s.
- First 'deny' short-circuits (no further hooks run for that event).
- 'modify' results chain (each hook sees previous modifications).
"""

from __future__ import annotations

import asyncio
import fnmatch
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from app.services.hooks.types import HookContext, HookEvent, HookResult

logger = logging.getLogger(__name__)

_HOOK_TIMEOUT_S = 5.0
_BREAKER_THRESHOLD = 3
_BREAKER_COOLDOWN_S = 60.0

# Events with no emission call site anywhere in the app (workbench emits only
# PRE_TOOL_USE / POST_TOOL_USE). Dispatch of these is a debug-logged no-op.
_RESERVED_NOOP_EVENTS = frozenset(
    {HookEvent.SESSION_START, HookEvent.PRE_MODEL_CALL, HookEvent.STOP}
)


@dataclass
class _HookEntry:
    name: str
    event: HookEvent
    matcher: str  # fnmatch pattern on tool_name ('*' = all)
    priority: int
    handler: Callable[[HookContext], Awaitable[HookResult]]
    # Stats
    call_count: int = 0
    deny_count: int = 0
    total_ms: float = 0.0
    max_ms: float = 0.0
    _recent_durations: list[float] = field(default_factory=list)
    # Circuit breaker
    consecutive_timeouts: int = 0
    breaker_open_until: float = 0.0

    @property
    def breaker_state(self) -> str:
        if self.breaker_open_until > time.monotonic():
            return 'open'
        if self.consecutive_timeouts > 0:
            return 'half-open'
        return 'closed'

    @property
    def p95_ms(self) -> float:
        if not self._recent_durations:
            return 0.0
        sorted_d = sorted(self._recent_durations)
        idx = int(len(sorted_d) * 0.95)
        return sorted_d[min(idx, len(sorted_d) - 1)]

    def record_duration(self, ms: float) -> None:
        self.total_ms += ms
        self.max_ms = max(self.max_ms, ms)
        self._recent_durations.append(ms)
        # Keep last 100 for p95
        if len(self._recent_durations) > 100:
            self._recent_durations = self._recent_durations[-100:]


class HookRegistry:
    """Singleton registry for lifecycle hooks."""

    def __init__(self) -> None:
        self._hooks: list[_HookEntry] = []

    def register(
        self,
        name: str,
        event: HookEvent,
        handler: Callable[[HookContext], Awaitable[HookResult]],
        matcher: str = '*',
        priority: int = 100,
    ) -> None:
        """Register a hook. Lower priority runs first.

        Duplicate names are skipped (and logged) so re-registration never
        stacks two handlers under one name — unregister removes by name, and
        stacked duplicates would otherwise all vanish together.
        """
        if any(h.name == name for h in self._hooks):
            logger.warning('Hook %s already registered — skipping duplicate', name)
            return
        entry = _HookEntry(
            name=name,
            event=event,
            matcher=matcher,
            priority=priority,
            handler=handler,
        )
        self._hooks.append(entry)
        self._hooks.sort(key=lambda h: h.priority)
        logger.debug('Hook registered: %s (%s, priority=%d)', name, event.value, priority)

    def unregister(self, name: str) -> bool:
        """Remove a hook by name. Returns True if found."""
        before = len(self._hooks)
        self._hooks = [h for h in self._hooks if h.name != name]
        return len(self._hooks) < before

    async def emit(self, event: HookEvent, ctx: HookContext) -> list[HookResult]:
        """Emit an event to all matching hooks. Returns collected results.

        Short-circuits on first 'deny'. Applies 'modify' chaining.
        """
        if event in _RESERVED_NOOP_EVENTS:
            # Reserved events: no emission call sites exist yet (the workbench
            # owns the lifecycle), so dispatch is a documented no-op. Hook
            # registrations for these events stay inert until call sites land.
            logger.debug('Hook event %s has no emission call site — no-op', event.value)
            return []
        results: list[HookResult] = []
        tool = ctx.tool_name or ''

        for entry in self._hooks:
            if entry.event != event:
                continue
            if not self._matches(entry.matcher, tool):
                continue
            # Circuit breaker check
            if entry.breaker_open_until > time.monotonic():
                logger.debug('Hook %s breaker open, skipping', entry.name)
                continue

            result = await self._run_hook(entry, ctx)
            results.append(result)

            if result.action == 'deny':
                break  # Short-circuit
            elif result.action == 'modify':
                # Chain modifications into context for next hook
                if result.modified_args is not None:
                    ctx.tool_args = result.modified_args
                if result.modified_result is not None:
                    ctx.tool_result = result.modified_result

        return results

    async def _run_hook(self, entry: _HookEntry, ctx: HookContext) -> HookResult:
        """Run a single hook with timeout and breaker logic."""
        entry.call_count += 1
        start = time.monotonic()
        try:
            result = await asyncio.wait_for(entry.handler(ctx), timeout=_HOOK_TIMEOUT_S)
            elapsed_ms = (time.monotonic() - start) * 1000
            entry.record_duration(elapsed_ms)
            entry.consecutive_timeouts = 0
            if result.action == 'deny':
                entry.deny_count += 1
            return result
        except asyncio.TimeoutError:
            elapsed_ms = (time.monotonic() - start) * 1000
            entry.record_duration(elapsed_ms)
            entry.consecutive_timeouts += 1
            logger.warning(
                'Hook %s timed out (%.0fms, %d consecutive)',
                entry.name, elapsed_ms, entry.consecutive_timeouts,
            )
            if entry.consecutive_timeouts >= _BREAKER_THRESHOLD:
                entry.breaker_open_until = time.monotonic() + _BREAKER_COOLDOWN_S
                logger.warning('Hook %s circuit breaker OPEN for %.0fs', entry.name, _BREAKER_COOLDOWN_S)
            return HookResult(action='allow')  # Fail-open
        except Exception as exc:
            elapsed_ms = (time.monotonic() - start) * 1000
            entry.record_duration(elapsed_ms)
            entry.consecutive_timeouts = 0
            logger.error('Hook %s raised: %s', entry.name, exc)
            if entry.event == HookEvent.PRE_TOOL_USE:
                # Fail-CLOSED for PRE events: pre-tool hooks are security
                # guards (secret_guard, sensitive_code), so a broken handler
                # must not silently allow a credential write. Surface the
                # failure as a deny the workbench wrapper maps to a block.
                entry.deny_count += 1
                return HookResult(
                    action='deny',
                    message=f'Hook {entry.name} failed to evaluate the call: {exc}',
                )
            # POST hooks observe an already-executed tool — a failure here
            # cannot roll the call back, so log and continue (fail-open).
            return HookResult(action='allow')

    def stats(self) -> dict[str, Any]:
        """Return per-hook stats for the /api/hooks/stats endpoint."""
        return {
            'hooks': [
                {
                    'name': h.name,
                    'event': h.event.value,
                    'matcher': h.matcher,
                    'priority': h.priority,
                    'calls': h.call_count,
                    'denies': h.deny_count,
                    'p95_ms': round(h.p95_ms, 1),
                    'max_ms': round(h.max_ms, 1),
                    'breaker_state': h.breaker_state,
                }
                for h in self._hooks
            ]
        }

    def clear(self) -> None:
        """Remove all hooks (test helper)."""
        self._hooks.clear()

    @staticmethod
    def _matches(matcher: str, tool_name: str) -> bool:
        """Check if tool_name matches the matcher pattern.

        Supports '|' alternation (e.g. 'write_file|edit_file') and
        fnmatch wildcards (e.g. 'write_*').
        """
        if matcher == '*':
            return True
        for part in matcher.split('|'):
            if fnmatch.fnmatchcase(tool_name, part.strip()):
                return True
        return False


# Module-level singleton
registry = HookRegistry()
