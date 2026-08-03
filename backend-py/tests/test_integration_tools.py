"""Integration tool handlers — registration, classification, secrets, MCP."""

from __future__ import annotations

import json

import pytest
from app.services import integration_tools
from app.services.memory.capabilities_prompt import classify_tool, unclassified_tools
from app.services.tool_registry import get, listRaw, register, unregister


class _FakeGithubResponse:
    """Minimal httpx-like response for GET /user."""

    status_code = 200
    text = '{"login":"testuser","name":"Test User"}'
    headers = {'x-oauth-scopes': 'repo, read:user'}

    def json(self) -> dict:
        return {'login': 'testuser', 'name': 'Test User'}


class _FakeHttpxClient:
    """Mock httpx.AsyncClient that returns a successful /user response."""

    def __init__(self, *a: object, **k: object) -> None:
        pass

    async def __aenter__(self) -> _FakeHttpxClient:
        return self

    async def __aexit__(self, *a: object) -> None:
        pass

    async def get(self, url: str, **k: object) -> _FakeGithubResponse:
        return _FakeGithubResponse()


@pytest.fixture
def mock_github_validation(monkeypatch: pytest.MonkeyPatch) -> None:
    """Mock httpx.AsyncClient so connect_github validation succeeds."""
    monkeypatch.setattr(
        'app.services.service_connections.httpx.AsyncClient',
        _FakeHttpxClient,
    )


@pytest.fixture(scope='module', autouse=True)
def _register_under_test():
    integration_tools.register()


@pytest.fixture(autouse=True)
def _cleanup_connections():
    """Disconnect all service connections after each test so the in-memory
    config cache doesn't leak connected state into other test files."""
    yield
    from app.services import service_connections as sc

    for name in ('github', 'slack', 'google'):
        try:
            sc.disconnect(name)
        except Exception:
            pass


class TestRegistration:
    def test_tools_registered(self):
        names = {t['name'] for t in listRaw()}
        for tool in (
            'list_integrations',
            'connect_github',
            'connect_slack',
            'connect_google',
            'install_mcp_server',
            'list_mcp_servers',
            'disconnect_integration',
        ):
            assert tool in names, f'expected {tool} registered'

    def test_classified_not_other(self):
        names = {t['name'] for t in listRaw()}
        bad = unclassified_tools(names)
        assert 'list_integrations' not in bad
        assert 'connect_github' not in bad
        assert 'disconnect_integration' not in bad
        # Bucket check
        assert classify_tool('list_integrations') == 'tool_read'
        assert classify_tool('list_mcp_servers') == 'tool_read'
        assert classify_tool('connect_github') == 'tool_write'
        assert classify_tool('connect_slack') == 'tool_write'
        assert classify_tool('connect_google') == 'tool_write'
        assert classify_tool('install_mcp_server') == 'tool_write'
        assert classify_tool('disconnect_integration') == 'tool_destructive'


@pytest.mark.asyncio
async def test_connect_github_never_echoes_secret(isolatedData, mock_github_validation):
    raw = await integration_tools.connectGithub('ghp_1234567890abcdef')
    parsed = json.loads(raw)
    assert parsed['status'] == 'success'
    setup = parsed['integrationSetup']
    # The full secret must never appear in the model-visible payload.
    assert 'ghp_1234567890abcdef' not in json.dumps(parsed)
    assert setup['provider'] == 'github'
    assert setup['needsToken'] is False
    # Masked value present but not the raw secret.
    assert setup['maskedToken'] and '1234567890' not in setup['maskedToken']


@pytest.mark.asyncio
async def test_connect_github_empty_token_needs_inline(isolatedData):
    result = await integration_tools.connectGithub('')
    parsed = json.loads(result)
    assert parsed['status'] == 'success'
    assert parsed['integrationSetup']['needsToken'] is True


@pytest.mark.asyncio
async def test_connect_github_invalid_token_returns_error(isolatedData, monkeypatch):
    """An invalid token must NOT be stored — validation fails first."""

    class _FailResponse:
        status_code = 401
        text = 'Unauthorized'
        headers: dict = {}

        def json(self) -> dict:
            return {}

    class _FailClient:
        def __init__(self, *a: object, **k: object) -> None:
            pass

        async def __aenter__(self) -> _FailClient:
            return self

        async def __aexit__(self, *a: object) -> None:
            pass

        async def get(self, url: str, **k: object) -> _FailResponse:
            return _FailResponse()

    monkeypatch.setattr('app.services.service_connections.httpx.AsyncClient', _FailClient)
    raw = await integration_tools.connectGithub('ghp_invalid_token')
    parsed = json.loads(raw)
    assert parsed['status'] == 'error'
    assert 'error' in parsed  # validation error message
    assert parsed['integrationSetup']['connected'] is False


