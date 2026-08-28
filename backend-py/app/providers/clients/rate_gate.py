"""Per-host upstream rate gate (plan §10.3 R-C: rate limiting).

When an upstream provider answers 429, subsequent requests to the same
host wait out the provider's Retry-After window instead of immediately
re-hitting the limiter. The gate is advisory and fail-open: any gate
malfunction must never block a request (guardrail-failure pattern,
plan Part 10 — a guard glitch yields "proceed", never a silent outage).
"""

from __future__ import annotations

import asyncio
import time
from urllib.parse import urlparse

# Longest the gate will ever hold a request, even if Retry-After is larger.
# Matches the transport retry-delay cap in base.py (30 s).
MAX_GATE_WAIT_S = 30.0

# Courtesy backoff when a 429 carries no usable Retry-After hint.
_DEFAULT_COOLDOWN_S = 1.0


def hostOfUrl(url: str) -> str:
    """Extract the host(:port) key for rate-gating; empty on parse failure."""
    try:
        return urlparse(url).netloc
    except Exception:
        return ''


class ProviderRateGate:
    """Tracks per-host cooldowns imposed by upstream 429 responses."""

    def __init__(self, maxWaitS: float = MAX_GATE_WAIT_S) -> None:
        self.maxWaitS = maxWaitS
        self._cooldownUntil: dict[str, float] = {}

    def recordRateLimit(self, host: str, retryAfterMs: int | float | None) -> None:
        """Record a 429 from ``host``; extend its cooldown if longer."""
        if not host:
            return
        waitS = min(max(0.0, float(retryAfterMs or 0) / 1000), self.maxWaitS)
        if waitS <= 0:
            waitS = _DEFAULT_COOLDOWN_S
        until = time.monotonic() + waitS
        if until > self._cooldownUntil.get(host, 0.0):
            self._cooldownUntil[host] = until

    def cooldownRemainingS(self, host: str) -> float:
        """Seconds of cooldown left for ``host`` (0 when clear)."""
        until = self._cooldownUntil.get(host)
        if until is None:
            return 0.0
        remaining = until - time.monotonic()
        if remaining <= 0:
            self._cooldownUntil.pop(host, None)
            return 0.0
        return remaining

    async def wait(self, host: str) -> None:
        """Sleep out any active cooldown for ``host`` (bounded, fail-open)."""
        if not host:
            return
        try:
            remaining = self.cooldownRemainingS(host)
            if remaining > 0:
                await asyncio.sleep(min(remaining, self.maxWaitS))
        except asyncio.CancelledError:
            raise
        except Exception:
            # Fail-open: a gate glitch must never block the request.
            pass

    def clear(self) -> None:
        self._cooldownUntil.clear()


# Process-wide gate: cooldowns are keyed by upstream host, so all clients
# sharing a provider host share its backoff window.
rateGate = ProviderRateGate()
