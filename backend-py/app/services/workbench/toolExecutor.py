"""
Batch tool execution utility.

Port of backend/services/workbench/tool-executor.js (41 lines).

Executes an array of tool uses, optionally in parallel if all tools
are parallel-safe.
"""
from __future__ import annotations
import asyncio
from typing import Any, Callable

async def executeToolBatch(toolUses: list[Any], executeOne: Callable[[Any], Any], options: dict[str, Any] | None=None) -> list[Any]:
    """Execute a batch of tool uses.

    Args:
        tool_uses: List of tool use/call objects.
        execute_one: Async callable that executes a single tool and returns its result.
        options:
            - parallel (bool): Enable parallel execution (default: False).
            - can_run_in_parallel (callable): Function that checks if a single
              tool use can run in parallel.
            - on_result (callable): Callback after each result.

    Returns:
        List of tool execution results.
    """
    opts = options or {}
    parallel = opts.get('parallel', False)
    canRunInParallel = opts.get('can_run_in_parallel')
    onResult = opts.get('on_result')
    if parallel and canRunInParallel:
        allSafe = all((canRunInParallel(tu) for tu in toolUses))
        if allSafe:
            tasks = [executeOne(tu) for tu in toolUses]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            final: list[Any] = []
            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    final.append({'tool_call_id': getattr(toolUses[i], 'get', lambda k, d=None: d)('id', ''), 'role': 'tool', 'content': f'Error: {result}'})
                else:
                    final.append(result)
                    if onResult:
                        onResult(result)
            return final
    results = []
    for tu in toolUses:
        result = await executeOne(tu)
        results.append(result)
        if onResult:
            onResult(result)
    return results