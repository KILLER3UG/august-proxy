"""
Unified tool policy — single source of truth for tool classification,
mutation detection, and guard-mode approval gating.

Replaces the three divergent classifiers that previously existed:
  1. capabilities_prompt.classify_tool (prompt buckets)
  2. workbench.isPlanModeBlocked / isShellMutationTool (guard predicates)
  3. workbench.listProxyCapabilities._MUTATING_TOOLS (telemetry)

All consumers now read from this module. The parity test
(tests/test_tool_policy_parity.py) proves behavior is unchanged.
"""

from __future__ import annotations

from app.json_narrowing import as_str

# ── Prompt buckets (for capabilities_prompt) ──────────────────────────────
# Exact-match frozensets transcribed from capabilities_prompt.py buckets.

_PROMPT_READ = frozenset({
    'brain_query', 'browser_get_content', 'browser_open', 'browser_screenshot',
    'browser_wait', 'context_read', 'describe_environment', 'desktop_list_windows',
    'desktop_mouse_position', 'desktop_screen_size', 'desktop_screenshot',
    'diagnose_proxy', 'fact_search', 'get_fallback', 'list_aliases',
    'list_directory', 'list_integrations', 'list_mcp_servers', 'memory_search',
    'read_blackboard', 'read_file', 'read_files', 'search_files', 'web_fetch',
    'web_fetch_many', 'web_search',
})

_PROMPT_WRITE = frozenset({
    'browser_click', 'browser_evaluate', 'browser_scroll', 'browser_select',
    'browser_type', 'bulk', 'configure_fallback', 'create_alias', 'desktop_click',
    'desktop_open_url', 'desktop_press_key', 'desktop_type', 'rename_session',
    'rename_sessions', 'setup_provider', 'connect_github', 'connect_google',
    'connect_slack', 'install_mcp_server', 'customize_ui', 'enter_plan_mode',
    'submit_plan', 'update_alias', 'update_heuristics', 'update_memory', 'update_state',
    'write_blackboard', 'write_file', 'write_files', 'write_scratchpad',
    'remember',
})

_PROMPT_DESTRUCTIVE = frozenset({
    'clear_blackboard', 'delete_agent', 'delete_alias', 'disconnect_integration',
    'delete_folder', 'delete_session', 'delete_sessions', 'kill_daemon',
    'kill_daemons', 'forget',
})

_PROMPT_SHELL = frozenset({'run_command'})

_PROMPT_AGENT = frozenset({
    'create_agent', 'list_agents', 'list_daemons', 'spawn_daemon',
    'spawn_subagent', 'spawn_subagents', 'update_agent', 'set_agent_mode',
})

_PROMPT_SKILL = frozenset({'list_skills', 'load_skill', 'load_skills', 'skill_manage'})

_PROMPT_BRIDGE = frozenset({'tool_call', 'tool_describe', 'tool_search'})

_PROMPT_BUCKETS = {
    'tool_read': _PROMPT_READ,
    'tool_write': _PROMPT_WRITE,
    'tool_destructive': _PROMPT_DESTRUCTIVE,
    'tool_shell': _PROMPT_SHELL,
    'tool_agent': _PROMPT_AGENT,
    'tool_skill': _PROMPT_SKILL,
    'tool_bridge': _PROMPT_BRIDGE,
}

# ── Guard: plan-mode blocked (mutating) tools ─────────────────────────────
# Transcribed from workbench.isPlanModeBlocked.

_PLAN_BLOCKED_EXACT = frozenset({
    'write_file', 'edit_file', 'create_file', 'str_replace', 'str_replace_editor',
    'strreplaceeditttool', 'apply_patch', 'patch_file', 'delete_file',
    'remove_file', 'move_file', 'rename_file', 'mkdir', 'makedirs',
    'run_command', 'bash', 'bashtool', 'shell', 'exec', 'execute', 'terminal',
    'install', 'uninstall', 'pip_install', 'npm_install', 'pnpm_add',
    'browser_click', 'browser_type', 'browser_select', 'browser_evaluate',
    'create_agent', 'update_agent', 'delete_agent', 'create_alias',
    'update_alias', 'delete_alias', 'configure_fallback',
    # Integration tools (explicit list added in the security fix).
    'connect_github', 'connect_slack', 'connect_google', 'install_mcp_server',
    'disconnect_integration',
})

