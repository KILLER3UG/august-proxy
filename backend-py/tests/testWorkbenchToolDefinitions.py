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
    return WorkbenchSession(id='wb_test_tooldefs')


class TestAnthropicFormat:
    def testAllRegistryToolsPresentAnthropic(self, session):
        tools = toolDefinitions(session)
        names = {t['name'] for t in tools}
        for reg in tool_registry.listTools():
            expected = reg['function']['name']
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
            assert reg['function']['name'] in names

    def testOpenaiShape(self, session):
        for t in openaiToolDefinitions(session):
            assert t.get('type') == 'function'
            fn = t['function']
            assert 'name' in fn and fn['name']
            assert 'parameters' in fn

    def testNoDuplicates(self, session):
        names = [t['function']['name'] for t in openaiToolDefinitions(session)]
        assert len(names) == len(set(names))


PASSTHROUGH_NAMES = {'mcp__workspace__bash', 'WebSearch', 'WebFetch'}


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


@pytest.mark.parametrize('toolName', ['read_file', 'list_skills', 'desktop_screenshot', 'spawn_subagent'])
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
