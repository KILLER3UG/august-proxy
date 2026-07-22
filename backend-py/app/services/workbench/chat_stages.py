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

    def _emit_tool(stage: str, name: str, status: str = 'running', error: str | None = None) -> None:
        try:
            from app.services.feature_flow import emit_feature_flow

            emit_feature_flow(
                feature='tools',
                stage=stage,
                summary=f'Tool {stage}: {name}',
                status=status,
                error=error,
                meta={'tool': name},
            )
        except Exception:
            pass

    async def _run_tracked(name: str, inp: dict[str, object], tid: str) -> dict[str, object]:
        _emit_tool('exec', name, 'running')
        try:
            result = await run_one(name, inp, tid)
            ok = not (isinstance(result, dict) and result.get('is_error'))
            _emit_tool('result', name, 'ok' if ok else 'error', error=None if ok else 'tool error')
            if not ok:
                try:
                    from app.services.memory.deterministic_signals import trackToolFailure

                    error_text = str(result.get('content', ''))[:200] if isinstance(result, dict) else ''
                    trackToolFailure(name, error_text)
                except Exception:
                    pass
            return result
        except Exception as exc:
            _emit_tool('result', name, 'error', error=str(exc)[:200])
            try:
                from app.services.memory.deterministic_signals import trackToolFailure

                trackToolFailure(name, str(exc)[:200])
            except Exception:
                pass
            raise

    if len(pending) > 1 and all(is_parallel_safe(n) for n, _, _ in pending):
        return list(
            await asyncio.gather(*[_run_tracked(n, inp, tid) for n, inp, tid in pending])
        )
    out: list[dict[str, object]] = []
    for tool_name, tool_input, tool_use_id in pending:
        if cancel():
            break
        out.append(await _run_tracked(tool_name, tool_input, tool_use_id))
    return out


def schedule_post_turn_side_effects(
    *,
    session: object,
    messages: list[object],
    auto_memory_model: str | None,
    sync_auto_memory: Callable[..., None],
) -> None:
    """Kick off auto-memory sync without blocking the chat stream.

    These jobs run on a worker thread (via ``asyncio.to_thread``) so they do not
    stall the event loop, delay the first streamed token, or hold the stream
    open while finishing. Failures are logged at debug and never raised to the
    caller. Safe to call after the final SSE event has been sent.

    Note: The unified LLM reflection (corrections, facts, skills, frustration)
    is handled by ``background_review.tryBackgroundReview`` which is called
    separately from the workbench finalizer.
    """
    if auto_memory_model:
        try:
            asyncio.create_task(
                asyncio.to_thread(sync_auto_memory, session, list(messages), auto_memory_model)
            )
        except Exception:
            logger.debug('schedule auto-memory failed', exc_info=True)
