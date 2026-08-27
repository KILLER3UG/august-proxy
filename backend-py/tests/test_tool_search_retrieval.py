"""tool_search / tool_describe bridge fixes.

Regression root cause (2026-08-26 audit): ``handleToolSearch`` fed
``listTools()`` — OpenAI-wrapped ``{"type":"function","function":{...}}``
dicts — into ``buildToolCatalog()``, which reads ``tool.get('name')`` at the
TOP level. Every entry cataloged as name='' / description='', so BM25 ranked
102 empty documents and the no-hit fallback returned five empty strings.
``tool_search`` looked dead while actually "working".

Fix: unwrap OpenAI-wrapped defs once in ``buildToolCatalog`` so both raw and
wrapped shapes catalog correctly (progressive disclosure shares this module).
"""

from __future__ import annotations

import pytest
from app.services.tools.retrieval import buildToolCatalog, searchTools


def _openai(name: str, desc: str) -> dict[str, object]:
    return {
        'type': 'function',
        'function': {'name': name, 'description': desc, 'parameters': {'properties': {}}},
    }


def test_catalog_accepts_openai_wrapped_defs():
    tools = [
        _openai('desktop_screenshot', 'Take a screenshot of the screen.'),
        _openai('delete_sessions', 'Delete workbench sessions by id.'),
        _openai('install_mcp_server', 'Install an MCP server by name.'),
    ]
    cat = buildToolCatalog(tools)
    assert [e.name for e in cat] == ['desktop_screenshot', 'delete_sessions', 'install_mcp_server']
    assert all(e.tokens for e in cat), 'catalog entries must not be empty'


def test_tool_search_finds_screenshot_tools():
    tools = [
        _openai('desktop_screenshot', 'Take a screenshot of the current screen.'),
        _openai('browser_screenshot', 'Screenshot the browser tab.'),
        _openai('write_file', 'Write a file to disk.'),
        _openai('run_command', 'Execute a shell command.'),
    ]
    results = searchTools(buildToolCatalog(tools), 'screenshot', k=3)
    assert results and all(results), 'no empty names may come back'
    assert any('screenshot' in r for r in results)


def test_tool_search_never_returns_empty_names():
    tools = [_openai(f'tool_{i}', f'does thing number {i}') for i in range(8)]
    results = searchTools(buildToolCatalog(tools), 'thing number 3', k=5)
    assert all(r for r in results)


def test_catalog_accepts_raw_defs_still():
    tools = [{'name': 'read_file', 'description': 'Read a file.', 'parameters': {}}]
    cat = buildToolCatalog(tools)
    assert cat[0].name == 'read_file'
