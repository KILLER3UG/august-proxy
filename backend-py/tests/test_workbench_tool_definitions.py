"""Chunk 1 — workbench tool definitions: format, dedupe, no passthrough tools.

Asserts every registered tool appears in the correct format for BOTH the
Anthropic path (``name``/``description``/``input_schema``) and the OpenAI
path (``function.name``/``function.parameters``), and that the proxy
passthrough-only ``mcp__workspace__*`` / ``WebSearch`` / ``WebFetch``
tools are NOT presented (they aren't dispatchable in the workbench).
"""

from __future__ import annotations

import pytest
from app.services import tool_definitions as toolDefsModule
from app.services import tool_registry
from app.services.workbench.workbench import WorkbenchSession, openaiToolDefinitions, toolDefinitions


@pytest.fixture(scope='module', autouse=True)
def _registerTools():
    """Ensure the full tool registry is populated for these tests."""
    if not tool_registry.listTools():
        toolDefsModule.registerAll()
    yield


@pytest.fixture
def session() -> WorkbenchSession:
    # Model with a huge context window so progressive disclosure never
    # activates for these tests — they assert the FULL registered surface
    # (a small window would legitimately defer tools like browser_type).
    return WorkbenchSession(id='wb_test_tooldefs', model='gpt-4.1')


# Plan-gating tools are deliberately filtered per guard mode (Full Access must
# never expose plan approval; plan mode hides the now-redundant mode switch),
# so "every registered tool is present" skips exactly these.
FULL_MODE_BLOCKED = {'submit_plan', 'submitPlan', 'approve_plan', 'reject_plan'}
PLAN_MODE_BLOCKED = {'enter_plan_mode', 'request_plan_mode'}
# /circuit tools are visibility-gated per session (only present while the
# session's circuit workbench is ON) — skipped in the default-surface tests
# and covered positively by TestCircuitGateVisibility below. The gate owns
# the circuit_* names PLUS the firmware/HDL/VCD/FPGA/KiCad families.
CIRCUIT_MODE_PREFIX = 'circuit_'
# Phase C: message_agent is visibility-gated per session (only present in a
# Bot's canonical chat — see bot_mode.dm.filter_dm_tools), so the default
# (non-bot) session correctly omits it. Covered positively by
# tests/test_bot_mode_phase_c.py::TestGate.
DM_GATED = {'message_agent'}


def _is_circuit_gate_tool(name: str) -> bool:
    from app.services.tool_registrations.circuit_tools import (
        _is_circuit_gate_tool as owns,
    )

    return owns(name)


class TestAnthropicFormat:
    def testAllRegistryToolsPresentAnthropic(self, session):
        tools = toolDefinitions(session)
        names = {t['name'] for t in tools}
        for reg in tool_registry.listTools():
            expected = reg['function']['name']
            if expected in FULL_MODE_BLOCKED:
                continue  # session fixture runs in full mode
            if _is_circuit_gate_tool(expected):
                continue  # gated behind /circuit mode; covered below
            if expected in DM_GATED:
                continue  # gated to canonical Bot Chats; covered in phase C
            assert expected in names, f'{expected} missing from anthropic tool list'

    def testAnthropicShape(self, session):
        for t in toolDefinitions(session):
            assert 'name' in t and isinstance(t['name'], str) and t['name']
            assert 'description' in t
            assert 'input_schema' in t, f'{t.get("name")} missing input_schema'
            assert 'type' not in t, f"{t.get('name')} has OpenAI 'type' wrapper"
            assert 'function' not in t, f"{t.get('name')} has OpenAI 'function' wrapper"

    def testNoDuplicates(self, session):
        names = [t['name'] for t in toolDefinitions(session)]
        assert len(names) == len(set(names))


