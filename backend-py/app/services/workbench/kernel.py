"""T13 — REPL-first tool surface: kernel state, tool bridge, sequential cells.

Extends the ``code``-mode sandbox (``code_runner.py``) beyond its four
workspace-bound functions with:

- A **tool bridge** reaching the full managed tool surface. The child python
  is an isolated ``python -I`` subprocess, so it calls back into the running
  backend over a localhost endpoint using a short-lived one-shot token. The
  parent side (``bridge_call``) re-applies the same guard / approval gates as
  the typed loop, so code mode cannot bypass the permission axes.
- **Persistent kernel variables across turns.** Each user variable is
  snapshotted independently to ``<workspace>/.aug/kernel/<session>/`` and
  restored on the next run. Per-variable and total size caps apply; anything
  unpicklable or oversized is skipped and reported — never fatal.
- **Strictly sequential execution.** A per-session asyncio lock guarantees
  cells never interleave.
- **Large data stays on disk.** Oversized bridge results spill to a file and
  come back as a locator + preview instead of an inline blob.

The child-side restore/snapshot/bridge client code lives in ``code_runner``
templates; this module owns everything the parent process can reason about
(tokens, paths, caps, locks, venv discovery, and the gated dispatch).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets
import time

from app.json_narrowing import as_str

logger = logging.getLogger(__name__)

# Snapshot caps (plan §9.4 T13): per-variable ~16 MB, total ~256 MB.
PER_VARIABLE_CAP_BYTES: int = 16 * 1024 * 1024
TOTAL_CAP_BYTES: int = 256 * 1024 * 1024

# Bridge results larger than this spill to disk instead of returning inline.
BRIDGE_SPILL_CHARS: int = 64 * 1024

# One-shot bridge tokens expire if never consumed (a run that crashed before
# calling a tool must not leave a live credential around).
BRIDGE_TOKEN_TTL_S: float = 300.0

_KERNEL_SUBDIR = os.path.join('.aug', 'kernel')

# ---------------------------------------------------------------------------


# P3.2 (Part 18) — warm interpreter for code mode.
#
# Today every code-mode cell cold-spawns ``python -I``; interpreter boot is
# paid per cell. A WARM kernel keeps one isolated child alive per
# (workspace, session) and EXECUTES THE SAME PER-CELL RUNNER SOURCE that the
# cold path writes to disk (``code_runner.build_runner_source``: hardline
# guard, workspace-bound tool API, sandbox-mode flags, bridge, restore/
# snapshot pickle tails) — inside the warm process, in a fresh namespace.
#
# Security parity is by construction, not by re-implementation:
#   * the child is booted with ``python -I`` + the same credential-scrubbed
#     noninteractive env as any agent subprocess;
#   * EVERY cell runs the full runner source — the embedded hardline guard,
#     workspace binding, read-only refusal and env scrub are identical to
#     the cold path because it IS the same source;
#   * state between cells flows through the same pickle snapshot (with its
#     per-variable caps) — no new persistence semantics;
#   * the parent applies the same soft preflight the cold boot command
#     would get against the session's CURRENT policy, per cell.
# The one deliberate difference: workbench hooks that inspect the
# ``run_command`` command string see a fixed-shape boot command either way
# (the cell never rode in the command line on the cold path either — it
# lived in the script file), so no hook loses signal it ever had.

WARM_KERNEL_IDLE_S: float = 900.0  # idle reap window (daemon-refactored later)
_WARM_KERNELS: dict[str, 'WarmKernel'] = {}

# Boot loop for the warm child: serves one runner-source payload per line.
# SystemExit is CAPTURED (reported as the cell's exit code) and the worker
# keeps serving — the process is a service, not a one-shot script.
_WARM_BOOT = '''
import json as _json, sys as _sys
_sys.stdout.reconfigure(line_buffering=True)

def _august_serve_cells():
    while True:
        line = _sys.stdin.readline()
        if not line:
            return  # parent went away
        import io as _io, traceback as _tb
        _out, _err = _io.StringIO(), _io.StringIO()
        _code, _ok = 0, True
        _old_out, _old_err = _sys.stdout, _sys.stderr
        try:
            _sys.stdout, _sys.stderr = _out, _err
            _ns = {'__name__': '__main__', '__file__': '<warm-cell>'}
            exec(compile(_json.loads(line)['source'], '<warm-cell>', 'exec'), _ns)
        except SystemExit as _e:
            _code = _e.code if isinstance(_e.code, int) else (0 if _e.code is None else 1)
        except BaseException:
            _ok = False
            _err.write(_tb.format_exc())
        finally:
            _sys.stdout, _sys.stderr = _old_out, _old_err
        print(_json.dumps({'ok': _ok, 'stdout': _out.getvalue(),
                           'stderr': _err.getvalue(), 'exit_code': _code}))
        _sys.stdout.flush()

_august_serve_cells()
'''


class CellResult:
    """Outcome of one code-mode cell."""

    def __init__(self, ok: bool, stdout: str, stderr: str, exit_code: int) -> None:
        self.ok = ok
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code


class WarmKernel:
    """One persistent isolated interpreter serving a session's cells."""

    def __init__(self, workspace_path: str, session_id: str, interpreter: str = '') -> None:
        self.workspace_path = workspace_path or ''
        self.session_id = session_id
        self.interpreter = interpreter or ''
        self.proc: asyncio.subprocess.Process | None = None
        self.last_used: float = 0.0
        self._shutdown = False
        self._idle_handle: asyncio.TimerHandle | None = None

    async def _boot(self) -> None:
        """Spawn the persistent child (must run inside an event loop)."""
        import sys as _sys
        import time as _time

        from app.lib.async_subprocess import noninteractive_env

        exe = self.interpreter or _sys.executable
        self.proc = await asyncio.create_subprocess_exec(
            exe, '-I', '-c', _WARM_BOOT,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.workspace_path or None,
            env=noninteractive_env(),
        )
        self._shutdown = False
        self.last_used = _time.monotonic()
        self._arm_idle_timer()

    def _arm_idle_timer(self) -> None:
        """Self-reap: no cell within the idle window ends the process."""
        if self._idle_handle is not None:
            self._idle_handle.cancel()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return

        def _idle_exit() -> None:
            import time as _t

            if _t.monotonic() - self.last_used >= WARM_KERNEL_IDLE_S:
                self._shutdown = True
                if self.proc is not None:
                    try:
                        self.proc.kill()
                    except ProcessLookupError:
                        pass

        self._idle_handle = loop.call_later(WARM_KERNEL_IDLE_S, _idle_exit)

    @property
    def alive(self) -> bool:
        return not self._shutdown and (self.proc is None or self.proc.returncode is None)

    def kill(self) -> None:
        self._shutdown = True
        if self._idle_handle is not None:
            self._idle_handle.cancel()
        if self.proc is not None and self.proc.returncode is None:
            try:
                self.proc.kill()
            except ProcessLookupError:
                pass

    def shutdown(self) -> None:
        """Kill the child and drop the registry entry."""
        self.kill()
        _WARM_KERNELS.pop(_warm_key(self.workspace_path, self.session_id), None)

    def launch_command(self) -> str:
        """The fixed boot-command SHAPE (interpreter + ``-I``) — the same
        token shape the cold path's allowlist/preflight evaluate."""
        exe = self.interpreter or 'python'
        quoted = f'"{exe}"' if ' ' in exe else exe
        return f'{quoted} -I -c "<august-warm-kernel>"'

    async def run_cell_source(self, source: str, timeout: float = 60.0) -> CellResult:
        """Execute one full runner-source cell in the warm child."""
        import json as _json
        import time as _time

        if self.proc is None or self.proc.returncode is not None:
            await self._boot()
        assert self.proc is not None and self.proc.stdin is not None and self.proc.stdout is not None
        self.last_used = _time.monotonic()
        self._arm_idle_timer()
        line = _json.dumps({'source': source}) + '\n'
        try:
            self.proc.stdin.write(line.encode('utf-8'))
            await self.proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            await self._boot()
            assert self.proc is not None and self.proc.stdin is not None
            self.proc.stdin.write(line.encode('utf-8'))
            await self.proc.stdin.drain()
        try:
            raw = await asyncio.wait_for(self.proc.stdout.readline(), timeout=timeout)
        except asyncio.TimeoutError:
            # The child is still MID-CELL (the serve loop is single-threaded)
            # — keeping it alive would make the next cell read THIS cell's
            # eventual result envelope (permanent protocol off-by-one) and
            # everything after it block. Kill it; the next acquire boots a
            # fresh child (audit finding 2026-08-31).
            self.kill()
            self.proc = None
            return CellResult(False, '', f'cell timed out after {timeout}s', -1)
        if not raw:
            return CellResult(False, '', 'kernel exited unexpectedly', -1)
        try:
            data = _json.loads(raw.decode('utf-8', errors='replace'))
        except ValueError:
            return CellResult(False, raw.decode('utf-8', errors='replace'), 'bad kernel response', -1)
        return CellResult(
            ok=bool(data.get('ok')),
            stdout=str(data.get('stdout', '')),
            stderr=str(data.get('stderr', '')),
            exit_code=int(data.get('exit_code', 0) or 0),
        )


