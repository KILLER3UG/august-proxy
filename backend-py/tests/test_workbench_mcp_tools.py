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

from app.services import tool_definitions as tool_defs_module
from app.services import tool_registry
from app.services.tools import mcp_client
from app.services.workbench.workbench import (
    WorkbenchSession,
    _execute_tool,
    openai_tool_definitions,
    tool_definitions,
)


@pytest.fixture(autouse=True)
def _isolate_mcp_state(monkeypatch):
    """Start each test with empty MCP server + cache state."""
    monkeypatch.setattr(mcp_client, "_servers", {})
    monkeypatch.setattr(mcp_client, "_tools_cache", {})
    yield


@pytest.fixture(scope="module", autouse=True)
def _register_tools():
    if not tool_registry.list_tools():
        tool_defs_module.register_all()
    yield


@pytest.fixture
def session() -> WorkbenchSession:
    return WorkbenchSession(id="wb_test_mcp")


MCP_SERVER_ID = "mcp_test1234"
MCP_TOOL_NAME = "mcp__mcp_test1234__summarize"


def _seed_mcp_cache():
    """Populate the MCP tool cache as if discovery ran."""
    mcp_client._tools_cache[MCP_SERVER_ID] = [{
        "name": "summarize",
        "description": "Summarize a document.",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}},
    }]


# ── Presentation ──────────────────────────────────────────────────────


class TestMcpToolsPresented:
    def test_anthropic_format(self, session):
        _seed_mcp_cache()
        tools = tool_definitions(session)
        t = next((x for x in tools if x["name"] == MCP_TOOL_NAME), None)
        assert t is not None, "MCP tool missing from anthropic tool list"
        assert "input_schema" in t
        assert "type" not in t and "function" not in t
        assert t["input_schema"]["properties"]["text"]["type"] == "string"

    def test_openai_format(self, session):
        _seed_mcp_cache()
        tools = openai_tool_definitions(session)
        t = next((x for x in tools if x["function"]["name"] == MCP_TOOL_NAME), None)
        assert t is not None, "MCP tool missing from openai tool list"
        assert t["type"] == "function"
        assert t["function"]["parameters"]["properties"]["text"]["type"] == "string"

    def test_deduped_against_registry(self, session):
        _seed_mcp_cache()
        names = [t["name"] for t in tool_definitions(session)]
        assert names.count(MCP_TOOL_NAME) == 1


# ── Dispatch ──────────────────────────────────────────────────────────


class TestMcpToolDispatch:
    @pytest.mark.asyncio
    async def test_mcp_name_routes_to_mcp_client(self, session, monkeypatch):
        _seed_mcp_cache()

        called: dict[str, object] = {}

        async def fake_execute_mcp_tool_call(name, args):
            called["name"] = name
            called["args"] = args
            return "MCP_RESULT"

        monkeypatch.setattr(
            "app.services.workbench.workbench.execute_mcp_tool_call"
            if False
            else "app.services.tools.mcp_client.execute_mcp_tool_call",
            fake_execute_mcp_tool_call,
        )

        result = await _execute_tool(MCP_TOOL_NAME, {"text": "hi"}, session)

        assert result == "MCP_RESULT"
        assert called.get("name") == MCP_TOOL_NAME
        assert called.get("args") == {"text": "hi"}

    @pytest.mark.asyncio
    async def test_registry_tool_not_routed_to_mcp(self, session, monkeypatch):
        """A non-mcp__ name must still hit the registry, not the MCP client."""
        mcp_calls: list[str] = []

        async def fake_execute_mcp_tool_call(name, args):
            mcp_calls.append(name)
            return "SHOULD_NOT_HAPPEN"

        monkeypatch.setattr(
            "app.services.tools.mcp_client.execute_mcp_tool_call",
            fake_execute_mcp_tool_call,
        )

        # read_file is a registered registry tool — must NOT go to MCP.
        result = await _execute_tool("read_file", {"path": "/nonexistent-test"}, session)
        assert mcp_calls == []
        assert "Error:" in result or "not found" in result.lower() or result.startswith("Error") or "File not found" in result


# ── refresh_mcp_tools ────────────────────────────────────────────────


class TestRefreshMcpTools:
    @pytest.mark.asyncio
    async def test_refresh_populates_cache(self, monkeypatch):
        # Register a server, monkeypatch discover_tools to avoid subprocess.
        srv = mcp_client.register_server("fake", "echo", [])

        async def fake_discover(sid):
            mcp_client._tools_cache[sid] = [{
                "name": "ping",
                "description": "Pong.",
                "inputSchema": {"type": "object", "properties": {}},
            }]
            return mcp_client._tools_cache[sid]

        monkeypatch.setattr(mcp_client, "discover_tools", fake_discover)

        await mcp_client.refresh_mcp_tools()

        defs = mcp_client.get_mcp_tool_definitions_sync()
        names = [d["function"]["name"] for d in defs]
        assert any(n == f"mcp__{srv['id']}__ping" for n in names)

    @pytest.mark.asyncio
    async def test_refresh_swallows_per_server_errors(self, monkeypatch):
        srv = mcp_client.register_server("bad", "echo", [])

        async def fake_discover(sid):
            raise RuntimeError("boom")

        monkeypatch.setattr(mcp_client, "discover_tools", fake_discover)

        # Must not raise — one bad server shouldn't blank the rest.
        await mcp_client.refresh_mcp_tools()
        assert srv["status"] in ("error", "registered") or "error" in srv
