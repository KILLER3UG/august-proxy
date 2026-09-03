"""Part 18 P3.2 — warm interpreter for ``code`` mode.

Plan acceptance: "second ``code`` call in a session shows no interpreter boot
in its duration breakdown." Today every cell cold-spawns ``python -I``; the
warm kernel keeps one isolated child alive per (workspace, session) and
executes THE SAME per-cell runner source (hardline guard, workspace-bound
tool API, sandbox flags, restore/snapshot pickle tails) inside it — so the
security posture is identical BY CONSTRUCTION, and only the interpreter
boot is eliminated.

Verified behaviors:
  * registry: same session reuses the same process; dead kernels replaced
  * cells: state flows via the SAME pickle snapshot the cold path uses
    (per-variable caps intact); stdout/stderr/exit captured; sys.exit is a
    cell exit code, not a kernel death
  * parity: every cell embeds the hardline guard + workspace binding +
    read-only refusal (same builder as the cold path); env scrubbed
  * gates: the parent runs the same soft preflight per cell
  * acceptance: the 2nd cell skips the interpreter boot (wall-clock)
  * lifecycle: idle kernels reap themselves; workbench code mode routes
    through the warm kernel with the cold spawn as fallback
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import time

import pytest
from app.services.workbench import kernel
from app.services.workbench.code_runner import build_runner_source


def _run(coro):
    """Run one coroutine on a SHARED loop — a kernel's asyncio pipes bind to
    the loop that booted it, so every cell must ride that same loop."""
    global _LOOP
    if _LOOP is None or _LOOP.is_closed():
        _LOOP = asyncio.new_event_loop()
    return _LOOP.run_until_complete(coro)


_LOOP: asyncio.AbstractEventLoop | None = None


@pytest.fixture(autouse=True)
def _reap_kernels():
    yield
    kernel.shutdown_all_warm_kernels()


def _cell(block: str, workspace: str, kernel_dir: str, sandbox: str = 'workspace-write') -> str:
    """Build the same runner source the cold path would write to disk."""
    return build_runner_source(block, workspace, sandbox_mode=sandbox, kernel_dir=kernel_dir)


def _kdir(ws, session) -> str:
    return kernel.kernel_dir(str(ws), session)


# ---------------------------------------------------------------------------
# Registry / lifecycle
# ---------------------------------------------------------------------------


class TestWarmKernelLifecycle:
    def test_acquire_returns_alive_kernel(self, tmp_path):
        k = kernel.acquire_warm_kernel(str(tmp_path), 'warm-1')
        assert k is not None
        assert k.alive
        r = _run(k.run_cell_source(_cell('pass', str(tmp_path), _kdir(tmp_path, 'warm-1'))))
        assert r.ok, r.stderr
        assert k.proc is not None and k.proc.returncode is None
        k.shutdown()

    def test_same_session_reuses_process(self, tmp_path):
        """The whole point (P3.2): the second cell must not boot."""
        k1 = kernel.acquire_warm_kernel(str(tmp_path), 'warm-2')
        _run(k1.run_cell_source(_cell('pass', str(tmp_path), _kdir(tmp_path, 'warm-2'))))
        k2 = kernel.acquire_warm_kernel(str(tmp_path), 'warm-2')
        assert k1 is k2
        assert k2.proc is k1.proc
        k1.shutdown()

    def test_different_sessions_get_different_kernels(self, tmp_path):
        k1 = kernel.acquire_warm_kernel(str(tmp_path), 'warm-a')
        k2 = kernel.acquire_warm_kernel(str(tmp_path), 'warm-b')
        assert k1 is not k2
        k1.shutdown()
        k2.shutdown()

    def test_shutdown_kills_and_clears_registry(self, tmp_path):
        k = kernel.acquire_warm_kernel(str(tmp_path), 'warm-3')
        _run(k.run_cell_source(_cell('pass', str(tmp_path), _kdir(tmp_path, 'warm-3'))))
        k.shutdown()
        assert not k.alive
        again = kernel.acquire_warm_kernel(str(tmp_path), 'warm-3')
        assert again is not k
        again.shutdown()

    def test_dead_kernel_is_replaced_on_acquire(self, tmp_path):
        k = kernel.acquire_warm_kernel(str(tmp_path), 'warm-4')
        _run(k.run_cell_source(_cell('pass', str(tmp_path), _kdir(tmp_path, 'warm-4'))))
        k.kill()
        _run(asyncio.sleep(0.05))  # let the process die + transport notice
        assert not k.alive
        k2 = kernel.acquire_warm_kernel(str(tmp_path), 'warm-4')
        assert k2 is not k
        assert k2.alive
        k2.shutdown()


# ---------------------------------------------------------------------------
# Cell execution semantics (same runner source as the cold path)
# ---------------------------------------------------------------------------


class TestWarmCellExecution:
    def test_state_flows_through_pickle_snapshot(self, tmp_path):
        """State flows via the same per-variable pickle snapshot the cold
        path uses — with the caps intact (an unpicklable var is skipped,
        not fatal)."""
        ws = str(tmp_path)
        kd = _kdir(tmp_path, 'warm-10')
        k = kernel.acquire_warm_kernel(ws, 'warm-10')
        try:
            r1 = _run(k.run_cell_source(_cell('counter = 41\ncounter += 1\nresult = counter', ws, kd)))
            assert r1.ok, r1.stderr
            assert '[result] 42' in r1.stdout
            assert 'counter' in kernel.list_persisted_vars(kd)
            r2 = _run(k.run_cell_source(_cell('counter += 10\nresult = counter', ws, kd)))
            assert r2.ok, r2.stderr
            assert '[result] 52' in r2.stdout
        finally:
            k.shutdown()

    def test_stderr_and_exit_status_captured_sys_exit_survives(self, tmp_path):
        ws = str(tmp_path)
        kd = _kdir(tmp_path, 'warm-11')
        k = kernel.acquire_warm_kernel(ws, 'warm-11')
        try:
            r = _run(k.run_cell_source(_cell('import sys\nprint("boom", file=sys.stderr)\nsys.exit(3)', ws, kd)))
            assert 'boom' in r.stderr
            assert r.exit_code == 3
            # sys.exit is a CELL exit code, not a kernel death — the worker
            # keeps serving.
            assert k.alive
            r2 = _run(k.run_cell_source(_cell('print("back")', ws, kd)))
            assert 'back' in r2.stdout
        finally:
            k.shutdown()

    def test_exception_in_cell_captured_not_fatal(self, tmp_path):
        ws = str(tmp_path)
        kd = _kdir(tmp_path, 'warm-14')
        k = kernel.acquire_warm_kernel(ws, 'warm-14')
        try:
            r = _run(k.run_cell_source(_cell('raise ValueError("bad cell")', ws, kd)))
            assert not r.ok
            assert 'ValueError' in r.stderr and 'bad cell' in r.stderr
            assert k.alive
        finally:
            k.shutdown()

    def test_cwd_bound_to_workspace(self, tmp_path):
        ws = str(tmp_path)
        kd = _kdir(tmp_path, 'warm-12')
        k = kernel.acquire_warm_kernel(ws, 'warm-12')
        try:
            r = _run(k.run_cell_source(_cell('import os\nprint(os.getcwd())', ws, kd)))
            assert os.path.realpath(ws) in os.path.realpath(r.stdout.strip())
        finally:
            k.shutdown()

    def test_env_scrubbed_of_credentials(self, tmp_path, monkeypatch):
        """Env parity: the runner preamble scrubs AUGUST_*/credential vars
        inside the cell, exactly like the cold path."""
        monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', 'x')
        monkeypatch.setenv('MY_API_KEY', 'secret')
        ws = str(tmp_path)
        kd = _kdir(tmp_path, 'warm-13')
        k = kernel.acquire_warm_kernel(ws, 'warm-13')
        try:
            r = _run(
                k.run_cell_source(
                    _cell(
                        'import os\nresult = sorted(k for k in os.environ if "API_KEY" in k or k.startswith("AUGUST_"))',
                        ws,
                        kd,
                    )
                )
            )
            assert '[]' in r.stdout
        finally:
            k.shutdown()

    def test_hardline_guard_active_inside_warm_cell(self, tmp_path):
        """Security parity: the embedded hardline guard blocks a credential
        read through the child's run_command, same as the cold path
        (providers.json is the canonical credential-read target)."""
        ws = str(tmp_path)
        kd = _kdir(tmp_path, 'warm-15')
        k = kernel.acquire_warm_kernel(ws, 'warm-15')
        try:
            r = _run(
                k.run_cell_source(_cell("result = run_command('cat ~/providers.json')", ws, kd))
            )
            blob = (r.stdout or '') + (r.stderr or '')
            assert 'hardline' in blob or 'blocked' in blob.lower(), blob
        finally:
            k.shutdown()

    def test_read_only_sandbox_refused(self, tmp_path):
        """A read-only session's flags are rendered per cell — the warm
        kernel honors the CURRENT mode, not the boot-time one."""
        ws = str(tmp_path)
        kd = _kdir(tmp_path, 'warm-16')
        k = kernel.acquire_warm_kernel(ws, 'warm-16')
        try:
            r2 = _run(
                k.run_cell_source(
                    _cell("result = write_file('x.txt', 'data')", ws, kd, sandbox='read-only')
                )
            )
            blob = (r2.stdout or '') + (r2.stderr or '')
            assert 'read-only' in blob, blob
        finally:
            k.shutdown()


# ---------------------------------------------------------------------------
# Boot-cost acceptance (the plan's measurable)
# ---------------------------------------------------------------------------


class TestWarmBootCost:
    def test_second_cell_has_no_interpreter_boot(self, tmp_path):
        """PLAN ACCEPTANCE: the 2nd cell skips interpreter boot. Measured:
        a trivial warm cell (process alive, shipping source only) is
        clearly cheaper than cold-spawning ``python -I`` for the same cell.
        """
        ws = str(tmp_path)
        kd = _kdir(tmp_path, 'warm-20')
        k = kernel.acquire_warm_kernel(ws, 'warm-20')
        try:
            _run(k.run_cell_source(_cell('x = 1', ws, kd)))

            t0 = time.perf_counter()
            r = _run(k.run_cell_source(_cell('y = 2\nprint(y)', ws, kd)))
            warm_ms = (time.perf_counter() - t0) * 1000.0
            assert '2' in r.stdout

            # Cold spawn of the same runner source (the old path).
            script = tmp_path / 'cold_cell.py'
            script.write_text(_cell('y2 = 2\nprint(y2)', ws, kd), encoding='utf-8')
            t1 = time.perf_counter()
            subprocess.run(
                [sys.executable, '-I', str(script)],
                capture_output=True,
                text=True,
                cwd=ws,
                timeout=60,
            )
            cold_ms = (time.perf_counter() - t1) * 1000.0

            # Warm must beat cold; generous slack for CI noise (Windows
            # process spawn alone is ~10x the cell itself).
            assert warm_ms < cold_ms, f'warm {warm_ms:.1f}ms not < cold {cold_ms:.1f}ms'
        finally:
            k.shutdown()


# ---------------------------------------------------------------------------
# Idle shutdown
# ---------------------------------------------------------------------------


class TestIdleShutdown:
    def test_idle_kernel_is_reaped(self, tmp_path, monkeypatch):
        """A kernel idle beyond the window shuts itself down — no orphaned
        interpreters accumulate."""
        monkeypatch.setattr(kernel, 'WARM_KERNEL_IDLE_S', 0.2)
        ws = str(tmp_path)
        kd = _kdir(tmp_path, 'warm-30')
        k = kernel.acquire_warm_kernel(ws, 'warm-30')
        _run(k.run_cell_source(_cell('pass', ws, kd)))
        assert k.alive
        t0 = time.monotonic()
        while k.alive and (time.monotonic() - t0) < 5:
            _run(asyncio.sleep(0.05))
        assert not k.alive, 'idle kernel was not reaped within 5s'
        # The registry entry dies with it (reap sweep or next acquire).
        k2 = kernel.acquire_warm_kernel(ws, 'warm-30')
        assert k2 is not k
        k2.shutdown()


# ---------------------------------------------------------------------------
# Parent-side gates
# ---------------------------------------------------------------------------


class TestParentGates:
    def test_preflight_blocks_read_only_interpreter(self, tmp_path):
        """Read-only sandbox blocks interpreters wholesale on the cold path
        (soft_preflight) — the warm path must refuse the same way."""
        reason = kernel.preflight_warm_cell('read-only', str(tmp_path))
        assert reason is not None
        assert 'read-only' in reason

    def test_preflight_allows_workspace_write(self, tmp_path):
        assert kernel.preflight_warm_cell('workspace-write', str(tmp_path)) is None

    def test_preflight_allows_full_access(self, tmp_path):
        assert kernel.preflight_warm_cell('danger-full-access', str(tmp_path)) is None

    def test_launch_command_shape_preserves_tokens(self, tmp_path):
        """SECURITY PARITY: the boot command is interpreter + ``-I`` — the
        same token shape run_command's allowlist/preflight evaluate."""
        k = kernel.acquire_warm_kernel(str(tmp_path), 'warm-40')
        try:
            cmd = k.launch_command()
            first = cmd.strip().split()[0].strip('"').lower()
            assert first in ('python', 'py') or first.endswith('python.exe'), f'not an interpreter: {cmd}'
            assert '-I' in cmd
        finally:
            k.shutdown()


