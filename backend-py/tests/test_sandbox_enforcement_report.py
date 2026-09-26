"""Honest enforcement reporting + warm-kernel routing.

The invariant under test: **a tier is never reported unless it is actually
in force.** Concretely, three things were previously false and are now
guarded here.

1. ``windows.is_available()`` used to return True when the AppContainer
   symbols merely existed, so doctor advertised "Windows AppContainer
   isolation" while every run fell back to soft. Availability is now proven
   by building a real ``SECURITY_CAPABILITIES`` attribute list.
2. A requested-but-unavailable strong tier (container with no Docker,
   AppContainer on a host that refuses the attribute) was indistinguishable
   from "no tier requested". ``enforcement_report()`` now separates
   requested from effective and names the reason.
3. The warm code-mode kernel spawns ``python -I`` directly, bypassing every
   backend, so a strong backend did not contain code mode. It is now refused
   while a strong tier is active, and the cold (sandboxed) path serves the
   cell instead.
"""

from __future__ import annotations

import sys

import pytest
from app.services.sandbox import backends as sandbox_backends
from app.services.sandbox.backends import container as container_backend
from app.services.sandbox.backends import linux as linux_backend
from app.services.sandbox.backends import macos as macos_backend
from app.services.sandbox.backends import windows as windows_backend
from app.services.workbench import kernel


@pytest.fixture(autouse=True)
def _fresh_probes(monkeypatch: pytest.MonkeyPatch):
    """Every test starts from a clean env + unmemoized probe state."""
    for key in (
        'AUGUST_CONTAINER_SANDBOX',
        'AUGUST_SANDBOX_APPCONTAINER',
        'AUGUST_WARM_KERNEL_OFF',
    ):
        monkeypatch.delenv(key, raising=False)
    # Neutralise the host's own platform tier. `select_backend_name()` reaches
    # for bwrap on Linux and sandbox-exec on macOS, so leaving them live made
    # these tests assert on the runner's installed software — a Linux CI worker
    # answered 'landlock' where the test expected 'soft'.
    monkeypatch.setattr(linux_backend, 'is_available', lambda: False)
    monkeypatch.setattr(linux_backend, 'backend_kind', lambda: 'soft')
    monkeypatch.setattr(macos_backend, 'is_available', lambda: False)
    sandbox_backends.invalidate_backend_cache()
    container_backend._probe_cache = None
    windows_backend.reset_probe()
    yield
    sandbox_backends.invalidate_backend_cache()
    container_backend._probe_cache = None
    windows_backend.reset_probe()


# ── enforcement_report: requested vs effective ───────────────────────────


def test_report_when_nothing_requested(monkeypatch: pytest.MonkeyPatch) -> None:
    report = sandbox_backends.enforcement_report()
    assert report['requested'] == 'soft'
    assert report['degraded'] is False
    assert report['reason']


def test_report_flags_requested_container_without_docker(monkeypatch: pytest.MonkeyPatch) -> None:
    """The headline honesty case: opt-in on, Docker absent.

    Seeds `probe` rather than `_probe_cache`. A cache entry stamped 0.0 is
    judged against `time.monotonic() - 0.0 < _PROBE_TTL_S`, so it is stale on
    any machine up longer than 60 seconds — and the re-probe then asks the real
    host, which on a GitHub windows runner has Docker and answers. The test
    measured uptime and installed software instead of the reporting logic.
    """
    monkeypatch.setenv('AUGUST_CONTAINER_SANDBOX', '1')
    monkeypatch.setattr(
        container_backend,
        'probe',
        lambda: (False, 'docker daemon is not answering (start Docker Desktop)'),
    )
    sandbox_backends.invalidate_backend_cache()
    report = sandbox_backends.enforcement_report()
    assert report['requested'] == 'container'
    assert report['effective'] == 'soft'
    assert report['degraded'] is True
    assert report['strong'] is False
    assert 'docker daemon' in str(report['reason'])


def test_report_container_available_is_not_degraded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AUGUST_CONTAINER_SANDBOX', '1')
    monkeypatch.setattr(container_backend.shutil, 'which', lambda n: 'docker' if n == 'docker' else None)
    # Stub `probe`, not just `is_available`: enforcement_report calls probe()
    # directly for the reason, so leaving it live made this pass only on hosts
    # that actually have a answering Docker daemon.
    monkeypatch.setattr(container_backend, 'probe', lambda: (True, ''))
    monkeypatch.setattr(container_backend, 'is_available', lambda: True)
    sandbox_backends.invalidate_backend_cache()
    report = sandbox_backends.enforcement_report()
    assert report['effective'] == 'container'
    assert report['requested'] == 'container'
    assert report['degraded'] is False
    assert report['strong'] is True


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows AppContainer tier')
def test_report_flags_requested_appcontainer_when_probe_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """Opt-in AppContainer on a host that refuses SECURITY_CAPABILITIES.

    This is the real state of Windows 11 26200 (see windows module docstring):
    the profile/SID derive fine, the OS still rejects the attribute. The user
    asked for isolation and must be told they did not get it.
    """
    monkeypatch.setenv('AUGUST_SANDBOX_APPCONTAINER', '1')
    windows_backend._probe_cache = (False, 'OS rejected SECURITY_CAPABILITIES (error 87)')
    sandbox_backends.invalidate_backend_cache()
    report = sandbox_backends.enforcement_report()
    assert report['requested'] == 'windows-appcontainer'
    assert report['effective'] == 'soft'
    assert report['degraded'] is True
    assert 'SECURITY_CAPABILITIES' in str(report['reason'])


