"""Parity test: the unified tool_policy module must match the old divergent
classifiers for every registered tool + curated MCP names + bulk operations.

The old logic is embedded here as private oracles so that production code can
be freely repointed to tool_policy without breaking this test.

This is the safety net for the Slice 3 consolidation. If this test fails,
the consolidation changed behavior — which is not allowed.
"""

from __future__ import annotations

import pytest
from app.json_narrowing import as_str
from app.services import tool_policy

# ── Embedded oracles (old logic, frozen at consolidation time) ────────────

# Old classify_tool frozensets (from capabilities_prompt.py pre-consolidation).
_ORACLE_READ = frozenset({
    'brain_query', 'browser_get_content', 'browser_open', 'browser_screenshot',
    'browser_wait', 'describe_environment', 'desktop_list_windows',
    'desktop_mouse_position', 'desktop_screen_size', 'desktop_screenshot',
    'diagnose_proxy', 'get_fallback', 'list_aliases',
    'list_directory', 'list_integrations', 'list_mcp_servers',
    'pptx_list_elements',
    'read_blackboard', 'read_file', 'read_files', 'search_files', 'web_fetch',
    'web_fetch_many', 'web_search',
    # Component datasheet/parts lookup — network read.
    'search_component',
    # Unified cross-store search (memory/files/web) — read-only.
    'search',
    # Session state summary for handoff/compaction — read-only.
    'summarize_session',
    # Harness self-inspection — read-only aggregation of runtime state.
    'harness_introspect',
    # Circuit workbench lookups — netlists, datasheet/board facts (read-only).
    'circuit_list_boards', 'circuit_search_component', 'circuit_read_netlist',
    'circuit_list_netlists',
    # Circuit environment doctor — probes installed EDA engines; reads
    # machine state only, no workspace mutation.
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
    # Media analysis — the sanctioned reader for images/video/audio/docs.
    'analyze_media',
    # Camera capture — read-only image acquisition; frames are transient
    # (the tool deletes the raw file before returning, and the result is a
    # vision description, not the bytes).
    'camera_list_devices', 'camera_snapshot',
    # Memory CRUD read door — lists durable fact keys/titles.
    'list_facts',
})
_ORACLE_WRITE = frozenset({
    'browser_click', 'browser_evaluate', 'browser_scroll', 'browser_select',
    'browser_type', 'bulk', 'configure_fallback', 'create_alias', 'desktop_click',
    'desktop_open_url', 'desktop_press_key', 'desktop_type', 'rename_session',
    'rename_sessions', 'setup_provider', 'connect_github', 'connect_google',
    'connect_slack', 'install_mcp_server', 'customize_ui', 'enter_plan_mode',
    'submit_plan', 'update_alias', 'update_state',
    # Todo-list doors — mirror of the tool_policy._PROMPT_WRITE addition.
    'submit_todos', 'update_todos',
    'write_blackboard', 'write_file', 'write_files', 'write_scratchpad',
    # Post-consolidation addition: model-driven memory write.
    'remember',
    # Memory delete door — removes one durable fact by key (rollback
    # snapshot recorded).
    'forget',
    # Precision line-edit tool (R1).
    'edit_lines',
    # PPTX commenting (mutating).
    'pptx_comment',
    # Unified-diff patch application — a file write.
    'apply_patch',
    # Harness self-improvement: files proposals for human review (no direct
    # application from the model — approval runs a deterministic applier).
    'harness_propose',
    # M-11 notepad door — persists per-job machine state between automation
    # runs (gated to automation-run sessions in the handler).
    'job_notes',
    # Artifact creation — each writes a file into the workspace.
    'create_pptx', 'render_chart', 'render_video', 'draw_circuit',
    # Interactive HTML artifacts — writes an .html file into the workspace.
    'create_html_artifact',
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
})
_ORACLE_DESTRUCTIVE = frozenset({
    'clear_blackboard', 'delete_agent', 'delete_alias', 'disconnect_integration',
    'delete_folder', 'delete_session', 'delete_sessions', 'kill_daemon',
    'kill_daemons',
    # Bot Mode routines: removes a Bot-owned scheduled job.
    'delete_routine',
    # Circuit workbench: removes a netlist file from the workspace.
    'circuit_delete_netlist',
})
_ORACLE_SHELL = frozenset({'run_command', 'run_commands', 'simulate_circuit', 'circuit_simulate', 'circuit_test', 'circuit_export_vcd', 'circuit_annotate', 'firmware_compile', 'firmware_run', 'hdl_lint', 'hdl_simulate', 'hdl_test', 'fpga_compile', 'kicad_checks'})
_ORACLE_AGENT = frozenset({
    'create_agent', 'list_agents', 'list_daemons', 'spawn_daemon',
    'spawn_subagents', 'update_agent', 'set_agent_mode',
    'list_workstreams', 'send_subagent_message', 'interrupt_subagent',
    # Bot Mode routines: Bot-owned scheduled jobs.
    'create_routine', 'list_routines',
    # Bot Mode Phase C: the single agent-to-agent DM send path (policy had
    # this bucketed; the oracle drifted until a full-suite order registered
    # dm tools and surfaced it — Part 26 wave fix).
    'message_agent',
})
_ORACLE_SKILL = frozenset({'list_skills', 'load_skill', 'load_skills'})
_ORACLE_BRIDGE = frozenset({'tool_call', 'tool_describe', 'tool_search'})
_ORACLE_BUCKETS = {
    'tool_read': _ORACLE_READ, 'tool_write': _ORACLE_WRITE,
    'tool_destructive': _ORACLE_DESTRUCTIVE, 'tool_shell': _ORACLE_SHELL,
    'tool_agent': _ORACLE_AGENT, 'tool_skill': _ORACLE_SKILL,
    'tool_bridge': _ORACLE_BRIDGE,
}


