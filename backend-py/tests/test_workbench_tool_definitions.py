"""Chunk 1 — workbench tool definitions: format, dedupe, no passthrough tools.

Asserts every registered tool appears in the correct format for BOTH the
Anthropic path (``name``/``description``/``input_schema``) and the OpenAI
path (``function.name``/``function.parameters``), and that the proxy
passthrough-only ``mcp__workspace__*`` / ``WebSearch`` / ``WebFetch``
tools are NOT presented (they aren't dispatchable in the workbench).
"""
from __future__ import annotations

import pytest

from app.services import tool_definitions as tool_defs_module
from app.services import tool_registry
from app.services.workbench.workbench import (
    WorkbenchSession,
    openai_tool_definitions,
    tool_definitions,
)


@pytest.fixture(scope="module", autouse=True)
def _register_tools():
    """Ensure the full tool registry is populated for these tests."""
    if not tool_registry.list_tools():
        tool_defs_module.register_all()
    yield


@pytest.fixture
def session() -> WorkbenchSession:
    return WorkbenchSession(id="wb_test_tooldefs")


# ── Format correctness ───────────────────────────────────────────────


class TestAnthropicFormat:
    def test_all_registry_tools_present_anthropic(self, session):
        tools = tool_definitions(session)
        names = {t["name"] for t in tools}
        for reg in tool_registry.list_tools():
            expected = reg["function"]["name"]
            assert expected in names, f"{expected} missing from anthropic tool list"

    def test_anthropic_shape(self, session):
        for t in tool_definitions(session):
            assert "name" in t and isinstance(t["name"], str) and t["name"]
            assert "description" in t
            assert "input_schema" in t, f"{t.get('name')} missing input_schema"
            assert "type" not in t, f"{t.get('name')} has OpenAI 'type' wrapper"
            assert "function" not in t, f"{t.get('name')} has OpenAI 'function' wrapper"

    def test_no_duplicates(self, session):
        names = [t["name"] for t in tool_definitions(session)]
        assert len(names) == len(set(names))


class TestOpenAIFormat:
    def test_all_registry_tools_present_openai(self, session):
        tools = openai_tool_definitions(session)
        names = {t["function"]["name"] for t in tools}
        for reg in tool_registry.list_tools():
            assert reg["function"]["name"] in names

    def test_openai_shape(self, session):
        for t in openai_tool_definitions(session):
            assert t.get("type") == "function"
            fn = t["function"]
            assert "name" in fn and fn["name"]
            assert "parameters" in fn

    def test_no_duplicates(self, session):
        names = [t["function"]["name"] for t in openai_tool_definitions(session)]
        assert len(names) == len(set(names))


# ── Passthrough-only tools absent ─────────────────────────────────────

PASSTHROUGH_NAMES = {"mcp__workspace__bash", "WebSearch", "WebFetch"}


class TestNoPassthroughTools:
    def test_absent_from_anthropic(self, session):
        names = {t["name"] for t in tool_definitions(session)}
        for n in PASSTHROUGH_NAMES:
            assert n not in names, f"passthrough tool {n} should not be in workbench list"

    def test_absent_from_openai(self, session):
        names = {t["function"]["name"] for t in openai_tool_definitions(session)}
        for n in PASSTHROUGH_NAMES:
            assert n not in names

    def test_workbench_has_own_web_tools(self, session):
        """The workbench's own dispatchable web/shell tools ARE present."""
        anth_names = {t["name"] for t in tool_definitions(session)}
        for expected in ("web_search", "web_fetch", "run_command"):
            assert expected in anth_names, f"workbench tool {expected} missing"


# ── Representative tool schemas survive conversion ────────────────────


@pytest.mark.parametrize("tool_name", [
    "read_file",          # has required props
    "list_skills",        # empty required list
    "desktop_screenshot", # empty properties/required
    "spawn_subagent",     # array property
])
def test_tool_schema_survives_conversion(session, tool_name):
    reg = next(r for r in tool_registry.list_tools()
               if r["function"]["name"] == tool_name)

    anth = next(t for t in tool_definitions(session) if t["name"] == tool_name)
    assert anth["input_schema"]["type"] == "object"
    assert "properties" in anth["input_schema"]

    oai = next(t for t in openai_tool_definitions(session)
               if t["function"]["name"] == tool_name)
    assert oai["function"]["parameters"]["type"] == "object"
    assert "properties" in oai["function"]["parameters"]

    # Required arrays match the original
    orig_req = reg["function"].get("parameters", {}).get("required", [])
    assert anth["input_schema"].get("required", []) == orig_req
    assert oai["function"]["parameters"].get("required", []) == orig_req
