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
    'browser_wait', 'describe_environment', 'desktop_list_windows',
    'desktop_mouse_position', 'desktop_screen_size', 'desktop_screenshot',
    'diagnose_proxy', 'get_fallback', 'list_aliases',
    'list_directory', 'list_integrations', 'list_mcp_servers',
    'pptx_list_elements',
    # Media analysis — the sanctioned reader for images/video/audio/docs
    # (read_file refuses binary media and redirects here).
    'analyze_media',
    # Camera capture — read-only image acquisition; frames are transient
    # (the tool deletes the raw file before returning, and the result is a
    # vision description, not the bytes).
    'camera_list_devices', 'camera_snapshot',
    # Circuit workbench lookups — read-only datasheet/board facts.
    'list_boards', 'search_component', 'circuit_list_boards',
    'circuit_search_component', 'circuit_read_netlist', 'circuit_list_netlists',
    # Circuit environment doctor — probes installed EDA engines (version
    # banners + a hardcoded XSPICE probe deck); reads machine state only,
    # no workspace mutation.
    'circuit_env',
    # Fault injection — pure text transform on deck text (no binary spawn,
    # no file writes); the variant deck still flows through the gated
    # simulate/test tools to run.
    'circuit_inject_fault',
    # Symbolic analysis — in-process SymPy/lcapy compute over deck text;
    # reads nothing, writes nothing.
    'circuit_symbolic',
    # Wiring-diagram lint — pure JSON validation transform (no binary
    # spawn, no file writes); spawns nothing.
    'circuit_lint_diagram',
    # Datasheet/model-card lookup — network read, no workspace mutation.
    'circuit_integrate_component',
    # VCD analysis — pure-Python read of a workspace waveform file; no
    # engine spawn, no writes (protocol decode happens in-process).
    'vcd_parse',
    'read_blackboard', 'read_file', 'read_files', 'search_files', 'web_fetch',
    'web_fetch_many', 'web_search',
    # Component datasheet/parts lookup — network read, no workspace mutation.
    'search_component',
    # Unified cross-store search (files/web) — read-only.
    'search',
    # Harness self-inspection — read-only aggregation of runtime state.
    'harness_introspect',
    # Session state summary for handoff/compaction — read-only.
    'summarize_session',
    # Memory CRUD read door — lists durable fact keys/titles (gated by
    # modelMemoryRead in the handler).
    'list_facts',
})

_PROMPT_WRITE = frozenset({
    'browser_click', 'browser_evaluate', 'browser_scroll', 'browser_select',
    'browser_type', 'bulk', 'configure_fallback', 'create_alias', 'desktop_click',
    'desktop_open_url', 'desktop_press_key', 'desktop_type', 'rename_session',
    'rename_sessions', 'setup_provider', 'connect_github', 'connect_google',
    'connect_slack', 'install_mcp_server', 'customize_ui', 'enter_plan_mode',
    'submit_plan', 'update_alias', 'update_state',
    # Todo-list doors (session-state writes, like update_state; the workbench
    # turn loop intercepts both, the registry fallback stores on the session).
    'submit_todos', 'update_todos',
    'write_blackboard', 'write_file', 'write_files', 'write_scratchpad', 'edit_lines',
    'pptx_comment',
    # Memory write door — saves a durable fact (gated by modelMemoryWrites).
    'remember',
    # Memory delete door — removes one durable fact by key (rollback
    # snapshot recorded; gated by modelMemoryWrites in the handler).
    'forget',
    # Artifact creation — each writes a file into the workspace.
    'create_pptx', 'render_chart', 'render_video', 'draw_circuit',
    # Circuit workbench mutations — netlist files + rendered PNG output.
    'circuit_create_netlist', 'circuit_update_netlist', 'circuit_render_3d',
    # Firmware→SPICE bridge — reads the pin-timeline JSON and writes the
    # merged <name>.cir stimulus deck into the workspace (no binary spawn).
    'firmware_stimulus',
    # WaveDrom timing-diagram — writes <name>.timing.svg into the
    # workspace (spawns the bundled node for rendering, like render_chart).
    'hdl_timing_diagram',
    # KiCad board render — writes <name>.png/.glb into the workspace
    # (spawns kicad-cli pcb render/export, like render_chart).
    'kicad_render',
    # Interactive HTML artifacts — writes an .html file into the workspace.
    'create_html_artifact',
    # Harness self-improvement: files proposals for human review (no direct
    # application from the model — approval runs a deterministic applier).
    'harness_propose',
    # M-11 notepad door — persists per-job machine state between automation
    # runs (gated to automation-run sessions in the handler).
    'job_notes',
    # Unified-diff patch application — a file write (plan-blocked via markers).
    'apply_patch',
})