# ---------------------------------------------------------------------------
# Integration: _runFencedCodeBlock prefers the warm kernel
# ---------------------------------------------------------------------------


class TestFencedBlockWarmRouting:
    def test_code_mode_uses_warm_kernel(self):
        """The workbench code-mode path routes cells through the warm kernel
        (cold spawn stays as the fallback)."""
        import inspect

        from app.services.workbench import workbench as wb

        src = inspect.getsource(wb._runFencedCodeBlock)
        assert 'warm' in src.lower(), (
            '_runFencedCodeBlock never consults the warm kernel — code mode '
            'still cold-spawns python per cell (P3.2 unimplemented)'
        )

    def test_warm_kernel_surfaces_in_workbench_module(self):
        from app.services.workbench import workbench as wb

        assert hasattr(wb, '_acquireWarmKernelFor') or 'warm' in inspect_src(wb)

    def test_warm_path_holds_the_session_kernel_lock(self):
        """T13's sequential guarantee applies to the WARM path too: the
        per-session lock must be acquired BEFORE the warm kernel (it used to
        wrap only the cold spawn — two concurrent cells could interleave
        stdin writes and corrupt the line protocol)."""
        import inspect

        from app.services.workbench import workbench as wb

        src = inspect.getsource(wb._runFencedCodeBlock)
        lock_pos = src.find('session_kernel_lock')
        warm_pos = src.find('acquire_warm_kernel')
        assert lock_pos != -1, '_runFencedCodeBlock never takes the session kernel lock'
        assert warm_pos != -1, '_runFencedCodeBlock never consults the warm kernel'
        assert lock_pos < warm_pos, (
            'the session kernel lock is taken only on the cold path — the '
            'warm branch runs unlocked and cells can interleave'
        )


