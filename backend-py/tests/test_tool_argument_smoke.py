"""Tool argument-robustness smoke matrix — 2026-09-08 batch, item 6d.

The complaint that started this: a model passed ``edit_lines``'s ``changes``
as a stringified JSON array, the handler iterated the string, and the raw
Python text ``'str' object has no attribute 'get'`` came back as the tool
result — sending the model into a confused retry spiral.

This matrix dispatches every registered tool with the malformed argument
shapes models actually produce — missing required params, stringified
JSON arrays/objects, wrong scalar types — and asserts no raw Python
exception text ever reaches the result string. Handlers may legitimately
return an ``Error:``/``Error executing`` receipt; what they must never do
is leak an interpreter message the model cannot act on.

Tools whose empty-argument call would perform real I/O (desktop control,
network, provider calls, destructive deletes, external EDA toolchains,
sub-agent orchestration) are listed in ``_IO_ALLOWLIST`` and only checked
for schema presence — this audit covers argument handling, not live I/O.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from app.services import tool_registry
from app.services.tool_registrations import register_all
from app.services.workbench.context import currentSessionId

# Fragments of CPython error text that must never surface as a tool result.
# (Class names alone are fine — the schema-aware receipt deliberately names
# the exception type; these are the message bodies.)
_RAW_PY_SIGS = (
    'object has no attribute',
    'not subscriptable',
    'unsupported operand type',
    'must be str, not',
    'positional argument',
    'unexpected keyword argument',
    'indices must be integers',
    'string indices must be integers',
    'unhashable type',
    'invalid literal for',
    'can only concatenate',
    "object of type 'NoneType'",
    'is not iterable',
    'not JSON serializable',
    'cannot unpack',
    'expected string or bytes-like object',
    'object supporting the buffer API',
    'has no len()',
    'is not a dict',  # e.g. 'list' object is not a dict style leaks
)

# Tools that touch the machine / network / other sessions with empty or
# garbage args. Skipped for dispatch; schema-presence checked only.
_IO_ALLOWLIST = frozenset({
    # Desktop automation — would move the real mouse / screenshot / type.
    'desktop_click', 'desktop_list_windows', 'desktop_mouse_position',
    'desktop_open_url', 'desktop_press_key', 'desktop_screen_size',
    'desktop_screenshot', 'desktop_type', 'camera_snapshot',
    'desktop_ui_tree', 'desktop_ui_act',
    # Artifact judge — headless LibreOffice / PDF raster (external
    # toolchain) + a vision provider call.
    'render_pages', 'judge_artifact',
    # Network / provider I/O.
    'web_search', 'web_fetch', 'web_fetch_many', 'vision_analyze',
    'analyze_media', 'search',
    # External EDA / compile toolchains (slow subprocesses).
    'circuit_annotate', 'circuit_create_netlist', 'circuit_delete_netlist',
    'circuit_env', 'circuit_export_vcd', 'circuit_inject_fault',
    'circuit_integrate_component', 'circuit_lint_diagram', 'circuit_list_boards',
    'circuit_list_netlists', 'circuit_read_netlist', 'circuit_render_3d',
    'circuit_search_component', 'circuit_simulate', 'circuit_symbolic',
    'circuit_test', 'circuit_update_netlist', 'draw_circuit',
    'firmware_compile', 'firmware_run', 'firmware_stimulus',
    'fpga_compile', 'hdl_lint', 'hdl_simulate', 'hdl_test',
    'hdl_timing_diagram', 'kicad_checks', 'kicad_render', 'vcd_parse',
    # Destructive / cross-session mutations.
    'delete_session', 'delete_sessions', 'delete_folder', 'rename_session',
    'rename_sessions', 'kill_daemon', 'kill_daemons', 'spawn_daemon',
    # Agent orchestration / config mutation.
    'spawn_subagents', 'send_subagent_message', 'interrupt_subagent',
    'message_agent', 'setup_provider', 'install_mcp_server',
    'connect_github', 'connect_google', 'connect_slack', 'disconnect_integration',
    'configure_fallback', 'customize_ui', 'set_agent_mode', 'enter_plan_mode',
    # Bridge that re-dispatches to arbitrary other tools.
    'tool_call',
    # Heavy artifact renderers (provider-backed image/video models).
    'render_video', 'render_chart',
})


@pytest.fixture(scope='module')
def registry() -> dict[str, dict[str, Any]]:
    register_all()
    return tool_registry._registry  # noqa: SLF001 — read-only inspection


@pytest.fixture()
def smoke_session(tmp_path, monkeypatch):
    """A workspace-write session anchored at tmp_path — the conftest
    ``isolatedData`` fixture already redirects the brain SQLite and data dir
    to a per-test temp path, so memory tools and file writes stay sandboxed
    to tmp."""
    from app.services.workbench import sessions as sess_mod

    fake = SimpleNamespace(
        id='smoke-session',
        workspacePath=str(tmp_path),
        guardMode='full',
        sandboxMode='workspace-write',
        todos=[],
        pendingMutations=[],
        turnCount=1,
        model='test-model',
        provider='test',
        agent_mode='agent',
        title='smoke',
    )
    monkeypatch.setattr(sess_mod, 'get_workbench_session', lambda sid: fake)
    token = currentSessionId.set('smoke-session')
    yield fake
    currentSessionId.reset(token)


def _required_params(tool: dict[str, Any]) -> list[tuple[str, str]]:
    params = tool.get('parameters') or {}
    props = params.get('properties') if isinstance(params, dict) else None
    required = params.get('required') if isinstance(params, dict) else None
    if not isinstance(props, dict) or not isinstance(required, list):
        return []
    out: list[tuple[str, str]] = []
    for key in required:
        spec = props.get(key)
        typ = spec.get('type') if isinstance(spec, dict) else None
        out.append((str(key), str(typ or '')))
    return out


def _variants(tool: dict[str, Any]) -> list[tuple[str, dict[str, object]]]:
    """Malformed-argument variants for one tool."""
    req = _required_params(tool)
    variants: list[tuple[str, dict[str, object]]] = [('empty', {})]
    for key, typ in req:
        if typ == 'array':
            variants.append((f'stringified-array:{key}', {key: '[{"line": 1, "old": "a", "new": "b"}]'}))
        elif typ == 'object':
            variants.append((f'stringified-object:{key}', {key: '{"a": "b"}'}))
        variants.append((f'wrong-type:{key}', {key: 42}))
    # A single dict where a list is expected (models omit the array wrapper).
    for key, typ in req:
        if typ == 'array':
            variants.append((f'single-object:{key}', {key: {'line': 1, 'old': 'a', 'new': 'b'}}))
    return variants


def _assert_clean(name: str, variant: str, result: object) -> None:
    assert isinstance(result, str), f'{name} [{variant}] returned {type(result).__name__}, not str'
    leaks = [sig for sig in _RAW_PY_SIGS if sig in result]
    assert not leaks, (
        f'{name} [{variant}] leaked raw Python text {leaks}: {result[:300]!r}'
    )


@pytest.mark.asyncio
async def test_matrix_covers_most_tools(registry):
    """Guard against the allow-list silently swallowing the whole registry."""
    dispatched = set(registry) - _IO_ALLOWLIST
    assert len(dispatched) >= 40, f'only {len(dispatched)} tools audited — allow-list too broad?'


@pytest.mark.asyncio
async def test_io_allowlist_tools_have_schemas(registry):
    for name in sorted(_IO_ALLOWLIST & set(registry)):
        params = registry[name].get('parameters')
        assert isinstance(params, dict) and params, f'{name} missing a parameter schema'


@pytest.mark.asyncio
async def test_malformed_args_never_leak_python(registry, smoke_session):
    failures: list[str] = []
    for name in sorted(set(registry) - _IO_ALLOWLIST):
        tool = registry[name]
        for variant, args in _variants(tool):
            try:
                result = await tool_registry.dispatch(name, args)
            except Exception as exc:  # dispatch itself must not raise
                failures.append(f'{name} [{variant}] dispatch raised {type(exc).__name__}: {exc}')
                continue
            try:
                _assert_clean(name, variant, result)
            except AssertionError as exc:
                failures.append(str(exc))
    assert not failures, '\n'.join(failures[:20])


@pytest.mark.asyncio
async def test_edit_lines_stringified_changes_coerced(registry, smoke_session, tmp_path):
    """The reported bug: changes as a JSON string must be COERCED and
    applied, not crash and not reject — the model's intent was valid."""
    import hashlib

    target = tmp_path / 'f.txt'
    target.write_text('alpha\nbeta\ngamma\n', newline='\n')
    file_hash = hashlib.sha256(target.read_bytes()).hexdigest()
    changes = json.dumps([{'line': 2, 'old': 'beta', 'new': 'BETA'}])
    result = await tool_registry.dispatch(
        'edit_lines', {'path': str(target), 'fileHash': file_hash, 'changes': changes}
    )
    assert 'Error' not in result, result
    assert target.read_text() == 'alpha\nBETA\ngamma\n'


@pytest.mark.asyncio
async def test_edit_lines_single_object_changes_coerced(registry, smoke_session, tmp_path):
    import hashlib

    target = tmp_path / 'g.txt'
    target.write_text('one\ntwo\n', newline='\n')
    file_hash = hashlib.sha256(target.read_bytes()).hexdigest()
    result = await tool_registry.dispatch(
        'edit_lines',
        {'path': str(target), 'fileHash': file_hash, 'changes': {'line': 1, 'old': 'one', 'new': 'ONE'}},
    )
    assert 'Error' not in result, result
    assert target.read_text() == 'ONE\ntwo\n'


@pytest.mark.asyncio
async def test_edit_lines_garbage_string_gets_actionable_error(registry, smoke_session, tmp_path):
    import hashlib

    target = tmp_path / 'h.txt'
    target.write_text('x\n', newline='\n')
    file_hash = hashlib.sha256(target.read_bytes()).hexdigest()
    result = await tool_registry.dispatch(
        'edit_lines', {'path': str(target), 'fileHash': file_hash, 'changes': 'not json at all'}
    )
    assert result.startswith('Error:')
    assert 'JSON' in result or 'array' in result
    _assert_clean('edit_lines', 'garbage-string', result)