def _oracle_classify(name: str) -> str:
    n = (name or '').strip()
    if not n:
        return 'tool_other'
    for bucket, names in _ORACLE_BUCKETS.items():
        if n in names:
            return bucket
    return 'tool_other'


# Old isPlanModeBlocked (from workbench.py pre-consolidation).
_ORACLE_PLAN_EXACT = frozenset({
    'write_file', 'edit_file', 'create_file', 'str_replace', 'str_replace_editor',
    'strreplaceeditttool', 'apply_patch', 'patch_file', 'delete_file',
    'remove_file', 'move_file', 'rename_file', 'mkdir', 'makedirs',
    'run_command', 'bash', 'bashtool', 'shell', 'exec', 'execute', 'terminal',
    'install', 'uninstall', 'pip_install', 'npm_install', 'pnpm_add',
    'browser_click', 'browser_type', 'browser_select', 'browser_evaluate',
    'create_agent', 'update_agent', 'delete_agent', 'create_alias',
    'update_alias', 'delete_alias', 'configure_fallback',
    # Bot Mode routines — persists a scheduled job that fires later.
    'create_routine',
    'connect_github', 'connect_slack', 'connect_google', 'install_mcp_server',
    'disconnect_integration',
})
_ORACLE_PLAN_MARKERS = (
    'write', 'edit', 'delete', 'remove', 'install', 'uninstall',
    'exec', 'command', 'bash', 'shell', 'patch', 'rename', 'kill_daemon',
)


def _oracle_plan_blocked(name: str, args: dict | None = None) -> bool:
    if not name:
        return False
    n = name.lower()
    if n in _ORACLE_PLAN_EXACT:
        return True
    if n in {'rename_session', 'renamesession'}:
        return False
    if n == 'bulk':
        op = as_str((args or {}).get('operation')).lower().replace('-', '_')
        mutating_ops = {
            'write_files', 'write_file', 'write', 'delete_sessions',
            'delete_session', 'rename_sessions', 'rename_session',
            'kill_daemons', 'kill_daemon',
        }
        return op in mutating_ops or any(m in op for m in ('write', 'delete', 'rename', 'kill'))
    if n in {'write_files', 'delete_sessions', 'rename_sessions', 'kill_daemons'}:
        return True
    # Circuit netlist CRUD — workspace file writes/edits.
    if n in {'circuit_create_netlist', 'circuit_update_netlist'}:
        return True
    return any(marker in n for marker in _ORACLE_PLAN_MARKERS)


# Old isShellMutationTool (from workbench.py pre-consolidation), plus the
# registered circuit_simulate tool — it spawns the ngspice binary and gets
# the same edit-mode gating as its legacy simulate_circuit alias.
_ORACLE_SHELL_EXACT = frozenset({
    'run_command', 'bash', 'bashtool', 'shell', 'exec', 'execute', 'terminal',
    'install', 'uninstall', 'pip_install', 'npm_install', 'pnpm_add',
    'install_mcp_server',
    # Spawns the ngspice binary — classified shell-side like run_command.
    # circuit_test wraps simulate_circuit, so it spawns the binary too;
    # circuit_export_vcd runs the deck through eprvcd for the VCD artifact;
    # firmware_compile spawns arduino-cli / avr-gcc for the HEX artifact;
    # firmware_run spawns the Node avr8js sidecar; hdl_lint/hdl_simulate/
    # hdl_test spawn ghdl/verilator/iverilog/cocotb child processes.
    'simulate_circuit', 'circuit_simulate', 'circuit_test',
    'circuit_export_vcd', 'circuit_annotate', 'firmware_compile',
    'firmware_run', 'hdl_lint', 'hdl_simulate', 'hdl_test',
    # Quartus full-flow compile (map→fit→asm→sta) — spawns quartus_sh.
    'fpga_compile',
    # ERC/DRC gate — spawns kicad-cli sch erc / pcb drc; read-only on
    # the design files (no workspace writes).
    'kicad_checks',
})


