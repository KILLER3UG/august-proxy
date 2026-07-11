"""Gateway runner — discover and start enabled platform adapters.

Reads the ``gateway`` section of ``data/config.json`` (via settings.config):
behavioural config lives there; only per-platform secrets (bot tokens) live
in ``.env``. A2 registers the Telegram adapter factory here; A1 ships the
skeleton + base/bridge wiring so it is testable without a real platform.
"""
from __future__ import annotations
import logging
from typing import Callable
from app.services.gateway.base import BasePlatformAdapter
from app.services.gateway.session_bridge import SessionBridge
log = logging.getLogger(__name__)
_adapterFactories: dict[str, Callable[..., BasePlatformAdapter]] = {}

def registerAdapter(name: str, factory: Callable[..., BasePlatformAdapter]) -> None:
    """Register a platform adapter factory (called at import time by A2)."""
    _adapterFactories[name] = factory

class GatewayRunner:

    def __init__(self, settings: object) -> None:
        self.settings = settings
        self.adapters: list[BasePlatformAdapter] = []
        self._bridge: SessionBridge | None = None

    def _gatewayConfig(self) -> dict[str, object]:
        try:
            return self.settings.config.get('gateway', {}) or {}
        except Exception:
            return {}

    async def start(self) -> None:
        cfg = self._gatewayConfig()
        if not cfg.get('enabled', False):
            return
        self._bridge = SessionBridge(provider=cfg.get('provider', ''), model=cfg.get('model', ''), agentId=cfg.get('agentId', ''), modelProvider=cfg.get('modelProvider', ''), guardMode=cfg.get('guardMode', 'full'))
        platforms = cfg.get('platforms', {}) or {}
        for name, pcfg in platforms.items():
            if not (pcfg or {}).get('enabled', False):
                continue
            factory = _adapterFactories.get(name)
            if not factory:
                log.warning("gateway: no adapter registered for platform '%s'", name)
                continue
            adapter = factory(config=pcfg or {}, bridge=self._bridge)
            try:
                await adapter.connect()
                await adapter.start()
                self.adapters.append(adapter)
                log.info("gateway: started platform '%s'", name)
            except Exception as exc:
                log.error("gateway: failed to start '%s': %s", name, exc)

    async def stop(self) -> None:
        for adapter in self.adapters:
            try:
                await adapter.stop()
                await adapter.disconnect()
            except Exception as exc:
                log.warning('gateway: error stopping %s: %s', adapter.platform, exc)
        self.adapters.clear()

async def startGateway(settings: object) -> GatewayRunner:
    """Boot the gateway (call from the app lifespan alongside the scheduler)."""
    runner = GatewayRunner(settings)
    await runner.start()
    return runner