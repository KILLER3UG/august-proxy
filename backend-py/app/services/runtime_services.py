"""Process-global runtime services (curator, subagent orchestrator).

Lifespan attaches these to ``app.state``. Routers also call the getters so
tests / partial boots still get a real instance instead of permanent 503s.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

_curator: Any = None
_curator_task: asyncio.Task | None = None
_orchestrator: Any = None
_bus: Any = None


def get_curator(app: Any | None = None) -> Any:
    """Return SkillCurator, creating it if needed."""
    global _curator, _curator_task
    if app is not None:
        existing = getattr(app.state, 'curator', None)
        if existing is not None:
            _curator = existing
            return existing
    if _curator is not None:
        if app is not None:
            app.state.curator = _curator
        return _curator
    from app.services.skills.curator import make_background_curator

    try:
        asyncio.get_running_loop()
        curator, task = make_background_curator()
        _curator = curator
        _curator_task = task
    except RuntimeError:
        # No running loop (sync test path) — curator without background loop.
        from app.services.skills.curator import SkillCurator

        _curator = SkillCurator()
        _curator_task = None
    if app is not None:
        app.state.curator = _curator
    logger.info('Skill curator ready')
    return _curator


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
    global _curator, _curator_task, _orchestrator, _bus
    if _orchestrator is not None:
        try:
            await _orchestrator.close()
        except Exception:
            pass
        _orchestrator = None
    if _curator_task is not None:
        _curator_task.cancel()
        _curator_task = None
    _curator = None
    _bus = None
