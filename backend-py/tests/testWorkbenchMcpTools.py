"""Chunk 2 — real MCP server tools are presented to the model AND dispatchable.

Two assertions:
  1. After refreshing MCP tools, a discovered MCP tool appears in BOTH the
     Anthropic-format and OpenAI-format workbench tool lists (with the
     ``mcp__<server>__<tool>`` prefix).
  2. ``_execute_tool`` routes ``mcp__*`` names to ``execute_mcp_tool_call``
     (not the registry, which would return "Tool not found").
"""
from __future__ import annotations
import asyncio
import pytest
from app.services import toolDefinitions as toolDefsModule
from app.services import toolRegistry
from app.services.tools import mcpClient
from app.services.workbench.workbench import WorkbenchSession, _executeTool, openaiToolDefinitions, toolDefinitions

@pytest.fixture(autouse=True)
def _isolateMcpState(monkeypatch):
    """Start each test with empty MCP server + cache state."""
    monkeypatch.setattr(mcpClient, '_servers', {})
    monkeypatch.setattr(mcpClient, '_toolsCache', {})
    yield

@pytest.fixture(scope='module', autouse=True)
def _registerTools():
    if not toolRegistry.listTools():
        toolDefsModule.registerAll()
    yield

@pytest.fixture
def session() -> WorkbenchSession:
    return WorkbenchSession(id='wb_test_mcp')
MCP_SERVER_ID = 'mcp_test1234'
MCP_TOOL_NAME = 'mcp__mcp_test1234__summarize'

def _seedMcpCache():
    """Populate the MCP tool cache as if discovery ran."""
    mcpClient._toolsCache[MCP_SERVER_ID] = [{'name': 'summarize', 'description': 'Summarize a document.', 'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}}}]

class TestMcpToolsPresented:

    def testAnthropicFormat(self, session):
        _seedMcpCache()
        tools = toolDefinitions(session)
        t = next((x for x in tools if x['name'] == MCP_TOOL_NAME), None)
        assert t is not None, 'MCP tool missing from anthropic tool list'
        assert 'input_schema' in t
        assert 'type' not in t and 'function' not in t
        assert t['input_schema']['properties']['text']['type'] == 'string'

    def testOpenaiFormat(self, session):
        _seedMcpCache()
        tools = openaiToolDefinitions(session)
        t = next((x for x in tools if x['function']['name'] == MCP_TOOL_NAME), None)
        assert t is not None, 'MCP tool missing from openai tool list'
        assert t['type'] == 'function'
        assert t['function']['parameters']['properties']['text']['type'] == 'string'

    def testDedupedAgainstRegistry(self, session):
        _seedMcpCache()
        names = [t['name'] for t in toolDefinitions(session)]
        assert names.count(MCP_TOOL_NAME) == 1

class TestMcpToolDispatch:

    @pytest.mark.asyncio
    async def testMcpNameRoutesToMcpClient(self, session, monkeypatch):
        _seedMcpCache()
        called: dict[str, object] = {}

        async def fakeExecuteMcpToolCall(name, args):
            called['name'] = name
            called['args'] = args
            return 'MCP_RESULT'
        # workbench._executeTool does a local import of mcpClient.executeMcpToolCall,
        # so monkeypatch the source module instead.
        monkeypatch.setattr(mcpClient, 'executeMcpToolCall', fakeExecuteMcpToolCall)
        result = await _executeTool(MCP_TOOL_NAME, {'text': 'hi'}, session)
        assert result == 'MCP_RESULT'
        assert called.get('name') == MCP_TOOL_NAME
        assert called.get('args') == {'text': 'hi'}

    @pytest.mark.asyncio
    async def testRegistryToolNotRoutedToMcp(self, session, monkeypatch):
        """A non-mcp__ name must still hit the registry, not the MCP client."""
        mcpCalls: list[str] = []

        async def fakeExecuteMcpToolCall(name, args):
            mcpCalls.append(name)
            return 'SHOULD_NOT_HAPPEN'
        monkeypatch.setattr(mcpClient, 'executeMcpToolCall', fakeExecuteMcpToolCall)
        result = await _executeTool('read_file', {'path': '/nonexistent-test'}, session)
        assert mcpCalls == []
        assert 'Error:' in result or 'not found' in result.lower() or result.startswith('Error') or ('File not found' in result)

class TestRefreshMcpTools:

    @pytest.mark.asyncio
    async def testRefreshPopulatesCache(self, monkeypatch):
        srv = mcpClient.registerServer('fake', 'echo', [])

        async def fakeDiscover(sid):
            mcpClient._toolsCache[sid] = [{'name': 'ping', 'description': 'Pong.', 'inputSchema': {'type': 'object', 'properties': {}}}]
            return mcpClient._toolsCache[sid]
        monkeypatch.setattr(mcpClient, 'discoverTools', fakeDiscover)
        await mcpClient.refreshMcpTools()
        defs = mcpClient.getMcpToolDefinitionsSync()
        names = [d['function']['name'] for d in defs]
        assert any((n == f"mcp__{srv['id']}__ping" for n in names))

    @pytest.mark.asyncio
    async def testRefreshSwallowsPerServerErrors(self, monkeypatch):
        srv = mcpClient.registerServer('bad', 'echo', [])

        async def fakeDiscover(sid):
            raise RuntimeError('boom')
        monkeypatch.setattr(mcpClient, 'discoverTools', fakeDiscover)
        await mcpClient.refreshMcpTools()
        assert srv['status'] in ('error', 'registered') or 'error' in srv

def testAssembleToolDefsKeepsMcpToolsAsCore():
    """Even when deferrable token mass is over threshold, mcp__ tools must be presented."""
    from app.services.tools.modelTools import assembleToolDefs
    bigDeferrable = [{'name': f'big_tool_{i}', 'description': 'x' * 200, 'input_schema': {'type': 'object'}} for i in range(300)]
    mcpTools = [{'name': 'mcp__github__list_prs', 'description': 'List PRs', 'input_schema': {'type': 'object'}}, {'name': 'mcp__workspace__create_doc', 'description': 'Create doc', 'input_schema': {'type': 'object'}}]
    allTools = bigDeferrable + mcpTools
    result = assembleToolDefs(allTools, contextMessages=None, contextLength=200000)
    assert result.activated
    toolNames = {t.get('name') for t in result.tool_defs}
    assert 'mcp__github__list_prs' in toolNames
    assert 'mcp__workspace__create_doc' in toolNames

def testGetMcpToolDefinitionsSyncTriggersLazyRefresh(monkeypatch):
    """When the cache is empty but servers are registered, lazy refresh kicks in."""
    from app.services.tools import mcpClient
    import asyncio
    monkeypatch.setattr(mcpClient, '_servers', {'mcp_xyz': {'id': 'mcp_xyz', 'name': 'x'}})
    monkeypatch.setattr(mcpClient, '_toolsCache', {})
    refreshCalled = {'v': False}

    async def fakeRefresh():
        refreshCalled['v'] = True
        mcpClient._toolsCache['mcp_xyz'] = [{'name': 'demo', 'description': 'demo', 'inputSchema': {}}]
    monkeypatch.setattr(mcpClient, 'refreshMcpTools', fakeRefresh)

    async def runner():
        return mcpClient.getMcpToolDefinitionsSync()
    asyncio.run(runner())
    assert refreshCalled['v'] is True