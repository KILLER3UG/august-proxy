"""MCP registration must refuse what it claims to refuse, and no more.

Two gaps, both found by audit and neither tested before.

**The stdio denylist listed shells rather than the property that makes them
dangerous.** `sh -c "<payload>"` was refused while `python -c "<payload>"`
was accepted — the same arbitrary code execution under a different name. Now
the interpreters that take inline code are covered too. None of them is how a
real MCP stdio server is launched (they take a script path, or a package
name via npx/uvx), so nothing legitimate is lost.

**The URL transport had no private-address check at all.** A server row
pointing at `http://127.0.0.1:<port>/…` — August's own backend — or at
`169.254.169.254` was fetched happily. It now reuses the same guard
`web_fetch` and the browser use, at connect as well as at registration.
"""

from __future__ import annotations

import pytest
from app.services.tools.mcp_client import validateStdioLaunch


class TestInlineCodeInterpretersAreRefused:
    @pytest.mark.parametrize(
        ('command', 'args'),
        [
            ('python', ['-c', 'import os; os.system("calc")']),
            ('python3', ['-c', 'payload']),
            ('python.exe', ['-c', 'payload']),
            ('node', ['-e', 'require("child_process")']),
            ('perl', ['-e', 'system("id")']),
            ('ruby', ['-e', 'system("id")']),
            ('php', ['-r', 'system("id");']),
            ('deno', ['eval', 'payload']),
        ],
    )
    def test_refused(self, command: str, args: list[str]):
        assert validateStdioLaunch(command, args) is not None

    def test_the_refusal_names_the_reason(self):
        reason = validateStdioLaunch('python', ['-c', 'payload']) or ''
        assert 'inline code' in reason
        # It must not read as "python is banned" — that would send the user
        # looking for the wrong problem.
        assert 'script' in reason


class TestLegitimateLaunchesStillWork:
    @pytest.mark.parametrize(
        ('command', 'args'),
        [
            ('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']),
            ('uvx', ['mcp-server-git', '--repository', '/tmp/repo']),
            ('python', ['/opt/mcp/server.py']),
            ('python', ['-m', 'my_mcp_server']),
            ('node', ['/opt/mcp/server.js']),
            ('C:\\Program Files\\nodejs\\node.exe', ['C:\\mcp\\server.js']),
        ],
    )
    def test_allowed(self, command: str, args: list[str]):
        assert validateStdioLaunch(command, args) is None

    def test_a_flag_after_the_script_is_not_inline_code(self):
        """`python server.py --eval` is not `python --eval <code>`.

        Scanning stops at the first non-flag, so a script path (or `-m
        module`) ends the search. Reading the whole argv instead would
        refuse servers whose filename or module arguments happen to look
        like a flag.
        """
        assert validateStdioLaunch('python', ['server.py', '--eval', 'on']) is None
        assert validateStdioLaunch('python', ['-m', 'pkg', '-c', 'x']) is None

    def test_an_exe_suffix_does_not_hide_the_interpreter(self):
        assert validateStdioLaunch('python3.exe', ['-c', 'payload']) is not None


class TestExistingRulesStillHold:
    @pytest.mark.parametrize('shell', ['sh', 'bash', 'powershell', 'cmd', 'zsh', 'pwsh'])
    def test_shells_are_still_refused(self, shell: str):
        assert validateStdioLaunch(shell, ['-c', 'payload']) is not None

    def test_catastrophic_patterns_are_still_refused(self):
        assert validateStdioLaunch('some-tool', ['rm', '-rf', '/']) is not None

    def test_a_url_row_is_not_scanned(self):
        assert validateStdioLaunch('https://example.com/mcp', []) is None

    def test_empty_command_is_refused(self):
        assert validateStdioLaunch('  ', []) is not None


class TestUrlTransportRefusesPrivateAddresses:
    @pytest.fixture
    async def client(self):
        from app.main import app
        from httpx import ASGITransport, AsyncClient

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url='http://test') as ac:
            yield ac

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        'url',
        [
            'http://127.0.0.1:19387/api/providers',
            'http://localhost:8000/sse',
            'http://169.254.169.254/latest/meta-data/',
            'http://10.0.0.5/mcp',
            'http://192.168.1.1/mcp',
            'http://[::1]/mcp',
        ],
    )
    async def test_refused_at_connect(self, url: str):
        from app.services.tools.mcp_client import _open_sse_stream

        with pytest.raises(ValueError) as exc:
            await _open_sse_stream('srv', url)
        assert 'private' in str(exc.value).lower()

    @pytest.mark.asyncio
    async def test_the_check_does_not_leak_a_client_or_stream(self, client):
        """A refusal must not leave a half-initialised stream registered."""
        from app.services.tools import mcp_client

        mcp_client._sse_streams.clear()
        from app.services.tools.mcp_client import _open_sse_stream

        with pytest.raises(ValueError):
            await _open_sse_stream('srv-private', 'http://127.0.0.1:9/sse')
        assert 'srv-private' not in mcp_client._sse_streams