def _warm_key(workspace_path: str, session_id: str) -> str:
    return f'{(workspace_path or "").strip()}::{(session_id or "").strip()}'


def acquire_warm_kernel(workspace_path: str, session_id: str, interpreter: str = '') -> WarmKernel:
    """Get (or create) the warm kernel for a (workspace, session) pair.

    Registry-only and synchronous: the child boots lazily on the first cell.
    A kernel whose process died is replaced transparently on next use.
    """
    key = _warm_key(workspace_path, session_id)
    k = _WARM_KERNELS.get(key)
    if k is not None and k.alive:
        return k
    k = WarmKernel(workspace_path, session_id, interpreter)
    _WARM_KERNELS[key] = k
    return k


def shutdown_all_warm_kernels() -> None:
    """Test/teardown helper: reap everything."""
    for k in list(_WARM_KERNELS.values()):
        k.kill()
    _WARM_KERNELS.clear()


def preflight_warm_cell(sandbox_mode: str | None, workspace_path: str | None) -> str | None:
    """Parent-side gate parity: run the SAME soft preflight the cold boot
    command would get, against the session's CURRENT policy — per cell (the
    session's sandbox mode may change mid-conversation). Returns the denial
    reason or None when allowed."""
    from app.services.sandbox.backends.fallback import soft_preflight
    from app.services.sandbox.runner import policy_from_session

    policy = policy_from_session(
        sandbox_mode=sandbox_mode, workspace_path=workspace_path, allow_unsandboxed=False
    )
    if policy.is_full_access:
        return None
    # The real boot-command shape (interpreter + -I) — read-only mode blocks
    # interpreters wholesale, exactly as it would the cold spawn command.
    return soft_preflight('python -I -c "<august-warm-kernel>"', policy)