class TestOpenAIFormat:
    def testAllRegistryToolsPresentOpenai(self, session):
        tools = openaiToolDefinitions(session)
        names = {t['function']['name'] for t in tools}
        for reg in tool_registry.listTools():
            expected = reg['function']['name']
            if expected in FULL_MODE_BLOCKED:
                continue  # session fixture runs in full mode
            if _is_circuit_gate_tool(expected):
                continue  # gated behind /circuit mode; covered below
            if expected in DM_GATED:
                continue  # gated to canonical Bot Chats; covered in phase C
            assert expected in names

    def testOpenaiShape(self, session):
        for t in openaiToolDefinitions(session):
            assert t.get('type') == 'function'
            fn = t['function']
            assert 'name' in fn and fn['name']
            assert 'parameters' in fn

    def testNoDuplicates(self, session):
        names = [t['function']['name'] for t in openaiToolDefinitions(session)]
        assert len(names) == len(set(names))


class TestCircuitGateVisibility:
    """Positive coverage for the /circuit visibility gate on both formats."""

    def testCircuitToolsHiddenByDefaultAndShownInCircuitMode(self):
        from app.services.tools.circuit_tools import is_circuit_mode

        plain = WorkbenchSession(id='wb_plain', model='gpt-4.1')
        gated = WorkbenchSession(id='wb_circ', metadata={'circuitMode': True}, model='gpt-4.1')
        assert not is_circuit_mode(plain)
        assert is_circuit_mode(gated)

        # The gate owns circuit_* plus the firmware/HDL/VCD/FPGA/KiCad
        # families — every owned name must vanish from a plain session.
        for defs in (toolDefinitions(plain), openaiToolDefinitions(plain)):
            names = {
                t.get('name') or t['function']['name'] for t in defs
            }
            leaked = {n for n in names if _is_circuit_gate_tool(n)}
            assert not leaked, f'circuit-gate tools leaked into a plain session: {leaked}'

        # And ALL of them must be present when circuit mode is ON.
        for defs in (toolDefinitions(gated), openaiToolDefinitions(gated)):
            names = {
                t.get('name') or t['function']['name'] for t in defs
            }
            expected = {
                reg['function']['name']
                for reg in tool_registry.listTools()
                if _is_circuit_gate_tool(reg['function']['name'])
            }
            missing = expected - names
            assert not missing, f'circuit tools missing in circuit mode: {missing}'


PASSTHROUGH_NAMES = {'mcp__workspace__bash', 'WebSearch', 'WebFetch'}


class TestProgressiveDisclosureNoDupes:
    """Regression: when disclosure ACTIVATES (deferred tokens cross the
    10%-of-context threshold — the 125-tool registry does this at the
    default 128k window), the bridge tools (tool_call/tool_search/
    tool_describe) must not be duplicated with their registry copies,
    and every visible name stays unique on both wire formats."""

    def testActivatedSurfaceHasNoDuplicateBridgeTools(self):
        small = WorkbenchSession(id='wb_small_window', model='gpt-4o')
        for defs in (toolDefinitions(small), openaiToolDefinitions(small)):
            names = [t.get('name') or t['function']['name'] for t in defs]
            assert len(names) == len(set(names)), f'duplicate tools: {names}'
            for bridge in ('tool_call', 'tool_search', 'tool_describe'):
                assert names.count(bridge) == 1, f'{bridge} duplicated'


class TestNoPassthroughTools:
    def testAbsentFromAnthropic(self, session):
        names = {t['name'] for t in toolDefinitions(session)}
        for n in PASSTHROUGH_NAMES:
            assert n not in names, f'passthrough tool {n} should not be in workbench list'

    def testAbsentFromOpenai(self, session):
        names = {t['function']['name'] for t in openaiToolDefinitions(session)}
        for n in PASSTHROUGH_NAMES:
            assert n not in names

    def testWorkbenchHasOwnWebTools(self, session):
        """The workbench's own dispatchable web/shell tools ARE present."""
        anthNames = {t['name'] for t in toolDefinitions(session)}
        for expected in ('web_search', 'web_fetch', 'run_command'):
            assert expected in anthNames, f'workbench tool {expected} missing'


