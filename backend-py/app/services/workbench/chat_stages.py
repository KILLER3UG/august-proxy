"""Named chat-loop stages used by the workbench orchestrator.

Keeps ``workbench.py`` as orchestration only: prompt → model → tools → persist.
Heavy logic stays in tool_executor / sessions / memory; this module holds the
stage boundaries that parallel tool runs and post-turn side effects hang off.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from typing import TypeVar

from app.services.workbench.parallel_tools import is_parallel_safe

logger = logging.getLogger('august.workbench.chat_stages')

T = TypeVar('T')
ToolTriple = tuple[str, dict[str, object], str]
RunRegular = Callable[[str, dict[str, object], str], Awaitable[dict[str, object]]]


async def run_regular_tools_stage(
    pending: Sequence[ToolTriple],
    run_one: RunRegular,
    *,
    is_cancelled: Callable[[], bool] | None = None,
) -> list[dict[str, object]]:
    """Run a batch of regular (non-managed) tools for one model round.

    When every tool in the batch is on the read-only allowlist, they run
    concurrently via ``asyncio.gather``. If any tool mutates state (or is
    not allowlisted), the whole batch runs serially so side effects stay ordered.

    ``pending`` items are ``(tool_name, tool_input, tool_use_id)``.
    """
    if not pending:
        return []
    cancel = is_cancelled or (lambda: False)
    if cancel():
        return []
    if len(pending) > 1 and all(is_parallel_safe(n) for n, _, _ in pending):
        return list(
            await asyncio.gather(*[run_one(n, inp, tid) for n, inp, tid in pending])
        )
    out: list[dict[str, object]] = []
    for tool_name, tool_input, tool_use_id in pending:
        if cancel():
            break
        out.append(await run_one(tool_name, tool_input, tool_use_id))
    return out


def schedule_post_turn_side_effects(
    *,
    session: object,
    messages: list[object],
    auto_memory_model: str | None,
    reflection_model: str | None,
    sync_auto_memory: Callable[..., None],
    reflect_on_turn: Callable[..., None],
) -> None:
    """Kick off auto-memory and turn reflection without blocking the chat stream.

    These jobs run on a worker thread (via ``asyncio.to_thread``) so they do not
    stall the event loop, delay the first streamed token, or hold the stream
    open while finishing. Failures are logged at debug and never raised to the
    caller. Safe to call after the final SSE event has been sent.
    """
    if auto_memory_model:
        try:
            asyncio.create_task(
                asyncio.to_thread(sync_auto_memory, session, list(messages), auto_memory_model)
            )
        except Exception:
            logger.debug('schedule auto-memory failed', exc_info=True)
    if reflection_model:
        try:
            asyncio.create_task(
                asyncio.to_thread(reflect_on_turn, list(messages), reflection_model)
            )
        except Exception:
            logger.debug('schedule reflection failed', exc_info=True)