def reap_idle_warm_kernels() -> int:
    """Drop registry entries whose process already died (idle timer kill)."""
    dead = [key for key, k in _WARM_KERNELS.items() if not k.alive and k.proc is not None]
    for key in dead:
        _WARM_KERNELS.pop(key, None)
    return len(dead)


# ---------------------------------------------------------------------------
# Bridge token registry (in-memory; tokens are ephemeral per code run)
# ---------------------------------------------------------------------------

_bridge_tokens: dict[str, tuple[str, float]] = {}  # token -> (sessionId, issuedAt)


def issue_bridge_token(session_id: str) -> str:
    """Mint a short-lived token authorizing bridge calls for one code run."""
    token = secrets.token_urlsafe(24)
    _bridge_tokens[token] = (as_str(session_id, ''), time.monotonic())
    _gc_bridge_tokens()
    return token


def resolve_bridge_token(token: str) -> str | None:
    """Return the session id for a live token, or None (expired/unknown)."""
    entry = _bridge_tokens.get((token or '').strip())
    if entry is None:
        return None
    session_id, issued_at = entry
    if time.monotonic() - issued_at > BRIDGE_TOKEN_TTL_S:
        _bridge_tokens.pop(token, None)
        return None
    return session_id


def revoke_bridge_token(token: str) -> None:
    _bridge_tokens.pop((token or '').strip(), None)


