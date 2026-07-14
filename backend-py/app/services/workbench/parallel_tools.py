"""Safe parallel tool execution for read-only allowlisted tools.

Mutating / plan / clarify / todo tools stay serial. Parallelism is only for
tools with no side effects on disk/DB beyond read APIs.

Enable: default on. Disable: ``AUGUST_P1_PARALLEL_TOOLS=0``.
"""

from __future__ import annotations

import os
from typing import AbstractSet

# Read-only / list-style tools safe to run concurrently in one model round.
PARALLEL_SAFE_TOOLS: frozenset[str] = frozenset(
    {
        'list_skills',
        'list_directory',
        'list_agents',
        'list_daemons',
        'read_file',
        'search_files',
        'memory_search',
        'fact_search',
        'context_read',
        'brain_query',
        'web_search',
        'web_fetch',
        'get_workbench_activity',
        'list_proxy_capabilities',
    }
)


def enabled() -> bool:
    v = os.environ.get('AUGUST_P1_PARALLEL_TOOLS', '1').strip().lower()
    return v not in ('0', 'false', 'no', 'off')


def is_parallel_safe(
    tool_name: str,
    allowlist: AbstractSet[str] | None = None,
    args: dict[str, object] | None = None,
) -> bool:
    """True if this tool may run concurrently with other read-only tools.

    Enforcement path (single policy stack):
      1. Feature flag off → never parallel
      2. Explicit workbench allowlist hit → safe
      3. Else managed name-pattern policy (proxy/MCP tools)
    """
    if not enabled():
        return False
    names = allowlist if allowlist is not None else PARALLEL_SAFE_TOOLS
    if tool_name in names:
        return True
    # When caller passed a custom allowlist, do not fall through (strict mode).
    if allowlist is not None:
        return False
    from app.services.workbench.managed_tool_policy import isManagedToolParallelSafe

    return isManagedToolParallelSafe(tool_name, args)
