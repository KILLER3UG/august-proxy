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


def is_parallel_safe(tool_name: str, allowlist: AbstractSet[str] | None = None) -> bool:
    """True if this tool may run concurrently with other read-only tools."""
    if not enabled():
        return False
    names = allowlist if allowlist is not None else PARALLEL_SAFE_TOOLS
    return tool_name in names