def _gc_bridge_tokens() -> None:
    now = time.monotonic()
    expired = [t for t, (_, at) in _bridge_tokens.items() if now - at > BRIDGE_TOKEN_TTL_S]
    for t in expired:
        _bridge_tokens.pop(t, None)


def clear_bridge_tokens() -> None:
    """Test helper: drop all tokens."""
    _bridge_tokens.clear()


# ---------------------------------------------------------------------------
# Kernel variable persistence (parent-side view)
# ---------------------------------------------------------------------------


def _safe_session_id(session_id: str) -> str:
    return re.sub(r'[^A-Za-z0-9_.-]', '_', as_str(session_id or '').strip()) or 'session'


def kernel_dir(workspace_path: str, session_id: str) -> str:
    """Directory holding one session's persisted kernel variables.

    Workspace-scoped when a workspace exists; otherwise under the temp dir so
    a workspace-less session still gets persistence.
    """
    import tempfile

    base = (
        os.path.join(workspace_path, _KERNEL_SUBDIR)
        if (workspace_path or '').strip()
        else os.path.join(tempfile.gettempdir(), 'august_kernel')
    )
    path = os.path.join(base, _safe_session_id(session_id))
    os.makedirs(path, exist_ok=True)
    return path


def list_persisted_vars(kernel_directory: str) -> list[str]:
    """Names of variables currently persisted for a session (for the UI)."""
    names: list[str] = []
    try:
        for entry in sorted(os.listdir(kernel_directory)):
            if entry.startswith('var_') and entry.endswith('.pkl'):
                names.append(entry[len('var_'):-len('.pkl')])
    except OSError:
        return []
    return names


def read_snapshot_report(kernel_directory: str) -> dict[str, object]:
    """Read the child-written snapshot report (saved/skipped), tolerant of absence."""
    import json

    path = os.path.join(kernel_directory, '_report.json')
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {}


def clear_kernel_state(workspace_path: str, session_id: str) -> int:
    """Delete all persisted variables for a session. Returns count removed."""
    import shutil

    directory = kernel_dir(workspace_path, session_id)
    removed = 0
    try:
        for entry in os.listdir(directory):
            if entry.startswith('var_') and entry.endswith('.pkl'):
                try:
                    os.remove(os.path.join(directory, entry))
                    removed += 1
                except OSError:
                    pass
        report = os.path.join(directory, '_report.json')
        if os.path.exists(report):
            os.remove(report)
    except OSError:
        pass
    # Best-effort: drop the now-empty dir tree.
    try:
        if os.path.isdir(directory) and not os.listdir(directory):
            shutil.rmtree(directory, ignore_errors=True)
    except OSError:
        pass
    return removed


# ---------------------------------------------------------------------------
# Sequential execution (cells never interleave)
# ---------------------------------------------------------------------------

_kernel_locks: dict[str, asyncio.Lock] = {}


def session_kernel_lock(session_id: str) -> asyncio.Lock:
    """One lock per session; code cells in the same session run serially."""
    key = as_str(session_id, 'default')
    lock = _kernel_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _kernel_locks[key] = lock
    return lock


# ---------------------------------------------------------------------------
# Pre-seeded venv discovery / provisioning
# ---------------------------------------------------------------------------

# ~12 common packages the kernel venv pre-seeds (plan §9.4 T13).
DEFAULT_VENV_PACKAGES: tuple[str, ...] = (
    'requests',
    'httpx',
    'numpy',
    'pandas',
    'scipy',
    'matplotlib',
    'pillow',
    'pyyaml',
    'beautifulsoup4',
    'lxml',
    'python-dateutil',
    'pytest',
)