@pytest.mark.asyncio
async def test_disconnect_github_removes(isolatedData, mock_github_validation):
    await integration_tools.connectGithub('ghp_1234567890abcdef')
    result = await integration_tools.disconnectIntegration('github')
    parsed = json.loads(result)
    assert parsed['status'] == 'success'
    assert parsed['deleted'] is True
    assert parsed['kind'] == 'account'


@pytest.mark.asyncio
async def test_disconnect_unknown_errors(isolatedData):
    result = await integration_tools.disconnectIntegration('nosuchservice')
    parsed = json.loads(result)
    assert parsed['status'] == 'error'


@pytest.mark.asyncio
async def test_install_mcp_server_roundtrip(isolatedData):
    # Register-only (start=False) to avoid spawning a real subprocess.
    result = await integration_tools.installMcpServer(
        name='filesystem',
        command='npx',
        args=['-y', '@modelcontextprotocol/server-filesystem', '/tmp/fake'],
        start=False,
    )
    parsed = json.loads(result)
    assert parsed['status'] == 'success'
    setup = parsed.get('integrationSetup') or {}
    assert setup.get('kind') == 'mcp'
    assert setup.get('serverId')
    assert setup.get('started') is False

    # listMcpServers reflects it back
    listed = json.loads(await integration_tools.listMcpServers())
    assert listed['status'] == 'success'
    ids = [s.get('id') for s in listed['servers']]
    assert setup['serverId'] in ids

    # disconnect_integration can remove it by id
    removed = json.loads(
        await integration_tools.disconnectIntegration(str(setup['serverId']))
    )
    assert removed['status'] == 'success'
    assert removed['kind'] == 'mcp'


@pytest.mark.asyncio
async def test_list_integrations_includes_connections(isolatedData):
    result = await integration_tools.listIntegrations()
    parsed = json.loads(result)
    assert parsed['status'] == 'success'
    assert 'connections' in parsed
    assert 'instructions' in parsed
    assert parsed['instructions']['github']['helpUrl'].startswith('https')


@pytest.mark.asyncio
async def test_connect_github_empty_preserves_existing(isolatedData, mock_github_validation):
    """The model's "show the inline field" call (empty token) must not wipe a
    working connection — that path used to pop the stored token + env var."""
    from app.services import service_connections as sc

    await integration_tools.connectGithub('ghp_1234567890abcdef')
    assert sc.list_connections()['connections']['github']['connected'] is True

    parsed = json.loads(await integration_tools.connectGithub(''))
    assert parsed['integrationSetup']['needsToken'] is True

    still = sc.list_connections()['connections']['github']
    assert still['connected'] is True
    assert 'ghp_1234567890abcdef' not in json.dumps(still)


def test_integration_tools_gated_in_ask_and_plan(isolatedData):
    """Mutating/destructive integration tools must require approval in ask and
    plan modes; read-only ones stay allowed everywhere."""
    from app.services.workbench.sessions import create_workbench_session
    from app.services.workbench.workbench import _checkToolGuard

    mutating = (
        'connect_github',
        'connect_slack',
        'connect_google',
        'install_mcp_server',
        'disconnect_integration',
    )
    for mode in ('ask', 'plan'):
        s = create_workbench_session(provider='test', guardMode=mode)
        s.planApproved = False
        for tool in mutating:
            assert _checkToolGuard(s, tool, {}), f'{tool} must be gated in {mode} mode'
        assert _checkToolGuard(s, 'list_integrations', {}) is None
        assert _checkToolGuard(s, 'list_mcp_servers', {}) is None


def test_integration_tools_allowed_in_full(isolatedData):
    from app.services.workbench.sessions import create_workbench_session
    from app.services.workbench.workbench import _checkToolGuard

    s = create_workbench_session(provider='test', guardMode='full')
    for tool in ('connect_github', 'disconnect_integration', 'install_mcp_server'):
        assert _checkToolGuard(s, tool, {}) is None


def test_install_mcp_server_gated_in_edit(isolatedData):
    """edit mode auto-proceeds file writes but gates shell/subprocess tools;
    install_mcp_server spawns the model-supplied command, so it must gate."""
    from app.services.workbench.sessions import create_workbench_session
    from app.services.workbench.workbench import _checkToolGuard

    s = create_workbench_session(provider='test', guardMode='edit')
    assert _checkToolGuard(s, 'install_mcp_server', {}) is not None