def _oracle_shell_mutation(name: str, args: dict | None = None) -> bool:
    if not name:
        return False
    n = name.lower()
    if n in _ORACLE_SHELL_EXACT:
        return True
    if n == 'bulk':
        op = as_str((args or {}).get('operation')).lower().replace('-', '_')
        return op in {'run_command', 'bash', 'shell', 'exec'}
    return any(m in n for m in ('bash', 'shell', 'terminal', 'run_command'))


# ── Test data ─────────────────────────────────────────────────────────────

_MCP_NAMES = [
    'mcp__workspace__write_file', 'mcp__workspace__bash', 'mcp__workspace__read',
    'mcp__workspace__delete_thing', 'mcp__server__run_command',
    'mcp__server__shell_exec', 'mcp__server__list_files',
    'mcp__server__terminal_open', 'mcp__custom__patch_file',
    'mcp__custom__rename_thing', 'mcp__custom__install_pkg',
]

_BULK_OPS = [
    'write_files', 'write_file', 'write', 'delete_sessions', 'delete_session',
    'rename_sessions', 'rename_session', 'kill_daemons', 'kill_daemon',
    'run_command', 'bash', 'shell', 'exec', 'read_files', 'list',
]


def _all_registered_names() -> list[str]:
    from app.services.tool_registry import listRaw
    return [t['name'] for t in listRaw()]


@pytest.fixture(scope='module', autouse=True)
def _register_all():
    from app.services import integration_tools, tool_registry

    # Snapshot + restore: the registered integration tools leak into the
    # global registry and break later test modules (e.g. the workbench tool
    # definitions suite) that assert on the exact tool surface.
    before = {t['name'] for t in tool_registry.listRaw()}
    integration_tools.register()
    yield
    for entry in tool_registry.listRaw():
        if entry['name'] not in before:
            tool_registry.unregister(entry['name'])


class TestPromptBucketParity:
    def test_registered_tools(self):
        for name in _all_registered_names():
            assert tool_policy.prompt_bucket(name) == _oracle_classify(name), name

    def test_mcp_names(self):
        for name in _MCP_NAMES:
            assert tool_policy.prompt_bucket(name) == _oracle_classify(name), name


class TestIsMutatingParity:
    def test_registered_tools(self):
        for name in _all_registered_names():
            assert tool_policy.is_mutating(name) == _oracle_plan_blocked(name), name

    def test_mcp_names(self):
        for name in _MCP_NAMES:
            assert tool_policy.is_mutating(name) == _oracle_plan_blocked(name), name

    def test_bulk_operations(self):
        for op in _BULK_OPS:
            args = {'operation': op}
            assert tool_policy.is_mutating('bulk', args) == _oracle_plan_blocked('bulk', args), op

    def test_rename_session_exempt(self):
        assert tool_policy.is_mutating('rename_session') is False

    def test_rename_file_is_mutating(self):
        assert tool_policy.is_mutating('rename_file') is True


class TestIsShellMutationParity:
    def test_registered_tools(self):
        for name in _all_registered_names():
            assert tool_policy.is_shell_mutation(name) == _oracle_shell_mutation(name), name

    def test_mcp_names(self):
        for name in _MCP_NAMES:
            assert tool_policy.is_shell_mutation(name) == _oracle_shell_mutation(name), name

    def test_bulk_operations(self):
        for op in _BULK_OPS:
            args = {'operation': op}
            assert tool_policy.is_shell_mutation('bulk', args) == _oracle_shell_mutation('bulk', args), op


class TestNeedsApprovalParity:
    def test_full_mode_allows_all(self):
        for name in _all_registered_names():
            assert tool_policy.needs_approval_in('full', name) is False

    def test_plan_mode_matches_is_mutating(self):
        for name in _all_registered_names():
            assert tool_policy.needs_approval_in('plan', name) == tool_policy.is_mutating(name)

    def test_edit_mode_matches_is_shell(self):
        for name in _all_registered_names():
            assert tool_policy.needs_approval_in('edit', name) == tool_policy.is_shell_mutation(name)

    def test_ask_mode_matches_is_mutating(self):
        for name in _all_registered_names():
            assert tool_policy.needs_approval_in('ask', name) == tool_policy.is_mutating(name)