_PROMPT_DESTRUCTIVE = frozenset({
    'clear_blackboard', 'delete_agent', 'delete_alias', 'disconnect_integration',
    'delete_folder', 'delete_session', 'delete_sessions', 'kill_daemon',
    'kill_daemons',
    # Bot Mode routines: removes a Bot-owned scheduled job.
    'delete_routine',
    # Circuit workbench: removes a netlist file from the workspace.
    'circuit_delete_netlist',
})

_PROMPT_SHELL = frozenset({'run_command', 'run_commands', 'simulate_circuit', 'circuit_simulate', 'circuit_test', 'circuit_export_vcd', 'circuit_annotate', 'firmware_compile', 'firmware_run', 'hdl_lint', 'hdl_simulate', 'hdl_test', 'fpga_compile', 'kicad_checks'})

_PROMPT_AGENT = frozenset({
    'create_agent', 'list_agents', 'list_daemons', 'spawn_daemon',
            'spawn_subagents', 'update_agent', 'set_agent_mode',
            'list_workstreams', 'send_subagent_message', 'interrupt_subagent',
            # Bot Mode routines: Bot-owned scheduled jobs.
            'create_routine', 'list_routines',
})

_PROMPT_SKILL = frozenset({'list_skills', 'load_skill', 'load_skills'})

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
    'edit_lines',
    'run_command', 'bash', 'bashtool', 'shell', 'exec', 'execute', 'terminal',
    'install', 'uninstall', 'pip_install', 'npm_install', 'pnpm_add',
    'browser_click', 'browser_type', 'browser_select', 'browser_evaluate',
    'create_agent', 'update_agent', 'delete_agent', 'create_alias',
    'update_alias', 'delete_alias', 'configure_fallback',
    # Bot Mode routines — create/delete persists a scheduled job that fires
    # later (create_agent precedent: persistent mutations are plan-blocked;
    # delete_routine is also caught by the 'delete' marker below).
    'create_routine',
    # Integration tools (explicit list added in the security fix).
    'connect_github', 'connect_slack', 'connect_google', 'install_mcp_server',
    'disconnect_integration',
    # Circuit netlist CRUD — workspace file writes/edits behind the
    # /circuit workbench gate (still plan-mode mutations).
    'circuit_create_netlist', 'circuit_update_netlist',
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
    # Spawns the ngspice binary on a model-authored netlist — same
    # edit-mode gating as a shell command. Both names: the registered
    # circuit_* tool and the legacy unprefixed alias. circuit_test wraps
    # simulate_circuit, so it spawns the binary too; circuit_export_vcd
    # runs the deck through eprvcd for the VCD artifact; circuit_annotate
    # runs the .op and writes the voltage-colored SVG artifact;
    # firmware_compile spawns arduino-cli / avr-gcc for the HEX artifact;
    # firmware_run spawns the Node avr8js sidecar; hdl_lint/hdl_simulate/
    # hdl_test spawn ghdl/verilator/iverilog/cocotb child processes.
    'simulate_circuit', 'circuit_simulate', 'circuit_test',
    'circuit_export_vcd', 'circuit_annotate', 'firmware_compile',
    'firmware_run', 'hdl_lint', 'hdl_simulate', 'hdl_test',
    # Quartus full-flow compile (map→fit→asm→sta) — spawns quartus_sh.
    # fpga_program (JTAG download) is intentionally NOT here or anywhere:
    # a hardware action that stays confirm-gated and agent-uncharted.
    'fpga_compile',
    # ERC/DRC gate — spawns kicad-cli sch erc / pcb drc; read-only on the
    # design files (no workspace writes).
    'kicad_checks',
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