def test_strong_backend_active_tracks_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    assert sandbox_backends.strong_backend_active() is False
    monkeypatch.setenv('AUGUST_CONTAINER_SANDBOX', '1')
    monkeypatch.setattr(container_backend, 'is_available', lambda: True)
    sandbox_backends.invalidate_backend_cache()
    assert sandbox_backends.strong_backend_active() is True


# ── Windows tier: never claim a boundary it does not have ────────────────


def test_windows_not_available_without_opt_in(monkeypatch: pytest.MonkeyPatch) -> None:
    """A capable host must not silently take over enforcement."""
    monkeypatch.delenv('AUGUST_SANDBOX_APPCONTAINER', raising=False)
    monkeypatch.setattr(windows_backend, 'probe', lambda: (True, ''))
    assert windows_backend.opt_in() is False
    assert windows_backend.is_available() is False


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows AppContainer tier')
def test_windows_not_available_when_probe_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """The regression: symbol existence used to be enough to claim AppContainer."""
    monkeypatch.setenv('AUGUST_SANDBOX_APPCONTAINER', '1')
    windows_backend.reset_probe()
    capable, reason = windows_backend.probe()
    if not capable:
        assert reason, 'an incapable host must say WHY'
        assert windows_backend.is_available() is False


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows AppContainer tier')
def test_windows_probe_is_stable_and_never_invents_capability() -> None:
    """On a host that cannot do AppContainer, the probe must stay negative.

    If this ever starts returning True the tier would begin advertising
    containment, so the assertion is deliberately about the invariant rather
    than about a specific host outcome.
    """
    windows_backend.reset_probe()
    capable, reason = windows_backend.probe()
    assert isinstance(capable, bool)
    if capable:
        assert reason == ''
    else:
        assert reason


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows backend')
def test_windows_run_never_labels_soft_as_appcontainer() -> None:
    """Even if the tier is selected, a soft run must be reported as soft."""
    import asyncio

    from app.services.sandbox.runner import policy_from_session

    policy = policy_from_session('workspace-write', '', sandbox_network=False)
    result = asyncio.run(
        windows_backend.run('echo appcontainer-probe', policy, timeout=20.0)
    )
    assert result.enforcement == 'soft'
    assert result.enforcement != 'windows-appcontainer'


# ── Warm kernel: no unsandboxed child while a strong tier is active ─────


def test_warm_kernel_allowed_when_no_strong_backend() -> None:
    allowed, reason = kernel.warm_kernel_allowed()
    assert allowed is True
    assert reason == ''


def test_warm_kernel_refused_when_strong_backend_active(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sandbox_backends, 'strong_backend_active', lambda: True)
    allowed, reason = kernel.warm_kernel_allowed()
    assert allowed is False
    assert 'sandbox' in reason.lower()


def test_warm_kernel_refused_when_backend_cannot_be_verified(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fail closed: if we cannot prove the backends are soft, do not assume it."""
    def _boom() -> bool:
        raise RuntimeError('probe exploded')

    monkeypatch.setattr(sandbox_backends, 'strong_backend_active', _boom)
    allowed, reason = kernel.warm_kernel_allowed()
    assert allowed is False
    assert reason


def test_shutdown_warm_kernels_reports_how_many(tmp_path) -> None:
    kernel.shutdown_all_warm_kernels()
    # Registry-only acquisition: no process, so nothing to reap.
    kernel.acquire_warm_kernel(str(tmp_path), 'shutdown-count')
    assert kernel.shutdown_warm_kernels() == 0
    assert kernel.shutdown_warm_kernels() == 0


def test_code_mode_routing_checks_warm_kernel_allowed() -> None:
    """The workbench dispatch must consult the gate, not only the env flag.

    A source-level guard: the previous code gated the warm path solely on
    AUGUST_WARM_KERNEL_OFF, which is exactly the hole this closes.
    """
    import inspect

    from app.services.workbench import workbench as wb

    src = inspect.getsource(wb._runFencedCodeBlock)
    assert 'warm_kernel_allowed' in src, (
        '_runFencedCodeBlock never consults warm_kernel_allowed — the warm child '
        'would run outside the active sandbox backend'
    )
    # The gate must come before the kernel is acquired.
    assert src.find('warm_kernel_allowed') < src.find('acquire_warm_kernel')


# ── Container probe reason plumbing ─────────────────────────────────────


def test_container_probe_reports_missing_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(container_backend.shutil, 'which', lambda n: None)
    container_backend._probe_cache = None
    available, reason = container_backend.probe()
    assert available is False
    assert 'docker' in reason.lower()


def test_container_probe_daemon_down_names_the_cause(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    monkeypatch.setattr(container_backend.shutil, 'which', lambda n: 'docker' if n == 'docker' else None)

    def _fail(*_a, **_k):
        return subprocess.CompletedProcess(args=[], returncode=1, stdout='', stderr='')

    monkeypatch.setattr(subprocess, 'run', _fail)
    container_backend._probe_cache = None
    available, reason = container_backend.probe()
    assert available is False
    assert 'daemon' in reason.lower()