def venv_python(workspace_path: str) -> str | None:
    """Return the kernel venv's interpreter if provisioned, else None."""
    if not (workspace_path or '').strip():
        return None
    candidates = (
        os.path.join(workspace_path, _KERNEL_SUBDIR, 'venv', 'Scripts', 'python.exe'),
        os.path.join(workspace_path, _KERNEL_SUBDIR, 'venv', 'bin', 'python'),
    )
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return None


async def ensure_code_venv(
    workspace_path: str,
    packages: tuple[str, ...] | None = None,
    timeout: float = 600.0,
) -> dict[str, object]:
    """Provision ``<workspace>/.aug/kernel/venv`` and seed common packages.

    Best-effort and idempotent: an existing healthy venv is reused. Network
    failures during ``pip install`` do not fail the venv itself — the
    interpreter is still usable and the missing packages are reported.
    """
    from app.services.sandbox import policy_from_session, run_sandboxed

    if not (workspace_path or '').strip():
        return {'ok': False, 'error': 'no workspace configured'}
    pkgs = tuple(packages or DEFAULT_VENV_PACKAGES)
    existing = venv_python(workspace_path)
    venv_root = os.path.join(workspace_path, _KERNEL_SUBDIR, 'venv')
    policy = policy_from_session(
        sandbox_mode='workspace-write',
        workspace_path=workspace_path,
        allow_unsandboxed=True,  # provisioning needs real fs/network access
    )
    if existing is None:
        create = await run_sandboxed(
            f'python -m venv "{venv_root}"', policy, timeout=timeout
        )
        if not create.ok:
            return {
                'ok': False,
                'error': f'venv creation failed: {(create.stderr or create.stdout or "").strip()[:500]}',
            }
        existing = venv_python(workspace_path)
        if existing is None:
            return {'ok': False, 'error': 'venv created but interpreter not found'}
    # Upgrade pip quietly (non-fatal), then seed packages.
    pip_base = f'"{existing}" -m pip'
    await run_sandboxed(f'{pip_base} install --quiet --upgrade pip', policy, timeout=timeout)
    installed: list[str] = []
    failed: list[str] = []
    for pkg in pkgs:
        res = await run_sandboxed(f'{pip_base} install --quiet {pkg}', policy, timeout=timeout)
        (installed if res.ok else failed).append(pkg)
    return {
        'ok': True,
        'python': existing,
        'installed': installed,
        'failed': failed,
    }


# ---------------------------------------------------------------------------
# Gated bridge dispatch (parent side of the tool bridge)
# ---------------------------------------------------------------------------


async def bridge_call(session: object, tool_name: str, args: dict[str, object]) -> str:
    """Execute a managed tool on behalf of a code-mode cell.

    Applies the same guard / approval gates as the typed loop so code mode
    cannot sidestep the permission axes, then dispatches through the normal
    ``_executeTool`` path (hooks, context vars, failure feedback included).
    Oversized results spill to disk and return as a locator + preview.
    """
    from app.services.workbench import workbench as wb

    name = as_str(tool_name, '').strip()
    if not name:
        return 'Error: bridge call missing tool name'
    # Guard gate (plan/ask/edit modes, read-only sandbox, protected tools).
    blocked = wb._checkToolGuard(session, name, args)  # type: ignore[arg-type]
    if blocked:
        return f'[Blocked] {blocked}'
    # T5 approval axis (inert unless a policy is enabled).
    approval = wb._resolveCommandApproval(session, name, args)  # type: ignore[arg-type]
    if approval:
        return approval
    result = await wb._executeTool(name, args, session)  # type: ignore[arg-type]
    result_str = str(result)
    # Large data stays on disk: spill oversized results, return a locator.
    if len(result_str) > BRIDGE_SPILL_CHARS:
        spilled = wb._spillToolResult(session, f'code_bridge_{name}', result_str)  # type: ignore[arg-type]
        if spilled is not None:
            return spilled
    return result_str