@pytest.mark.parametrize('toolName', ['read_file', 'list_skills', 'desktop_screenshot', 'spawn_subagents', 'edit_lines'])
def testToolSchemaSurvivesConversion(session, toolName):
    reg = next((r for r in tool_registry.listTools() if r['function']['name'] == toolName))
    anth = next((t for t in toolDefinitions(session) if t['name'] == toolName))
    assert anth['input_schema']['type'] == 'object'
    assert 'properties' in anth['input_schema']
    oai = next((t for t in openaiToolDefinitions(session) if t['function']['name'] == toolName))
    assert oai['function']['parameters']['type'] == 'object'
    assert 'properties' in oai['function']['parameters']
    origReq = reg['function'].get('parameters', {}).get('required', [])
    assert anth['input_schema'].get('required', []) == origReq
    assert oai['function']['parameters'].get('required', []) == origReq


class TestPlanModeToolFiltering:
    def testFullModeHidesPlanApprovalButOffersEnterPlanMode(self, session):
        names = {t['name'] for t in toolDefinitions(session)}
        assert 'submit_plan' not in names
        assert 'enter_plan_mode' in names

    def testPlanModeHidesEnterPlanModeButOffersSubmitPlan(self, session):
        session.guardMode = 'plan'
        names = {t['name'] for t in toolDefinitions(session)}
        assert 'enter_plan_mode' not in names
        assert 'submit_plan' in names
        # OpenAI format mirrors the same filtering.
        oaiNames = {t['function']['name'] for t in openaiToolDefinitions(session)}
        assert 'enter_plan_mode' not in oaiNames
        assert 'submit_plan' in oaiNames


@pytest.mark.asyncio
async def test_edit_lines_anchored_and_hash_verified(tmp_path):
    """edit_lines (R1): hash-verified, anchor-checked line replacement."""
    import hashlib

    from app.services.tool_registrations import file_tools as ft

    p = tmp_path / 'sample.txt'
    p.write_text('one\ntwo\nthree\n', encoding='utf-8')
    digest = hashlib.sha256(p.read_bytes()).hexdigest()

    # Anchor mismatch → rejected, file untouched.
    res = await ft._editLines(str(p), digest, [{'line': 2, 'old': 'TWO', 'new': 'deux'}])
    assert 'anchor mismatch' in res
    assert p.read_text(encoding='utf-8') == 'one\ntwo\nthree\n'

    # Stale hash → rejected.
    res = await ft._editLines(str(p), '0' * 64, [{'line': 2, 'old': 'two', 'new': 'deux'}])
    assert 'hash mismatch' in res

    # Missing hash → rejected with the re-read instruction.
    res = await ft._editLines(str(p), '', [{'line': 2, 'old': 'two', 'new': 'deux'}])
    assert 'fileHash' in res

    # Correct hash + anchors → applied (bottom-up so line numbers hold).
    res = await ft._editLines(
        str(p),
        digest,
        [
            {'line': 3, 'old': 'three', 'new': 'trois'},
            {'line': 2, 'old': 'two', 'new': 'deux'},
        ],
    )
    assert 'Applied 2 edits' in res
    assert p.read_text(encoding='utf-8') == 'one\ndeux\ntrois\n'

    # CRLF files keep their line endings.
    p2 = tmp_path / 'crlf.txt'
    p2.write_bytes(b'alpha\r\nbeta\r\n')
    digest2 = hashlib.sha256(p2.read_bytes()).hexdigest()
    res = await ft._editLines(str(p2), digest2, [{'line': 1, 'old': 'alpha', 'new': 'ALPHA'}])
    assert 'Applied 1 edit' in res
    assert p2.read_bytes() == b'ALPHA\r\nbeta\r\n'
