"""T13 — REPL-first tool surface: kernel state, tool bridge, sequential cells.

Covers the parent-side kernel module (tokens, persistence paths/caps, lock,
venv discovery, gated bridge dispatch) and the child-side code the runner
actually executes (restore/snapshot/skip-and-report/prune + the call_tool
bridge client), the latter by running real generated scripts in a subprocess.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading

import pytest
from app.services.workbench import kernel
from app.services.workbench.code_runner import build_runner_source, runner_command

# ---------------------------------------------------------------------------
# Bridge tokens
# ---------------------------------------------------------------------------


class TestBridgeTokens:
    def setup_method(self) -> None:
        kernel.clear_bridge_tokens()

    def testIssueResolve(self) -> None:
        token = kernel.issue_bridge_token('sess-1')
        assert token
        assert kernel.resolve_bridge_token(token) == 'sess-1'

    def testResolveUnknown(self) -> None:
        assert kernel.resolve_bridge_token('nope') is None
        assert kernel.resolve_bridge_token('') is None

    def testRevoke(self) -> None:
        token = kernel.issue_bridge_token('sess-1')
        kernel.revoke_bridge_token(token)
        assert kernel.resolve_bridge_token(token) is None

    def testExpiry(self, monkeypatch) -> None:
        import time as _time

        token = kernel.issue_bridge_token('sess-1')
        # Fast-forward past the TTL.
        base = _time.monotonic()
        monkeypatch.setattr(
            kernel.time, 'monotonic', lambda: base + kernel.BRIDGE_TOKEN_TTL_S + 1
        )
        assert kernel.resolve_bridge_token(token) is None

    def testTokensAreUnique(self) -> None:
        tokens = {kernel.issue_bridge_token('s') for _ in range(50)}
        assert len(tokens) == 50


# ---------------------------------------------------------------------------
# Kernel dir + persisted-var bookkeeping
# ---------------------------------------------------------------------------


class TestKernelDir:
    def testWorkspaceScoped(self, tmp_path) -> None:
        d = kernel.kernel_dir(str(tmp_path), 'sess/one')
        assert d.startswith(str(tmp_path))
        assert '.aug' in d and 'kernel' in d
        # Session id is sanitized for the filesystem.
        assert os.path.isdir(d)
        assert 'sess_one' in d

    def testTempFallback(self) -> None:
        import tempfile

        d = kernel.kernel_dir('', 'abc')
        assert d.startswith(tempfile.gettempdir())
        assert os.path.isdir(d)

    def testListAndClearPersisted(self, tmp_path) -> None:
        d = kernel.kernel_dir(str(tmp_path), 's1')
        for name in ('alpha', 'beta'):
            with open(os.path.join(d, f'var_{name}.pkl'), 'wb') as f:
                f.write(b'x')
        assert kernel.list_persisted_vars(d) == ['alpha', 'beta']
        removed = kernel.clear_kernel_state(str(tmp_path), 's1')
        assert removed == 2
        assert kernel.list_persisted_vars(
            kernel.kernel_dir(str(tmp_path), 's1')
        ) == []

    def testReadSnapshotReportMissing(self, tmp_path) -> None:
        d = kernel.kernel_dir(str(tmp_path), 's2')
        assert kernel.read_snapshot_report(d) == {}

    def testReadSnapshotReport(self, tmp_path) -> None:
        d = kernel.kernel_dir(str(tmp_path), 's3')
        with open(os.path.join(d, '_report.json'), 'w', encoding='utf-8') as f:
            json.dump({'saved': ['x'], 'skipped': [], 'totalBytes': 4}, f)
        report = kernel.read_snapshot_report(d)
        assert report['saved'] == ['x']


# ---------------------------------------------------------------------------
# Sequential execution lock
# ---------------------------------------------------------------------------


class TestKernelLock:
    def testSameSessionSameLock(self) -> None:
        assert kernel.session_kernel_lock('a') is kernel.session_kernel_lock('a')

    def testDifferentSessionsDifferentLocks(self) -> None:
        assert kernel.session_kernel_lock('a') is not kernel.session_kernel_lock('b')

    @pytest.mark.asyncio
    async def testSerializesCells(self) -> None:
        lock = kernel.session_kernel_lock('serial-test')
        order: list[str] = []

        async def cell(label: str, hold: float) -> None:
            async with lock:
                order.append(f'{label}-start')
                await asyncio.sleep(hold)
                order.append(f'{label}-end')

        # Launched "concurrently" but must not interleave.
        await asyncio.gather(cell('A', 0.05), cell('B', 0.01))
        assert order in (
            ['A-start', 'A-end', 'B-start', 'B-end'],
            ['B-start', 'B-end', 'A-start', 'A-end'],
        )


# ---------------------------------------------------------------------------
# Venv discovery + runner command
# ---------------------------------------------------------------------------


class TestVenvAndRunnerCommand:
    def testVenvPythonAbsent(self, tmp_path) -> None:
        assert kernel.venv_python(str(tmp_path)) is None
        assert kernel.venv_python('') is None

    def testVenvPythonWindowsLayout(self, tmp_path) -> None:
        exe = tmp_path / '.aug' / 'kernel' / 'venv' / 'Scripts' / 'python.exe'
        exe.parent.mkdir(parents=True)
        exe.write_text('')
        assert kernel.venv_python(str(tmp_path)) == str(exe)

    def testVenvPythonPosixLayout(self, tmp_path) -> None:
        exe = tmp_path / '.aug' / 'kernel' / 'venv' / 'bin' / 'python'
        exe.parent.mkdir(parents=True)
        exe.write_text('')
        assert kernel.venv_python(str(tmp_path)) == str(exe)

    def testRunnerCommandDefault(self) -> None:
        assert runner_command('/x/y.py') == 'python -I -u "/x/y.py"'

    def testRunnerCommandVenv(self) -> None:
        cmd = runner_command('/x/y.py', '/ws/.aug/kernel/venv/bin/python')
        assert cmd == '/ws/.aug/kernel/venv/bin/python -I -u "/x/y.py"'

    def testRunnerCommandQuotesSpaceyInterpreter(self) -> None:
        cmd = runner_command('/x/y.py', 'C:/Program Files/venv/python.exe')
        assert cmd.startswith('"C:/Program Files/venv/python.exe" -I -u')

    def testDefaultVenvPackages(self) -> None:
        # Plan §9.4 T13: ~12 common packages.
        assert 10 <= len(kernel.DEFAULT_VENV_PACKAGES) <= 14
        assert 'numpy' in kernel.DEFAULT_VENV_PACKAGES
        assert 'requests' in kernel.DEFAULT_VENV_PACKAGES


# ---------------------------------------------------------------------------
# build_runner_source: compiles + wires T13 sections
# ---------------------------------------------------------------------------


class TestBuildRunnerSource:
    def testCompilesWithBridgeAndKernel(self) -> None:
        src = build_runner_source(
            'x = 1\nresult = x',
            '/ws',
            sandbox_mode='workspace-write',
            bridge_url='http://127.0.0.1:9/api/workbench/code-bridge',
            bridge_token='tok',
            kernel_dir='/ws/.aug/kernel/s',
        )
        compile(src, '<runner>', 'exec')
        assert 'def call_tool' in src
        assert 'http://127.0.0.1:9/api/workbench/code-bridge' in src
        assert "'tok'" in src
        assert 'var_*.pkl' in src  # restore + snapshot glob

    def testCompilesWithoutBridge(self) -> None:
        src = build_runner_source('y = 2', '')
        compile(src, '<runner>', 'exec')
        assert 'def call_tool' in src  # always present; inert without URL/token

    def testReadOnlyRendered(self) -> None:
        src = build_runner_source('z = 3', '/ws', sandbox_mode='read-only')
        assert '_SANDBOX_READ_ONLY = True' in src


# ---------------------------------------------------------------------------
# Child-side persistence (run real generated scripts in a subprocess)
# ---------------------------------------------------------------------------


def _run_script(ws: str, block: str, kdir: str) -> subprocess.CompletedProcess:
    src = build_runner_source(block, ws, kernel_dir=kdir)
    path = os.path.join(ws, f'run_{os.urandom(3).hex()}.py')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    return subprocess.run(
        [sys.executable, '-I', path], capture_output=True, text=True, cwd=ws, timeout=60
    )


class TestChildPersistence:
    def testVariablesPersistAcrossRuns(self, tmp_path) -> None:
        ws = str(tmp_path)
        kdir = kernel.kernel_dir(ws, 'p1')
        r1 = _run_script(ws, 'counter = 41\ncounter += 1\nresult = counter', kdir)
        assert r1.returncode == 0, r1.stderr
        assert '[result] 42' in r1.stdout
        r2 = _run_script(ws, 'counter += 10\nresult = counter', kdir)
        assert r2.returncode == 0, r2.stderr
        assert '[result] 52' in r2.stdout

    def testSkipAndReportUnpicklableAndOversized(self, tmp_path) -> None:
        ws = str(tmp_path)
        kdir = kernel.kernel_dir(ws, 'p2')
        block = (
            'import threading\n'
            'lock = threading.Lock()\n'
            'big = b"x" * (17 * 1024 * 1024)\n'
            'good = [1, 2, 3]\n'
            'result = "done"'
        )
        r = _run_script(ws, block, kdir)
        assert r.returncode == 0, r.stderr
        report = kernel.read_snapshot_report(kdir)
        assert 'good' in report['saved']
        assert any(s.startswith('lock: unpicklable') for s in report['skipped'])
        assert any(s.startswith('big: exceeds per-variable cap') for s in report['skipped'])
        # Run never crashed — snapshot failures are non-fatal.
        assert '[result] done' in r.stdout

    def testDeletedVariablePruned(self, tmp_path) -> None:
        ws = str(tmp_path)
        kdir = kernel.kernel_dir(ws, 'p3')
        _run_script(ws, 'a = 1\nb = 2\nresult = a', kdir)
        assert 'var_a.pkl' in os.listdir(kdir)
        _run_script(ws, 'del a\nresult = b', kdir)
        assert 'var_a.pkl' not in os.listdir(kdir)
        assert 'var_b.pkl' in os.listdir(kdir)

    def testCallToolRaisesWithoutBridge(self, tmp_path) -> None:
        ws = str(tmp_path)
        kdir = kernel.kernel_dir(ws, 'p4')
        block = (
            'try:\n'
            '    call_tool("anything")\n'
            '    result = "no-raise"\n'
            'except RuntimeError as e:\n'
            '    result = "raised: " + str(e)'
        )
        r = _run_script(ws, block, kdir)
        assert r.returncode == 0, r.stderr
        assert 'raised: tool bridge not available' in r.stdout


# ---------------------------------------------------------------------------
# call_tool bridge client against a real local HTTP server
# ---------------------------------------------------------------------------


class TestCallToolBridgeClient:
    def testRoundTripAgainstLocalServer(self, tmp_path) -> None:
        from http.server import BaseHTTPRequestHandler, HTTPServer

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(length) or b'{}')
                response = {
                    'result': f"echo:{body.get('tool')}:{json.dumps(body.get('args'), sort_keys=True)}:tok={body.get('token')}"
                }
                payload = json.dumps(response).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):  # silence
                pass

        server = HTTPServer(('127.0.0.1', 0), Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            ws = str(tmp_path)
            kdir = kernel.kernel_dir(ws, 'bridge1')
            src = build_runner_source(
                'result = call_tool("my_tool", a=1, b="two")',
                ws,
                kernel_dir=kdir,
                bridge_url=f'http://127.0.0.1:{port}/bridge',
                bridge_token='secret-token',
            )
            path = os.path.join(ws, 'bridge_run.py')
            with open(path, 'w', encoding='utf-8') as f:
                f.write(src)
            r = subprocess.run(
                [sys.executable, '-I', path], capture_output=True, text=True, cwd=ws, timeout=60
            )
            assert r.returncode == 0, r.stderr
            assert 'echo:my_tool:{"a": 1, "b": "two"}:tok=secret-token' in r.stdout
        finally:
            server.shutdown()
            server.server_close()


# ---------------------------------------------------------------------------
# Parent-side gated bridge dispatch
# ---------------------------------------------------------------------------


@pytest.fixture()
def bridge_env(tmp_path, monkeypatch):
    """Isolated data dir + session + a registered echo tool for bridge_call."""
    from app.services.workbench import workbench as wb
    from app.services.workbench.sessions import WorkbenchSession

    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    session = WorkbenchSession(id='t13-sess', model='stub')
    session.workspacePath = str(tmp_path)

    async def echo_handler(**args):
        return 'echo:' + json.dumps(args, sort_keys=True, default=str)

    from app.services import tool_registry

    tool_registry.register(
        't13_echo', 'T13 test echo tool', echo_handler, {'type': 'object', 'properties': {}}
    )
    yield {'wb': wb, 'session': session}
    # Clean up the registered tool so it doesn't leak into other tests.
    tool_registry.unregister('t13_echo')


class TestBridgeCall:
    @pytest.mark.asyncio
    async def testDispatchesTool(self, bridge_env) -> None:
        result = await kernel.bridge_call(bridge_env['session'], 't13_echo', {'x': 1})
        assert result == 'echo:{"x": 1}'

    @pytest.mark.asyncio
    async def testMissingToolName(self, bridge_env) -> None:
        result = await kernel.bridge_call(bridge_env['session'], '  ', {})
        assert 'missing tool name' in result

    @pytest.mark.asyncio
    async def testUnknownToolReturnsError(self, bridge_env) -> None:
        result = await kernel.bridge_call(bridge_env['session'], 't13_does_not_exist', {})
        assert 'not found' in result

    @pytest.mark.asyncio
    async def testGuardBlocksReadOnlyMutation(self, bridge_env) -> None:
        session = bridge_env['session']
        session.sandboxMode = 'read-only'
        result = await kernel.bridge_call(session, 'write_file', {'path': 'x.txt', 'content': 'y'})
        assert result.startswith('[Blocked]')
        session.sandboxMode = 'workspace-write'

    @pytest.mark.asyncio
    async def testLargeResultSpillsToDisk(self, bridge_env) -> None:
        from app.services import tool_registry

        big = 'Z' * (kernel.BRIDGE_SPILL_CHARS + 1024)

        async def big_handler(**args):
            return big

        tool_registry.register('t13_big', 'T13 big result', big_handler, {'type': 'object'})
        try:
            result = await kernel.bridge_call(bridge_env['session'], 't13_big', {})
            # Spilled: comes back as a head/tail preview + locator, not the blob.
            assert len(result) < len(big)
            assert '.aug/spill' in result
            assert 'omitted' in result
        finally:
            tool_registry.unregister('t13_big')


# ---------------------------------------------------------------------------
# code-bridge HTTP endpoint
# ---------------------------------------------------------------------------


class TestCodeBridgeEndpoint:
    @pytest.mark.asyncio
    async def testInvalidTokenRejected(self, bridge_env) -> None:
        from app.routers.workbench import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        from httpx import ASGITransport, AsyncClient

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url='http://test') as client:
            resp = await client.post(
                '/api/workbench/code-bridge',
                json={'token': 'bogus', 'tool': 't13_echo', 'args': {}},
            )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def testValidTokenDispatches(self, bridge_env) -> None:
        from app.routers.workbench import router
        from app.services.workbench import sessions as sessions_mod
        from fastapi import FastAPI

        # The endpoint resolves the session from the live session store.
        sessions_mod._sessions['t13-sess'] = bridge_env['session']
        token = kernel.issue_bridge_token('t13-sess')
        app = FastAPI()
        app.include_router(router)
        from httpx import ASGITransport, AsyncClient

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url='http://test') as client:
            resp = await client.post(
                '/api/workbench/code-bridge',
                json={'token': token, 'tool': 't13_echo', 'args': {'k': 'v'}},
            )
        assert resp.status_code == 200
        assert resp.json()['result'] == 'echo:{"k": "v"}'
        sessions_mod._sessions.pop('t13-sess', None)
