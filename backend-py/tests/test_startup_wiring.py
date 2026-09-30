"""The app must rehydrate the MCP registry AT STARTUP, not just support doing so.

`rehydrate_from_config()` was proven correct in isolation. Nothing proved the
lifespan CALLS it — and that is the shape of defect roadmap item #9 describes:
the load path runs once at launch and asserts nothing, so a call removed from
`main.py` is invisible to a test that only exercises the function. The function
would keep passing while every configured MCP server silently vanished on every
restart, which is exactly the bug the function was written to fix.

So this drives the real startup path. Booting the lifespan is the only way to
make removing the call a failing test rather than a silent regression.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def mcpConfig(tmp_path, monkeypatch):
    """Point the MCP config at a temp file and start from an empty registry."""
    from app.services.tools import mcp_client

    cfg = tmp_path / 'mcp-servers.json'
    monkeypatch.setattr(mcp_client, '_mcpConfigPath', lambda: cfg)
    monkeypatch.setattr(mcp_client, '_servers', {})
    monkeypatch.setattr(mcp_client, '_toolsCache', {})
    return cfg


def _write_config(path, name: str = 'notes', serverId: str = 'mcp_boot') -> None:
    """Persist a server through the REAL save door, not hand-written JSON.

    The first version of this test wrote `{"servers": [ ... ]}` and the server
    did not come back — the file format is `{"servers": {<id>: {...}}}`, a dict
    keyed by id. Hand-writing the shape duplicated the format and got it wrong,
    which is exactly the drift this whole class of test exists to prevent.
    Registering through `registerServer(persist=True)` is correct AND
    self-maintaining: change the writer, this follows.
    """
    from app.services.tools import mcp_client

    mcp_client.registerServer(
        name=name,
        command='node',
        args=['server.js'],
        env={'TOKEN': 'secret'},
        transport='stdio',
        server_id=serverId,
        persist=True,
    )
    mcp_client.set_server_meta(serverId, catalogId='cat-boot')
    mcp_client._saveConfig()
    assert path.exists(), 'the save door did not write the config file'

def _boot():
    from app.main import app
    from fastapi.testclient import TestClient

    return TestClient(app)


class TestStartupRehydratesTheRegistry:
    def test_a_configured_server_survives_a_restart(self, mcpConfig, monkeypatch):
        """Write the config the way the save door does, then boot the app.

        Pre-fix this was impossible: the file was written on every save and
        read by nothing, so a restart lost every configured integration and the
        user re-entered each one.
        """
        from app.services.tools import mcp_client

        _write_config(mcpConfig)
        # The restart. Everything below depends on this: the file is on disk
        # and memory is empty, which is the only state a fresh process is in.
        # (Checking the precondition BEFORE the reset failed the test the first
        # time, because registering the server is what put it in memory.)
        monkeypatch.setattr(mcp_client, '_servers', {})
        assert not mcp_client.listRegisteredServers(), 'precondition: registry is empty'

        with _boot():
            rows = {str(s.get('id')): s for s in mcp_client.listRegisteredServers()}

        assert 'mcp_boot' in rows, (
            'the app booted and the configured MCP server did NOT come back — the '
            'lifespan no longer calls rehydrate_from_config()'
        )
        row = rows['mcp_boot']
        # Not just present: the fields that make it usable must survive.
        assert str(row.get('name')) == 'notes'
        assert list(row.get('args') or []) == ['server.js']
        assert (row.get('env') or {}).get('TOKEN') == 'secret'
        assert bool(row.get('enabled')) is True
        assert str(row.get('catalogId') or '') == 'cat-boot'

    def test_rehydration_precedes_the_tool_refresh(self):
        """Order matters and is invisible in the output.

        The refresh is a fire-and-forget task, so if it ran first it would
        enumerate an empty registry and the server's tools would be missing for
        the whole process lifetime — with no error anywhere.
        """
        from pathlib import Path

        src = Path(__file__).resolve().parents[1] / 'app' / 'main.py'
        text = src.read_text(encoding='utf-8')
        hydrateAt = text.index('rehydrate_from_config()')
        refreshAt = text.index('refreshMcpTools()')
        assert hydrateAt < refreshAt, (
            'the tool refresh now runs before the registry is restored, so it '
            'enumerates nothing and the server contributes no tools'
        )

    def test_a_missing_config_file_is_not_an_error(self, mcpConfig):
        """A first run has no config; startup must not warn or fail."""
        from app.services.tools import mcp_client

        assert not mcpConfig.exists()
        with _boot():
            assert mcp_client.listRegisteredServers() == []
