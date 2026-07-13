"""Characterization test for ``mcp_client._saveConfig`` atomic write.

The MCP config persistence path (``data/mcp-servers.json``) is
written by ``_saveConfig``. As of B1a this must use the same
atomic-write helper (``app.jsonUtils.write_json_atomic``) as the
other JSON stores, so a process crash mid-write cannot leave the
on-disk file truncated or corrupt.

These tests pin the contract of ``_saveConfig``: given a config
dict, it produces a ``mcp-servers.json`` file with the exact JSON
content, and does not leave a stray ``.tmp`` file behind (which
would indicate a non-atomic write that crashed mid-replace).
"""

from __future__ import annotations

import json
from pathlib import Path

from app.lib import paths as paths_module
from app.services.tools import mcp_client


def testSaveConfigWritesExpectedJson(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(paths_module, 'dataDir', lambda: tmp_path)
    monkeypatch.setattr(mcp_client, 'dataPath', paths_module.dataPath)
    monkeypatch.setattr(mcp_client, '_mcpConfigPath', lambda: tmp_path / 'mcp-servers.json')

    cfg = {'mcpServers': {'echo': {'command': 'echo', 'args': ['hi'], 'env': {}}}}
    mcp_client._saveConfig(cfg)

    target = tmp_path / 'mcp-servers.json'
    assert target.exists()
    assert json.loads(target.read_text('utf-8')) == cfg


def testSaveConfigCreatesParentDir(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(paths_module, 'dataDir', lambda: tmp_path)
    monkeypatch.setattr(mcp_client, 'dataPath', paths_module.dataPath)
    nested = tmp_path / 'a' / 'b' / 'c' / 'mcp-servers.json'
    monkeypatch.setattr(mcp_client, '_mcpConfigPath', lambda: nested)

    mcp_client._saveConfig({'x': 1})

    assert nested.exists()
    assert json.loads(nested.read_text('utf-8')) == {'x': 1}


def testSaveConfigDoesNotLeaveTmpFile(tmp_path: Path, monkeypatch):
    """Atomic writes use ``os.replace``; no ``.tmp`` artifact should remain."""
    monkeypatch.setattr(paths_module, 'dataDir', lambda: tmp_path)
    monkeypatch.setattr(mcp_client, 'dataPath', paths_module.dataPath)
    target = tmp_path / 'mcp-servers.json'
    monkeypatch.setattr(mcp_client, '_mcpConfigPath', lambda: target)

    mcp_client._saveConfig({'servers': []})

    stray = [p for p in tmp_path.iterdir() if p.name.endswith('.tmp')]
    assert not stray, f'Stray temp file(s) left behind: {stray}'


def testSaveConfigOverwritesExisting(tmp_path: Path, monkeypatch):
    """Atomic write should replace an existing target file cleanly."""
    monkeypatch.setattr(paths_module, 'dataDir', lambda: tmp_path)
    monkeypatch.setattr(mcp_client, 'dataPath', paths_module.dataPath)
    target = tmp_path / 'mcp-servers.json'
    monkeypatch.setattr(mcp_client, '_mcpConfigPath', lambda: target)
    target.write_text('{"old": true}', encoding='utf-8')

    mcp_client._saveConfig({'new': True})

    assert json.loads(target.read_text('utf-8')) == {'new': True}