_PLAN_BLOCKED_BULK_PLURALS = frozenset({
    'write_files', 'delete_sessions', 'rename_sessions', 'kill_daemons',
})

_PLAN_BLOCKED_MARKERS = (
    'write', 'edit', 'delete', 'remove', 'install', 'uninstall',
    'exec', 'command', 'bash', 'shell', 'patch', 'rename', 'kill_daemon',
)

_PLAN_BLOCKED_BULK_OPS = frozenset({
    'write_files', 'write_file', 'write', 'delete_sessions', 'delete_session',
    'rename_sessions', 'rename_session', 'kill_daemons', 'kill_daemon',
})

_PLAN_BLOCKED_BULK_OP_MARKERS = ('write', 'delete', 'rename', 'kill')

# Session/UI metadata renames are NOT workspace mutations.
_RENAME_SESSION_EXEMPT = frozenset({'rename_session', 'renamesession'})

# ── Guard: shell mutation tools (edit-mode gating) ────────────────────────
# Transcribed from workbench.isShellMutationTool.

_SHELL_EXACT = frozenset({
    'run_command', 'bash', 'bashtool', 'shell', 'exec', 'execute', 'terminal',
    'install', 'uninstall', 'pip_install', 'npm_install', 'pnpm_add',
    'install_mcp_server',
})

_SHELL_BULK_OPS = frozenset({'run_command', 'bash', 'shell', 'exec'})

_SHELL_SUBSTRINGS = ('bash', 'shell', 'terminal', 'run_command')


# ── Public API ────────────────────────────────────────────────────────────

def prompt_bucket(name: str) -> str:
    """Return the prompt bucket for ``name`` (e.g. 'tool_read', 'tool_write').

    Unknown / MCP tools fall to 'tool_other' (fail-closed caution in prompt).
    """
    n = (name or '').strip()
    if not n:
        return 'tool_other'
    for bucket, names in _PROMPT_BUCKETS.items():
        if n in names:
            return bucket
    return 'tool_other'


def is_mutating(name: str, args: dict[str, object] | None = None) -> bool:
    """True when the tool mutates workspace state (needs checkpoint / plan block).

    Matches the old ``isPlanModeBlocked`` exactly, including the
    ``rename_session`` exemption and ``bulk`` nested-operation resolution.
    """
    if not name:
        return False
    n = name.lower()
    if n in _RENAME_SESSION_EXEMPT:
        return False
    if n in _PLAN_BLOCKED_EXACT:
        return True
    if n in _PLAN_BLOCKED_BULK_PLURALS:
        return True
    if n == 'bulk':
        op = as_str((args or {}).get('operation')).lower().replace('-', '_')
        return op in _PLAN_BLOCKED_BULK_OPS or any(
            m in op for m in _PLAN_BLOCKED_BULK_OP_MARKERS
        )
    return any(marker in n for marker in _PLAN_BLOCKED_MARKERS)


def is_shell_mutation(name: str, args: dict[str, object] | None = None) -> bool:
    """True when the tool is a shell/command execution (edit-mode gating).

    Matches the old ``isShellMutationTool`` exactly.
    """
    if not name:
        return False
    n = name.lower()
    if n in _SHELL_EXACT:
        return True
    if n == 'bulk':
        op = as_str((args or {}).get('operation')).lower().replace('-', '_')
        return op in _SHELL_BULK_OPS
    return any(m in n for m in _SHELL_SUBSTRINGS)


def needs_approval_in(
    mode: str,
    name: str,
    args: dict[str, object] | None = None,
) -> bool:
    """Whether the tool requires user approval in the given guard mode.

    Matches the old ``_checkToolGuard`` mode dispatch (excluding the
    read-only-sandbox pre-check and plan-file-write exception, which are
    path/sandbox-specific and stay in the guard).

    Returns True when the tool should be blocked / queued for approval.
    The caller is responsible for checking ``planApproved`` and
    ``is_plan_file_write`` before acting on a plan-mode block.
    """
    if mode == 'full':
        return False
    if mode == 'plan':
        return is_mutating(name, args)
    if mode == 'edit':
        return is_shell_mutation(name, args)
    if mode == 'ask':
        return is_mutating(name, args)
    return False