# ---------------------------------------------------------------------------
# Timeout recovery: a hung cell must not desync the line protocol
# ---------------------------------------------------------------------------


class TestTimeoutRecovery:
    def test_timed_out_cell_is_killed_and_next_cell_is_fresh(self, tmp_path):
        """A cell that exceeds the timeout leaves the child MID-EXEC (the
        serve loop is single-threaded) — keeping the process alive would
        make the next cell read the PREVIOUS cell's result envelope
        (permanent off-by-one) and everything after it block. The kernel
        must kill the child on timeout so the next acquire boots fresh."""
        ws = str(tmp_path)
        k = kernel.acquire_warm_kernel(ws, 'warm-timeout')
        try:
            r1 = _run(k.run_cell_source('import time; time.sleep(4)', timeout=0.3))
            assert not r1.ok and 'timed out' in r1.stderr
            # The next cell must hit a FRESH child and return ITS OWN result.
            r2 = _run(k.run_cell_source('print("fresh")', timeout=10))
            assert r2.ok, f'cell after a timeout failed: {r2.stderr!r}'
            assert 'fresh' in r2.stdout, (
                f'protocol desync — cell read a stale envelope: {r2.stdout!r}'
            )
        finally:
            k.shutdown()


def inspect_src(module) -> str:
    import inspect

    return inspect.getsource(module)
