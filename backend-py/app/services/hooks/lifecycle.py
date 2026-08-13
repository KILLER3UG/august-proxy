"""Workbench lifecycle hook emission (SESSION_START / PRE_MODEL_CALL / STOP)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.services.hooks.types import HookContext, HookEvent, HookResult

logger = logging.getLogger(__name__)


async def emit_lifecycle(
    event: HookEvent,
    session_id: str,
    extra: dict[str, Any] | None = None,
) -> list[HookResult]:
    from app.services.hooks.registry import registry

    ctx = HookContext(event=event, session_id=session_id or '', extra=extra or {})
    try:
        return await registry.emit(event, ctx)
    except Exception:
        logger.warning('lifecycle hook %s failed', event.value, exc_info=True)
        return []


def fire_session_start(session_id: str) -> None:
    """Schedule SESSION_START without blocking session create."""
    if not session_id:
        return

    async def _run() -> None:
        await emit_lifecycle(HookEvent.SESSION_START, session_id)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_run())
    except RuntimeError:
        logger.debug('SESSION_START skipped (no running event loop)')
