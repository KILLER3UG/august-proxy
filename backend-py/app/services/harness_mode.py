"""Planner/orchestrator tool policy (Nac: decide and route, do not act)."""

from __future__ import annotations

import os

MUTATING_TOOLS = frozenset(
    {
        # Registered mutating tools (keep in sync with tool_registrations).
        # Legacy aliases (edit_file / str_replace / delete_file) were never
        # registered names — a worker editing via edit_lines was previously
        # not flagged as having mutated anything.
        'write_file',
        'write_files',
        'edit_lines',
        'apply_patch',
        'run_command',
        'run_commands',
    }
)

PLANNER_ALLOWED_TOOLS = frozenset(
    {
        'spawn_subagents',
        'list_workstreams',
        'send_subagent_message',
        'interrupt_subagent',
        'list_agents',
        'list_daemons',
        'read_blackboard',
        'write_blackboard',
        'brain_query',
        'memory_search',
        'fact_search',
        'read_file',
        'read_files',
        'list_directory',
        'search_files',
        'web_search',
        'web_fetch',
        'update_state',
        'set_agent_mode',
        'list_skills',
        'load_skill',
        'load_skills',
        'describe_environment',
        'context_read',
    }
)


def is_orchestrator_mode(session: object | None) -> bool:
    mode = str(getattr(session, 'agent_mode', '') or '').strip().lower()
    return mode in ('orchestrator', 'planner')


def tool_name_of(tool: dict[str, object]) -> str:
    name = tool.get('name')
    if isinstance(name, str) and name:
        return name
    fn = tool.get('function')
    if isinstance(fn, dict):
        n = fn.get('name')
        if isinstance(n, str):
            return n
    return ''


def filter_planner_tools(tools: list[dict[str, object]]) -> list[dict[str, object]]:
    return [t for t in tools if tool_name_of(t) in PLANNER_ALLOWED_TOOLS]


def planner_block_message(tool_name: str) -> str:
    return (
        f'[Blocked] Orchestrator mode: cannot use `{tool_name}`. '
        'Dispatch a workstream via spawn_subagents (workers may edit/shell). '
        'Switch set_agent_mode(mode="agent") to act directly.'
    )


def proxy_orchestrator_enabled() -> bool:
    return os.environ.get('AUGUST_PROXY_ORCHESTRATOR', '').strip().lower() in ('1', 'true', 'yes')


def is_mutating_tool(name: str) -> bool:
    return name in MUTATING_TOOLS


BENCHMARK_ALLOWED_TOOLS = frozenset({'run_command', 'edit_lines'})


def is_benchmark_mode(session: object | None) -> bool:
    mode = str(getattr(session, 'agent_mode', '') or '').strip().lower()
    return mode == 'benchmark'


def filter_benchmark_tools(
    session: object | None, tools: list[dict[str, object]]
) -> list[dict[str, object]]:
    del session  # signature parity with other mode filters
    allowed = set(BENCHMARK_ALLOWED_TOOLS)
    return [t for t in tools if tool_name_of(t) in allowed]


def benchmark_block_message(tool_name: str) -> str:
    return (
        f'[Blocked] Benchmark mode: only run_command and edit_lines are '
        f'available (raw capability evaluation). `{tool_name}` is disabled.'
    )
