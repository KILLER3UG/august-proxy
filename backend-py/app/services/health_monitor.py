"""Connection health monitor — background provider probing.

Part of Better Harness Plan Phase 4.2.
Probes each configured provider every 60s, stores results in a ring buffer.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

_PROBE_INTERVAL_S = 60
_PROBE_TIMEOUT_S = 5
_RING_SIZE = 50


@dataclass
class ProbeResult:
    provider_id: str
    success: bool
    latency_ms: float
    error: str | None = None
    timestamp: float = field(default_factory=time.time)


@dataclass
class ProviderHealth:
    provider_id: str
    name: str
    base_url: str
    probes: deque = field(default_factory=lambda: deque(maxlen=_RING_SIZE))

    @property
    def status(self) -> str:
        """healthy | degraded | unreachable | unknown."""
        if not self.probes:
            return 'unknown'
        recent = list(self.probes)[-3:]
        failures = sum(1 for p in recent if not p.success)
        if failures == 0:
            return 'healthy'
        elif failures < len(recent):
            return 'degraded'
        return 'unreachable'

    @property
    def avg_latency_ms(self) -> float:
        successful = [p.latency_ms for p in self.probes if p.success]
        return round(sum(successful) / len(successful), 1) if successful else 0.0

    @property
    def last_success(self) -> float | None:
        for p in reversed(list(self.probes)):
            if p.success:
                return p.timestamp
        return None

    @property
    def last_error(self) -> str | None:
        for p in reversed(list(self.probes)):
            if not p.success:
                return p.error
        return None

    def to_dict(self) -> dict:
        return {
            'providerId': self.provider_id,
            'name': self.name,
            'status': self.status,
            'avgLatencyMs': self.avg_latency_ms,
            'lastSuccess': self.last_success,
            'lastError': self.last_error,
            'probeCount': len(self.probes),
            'successRate': round(
                sum(1 for p in self.probes if p.success) / len(self.probes) * 100, 1
            ) if self.probes else 0.0,
        }


class HealthMonitor:
    """Background health monitor for configured providers."""

    def __init__(self) -> None:
        self._providers: dict[str, ProviderHealth] = {}
        self._task: asyncio.Task | None = None
        self._running = False

    def register_provider(self, provider_id: str, name: str, base_url: str) -> None:
        """Register a provider for health monitoring."""
        if provider_id not in self._providers:
            self._providers[provider_id] = ProviderHealth(
                provider_id=provider_id, name=name, base_url=base_url
            )

    def unregister_provider(self, provider_id: str) -> None:
        """Remove a provider from monitoring."""
        self._providers.pop(provider_id, None)

    def sync_providers(self, providers: list) -> None:
        """Diff-register the provider store into the monitor.

        Adds new providers, drops removed ones — so config edits self-heal
        the probe set without restarting the app. Called on every health
        poll and after provider create/update/delete.
        """
        from app.json_narrowing import as_bool, as_str

        wanted = {
            as_str(p.get('id'))
            for p in providers
            if isinstance(p, dict)
            and as_str(p.get('id'))
            and as_bool(p.get('enabled', True))
            and as_str(p.get('baseUrl', ''))
        }
        for pid in list(self._providers.keys()):
            if pid not in wanted:
                self.unregister_provider(pid)
        for p in providers:
            if not isinstance(p, dict):
                continue
            pid = as_str(p.get('id'))
            if pid in wanted:
                self.register_provider(pid, as_str(p.get('name')), as_str(p.get('baseUrl')))

    async def probe_provider(self, provider_id: str) -> ProbeResult:
        """Probe a single provider's base URL."""
        health = self._providers.get(provider_id)
        if not health:
            return ProbeResult(provider_id=provider_id, success=False, latency_ms=0, error='Not registered')

        start = time.time()
        try:
            import httpx

            async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT_S) as client:
                url = health.base_url.rstrip('/') + '/models'
                resp = await client.get(url)
                latency = (time.time() - start) * 1000
                success = resp.status_code < 500
                error = None if success else f'HTTP {resp.status_code}'
        except Exception as exc:
            latency = (time.time() - start) * 1000
            success = False
            error = str(exc)[:200]

        result = ProbeResult(provider_id=provider_id, success=success, latency_ms=round(latency, 1), error=error)
        health.probes.append(result)
        return result

    async def probe_all(self) -> list[ProbeResult]:
        """Probe all registered providers."""
        results = []
        for pid in list(self._providers.keys()):
            result = await self.probe_provider(pid)
            results.append(result)
        return results

    def get_all_health(self) -> list[dict]:
        """Get health status for all providers."""
        return [h.to_dict() for h in self._providers.values()]

    def get_provider_health(self, provider_id: str) -> dict | None:
        """Get health for a specific provider."""
        health = self._providers.get(provider_id)
        return health.to_dict() if health else None

    async def start(self) -> None:
        """Start the background probe loop."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._probe_loop())
        logger.info('Health monitor started (%d providers)', len(self._providers))

    async def stop(self) -> None:
        """Stop the background probe loop."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _probe_loop(self) -> None:
        """Background loop: probe all providers every interval."""
        while self._running:
            try:
                await self.probe_all()
            except Exception as exc:
                logger.debug('Health probe loop error: %s', exc)
            await asyncio.sleep(_PROBE_INTERVAL_S)


# Module-level singleton
health_monitor = HealthMonitor()
