"""Process-global runtime services (curator, subagent orchestrator).

Lifespan attaches these to ``app.state``. Routers also call the getters so
tests / partial boots still get a real instance instead of permanent 503s.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_orchestrator: Any = None
_bus: Any = None


def get_orchestrator(app: Any | None = None) -> Any:
    """Return SubagentOrchestrator, creating it if needed."""
    global _orchestrator, _bus
    if app is not None:
        existing = getattr(app.state, 'subagent_orchestrator', None)
        if existing is not None:
            _orchestrator = existing
            return existing
    if _orchestrator is not None:
        if app is not None:
            app.state.subagent_orchestrator = _orchestrator
            if _bus is not None:
                app.state.subagent_bus = _bus
        return _orchestrator
    from app.services.agent_message_bus import AgentMessageBus
    from app.services.subagent_orchestrator import SubagentOrchestrator

    _bus = AgentMessageBus()
    _orchestrator = SubagentOrchestrator(_bus, max_workers=5)
    if app is not None:
        app.state.subagent_bus = _bus
        app.state.subagent_orchestrator = _orchestrator
    logger.info('Subagent orchestrator ready (lazy or lifespan)')
    return _orchestrator


async def shutdown_runtime_services() -> None:
    global _orchestrator, _bus
    if _orchestrator is not None:
        try:
            await _orchestrator.close()
        except Exception:
            pass
        _orchestrator = None
    _bus = None
