"""Container execution backend + backend-selection memoization tests."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.sandbox import backends as sandbox_backends  # noqa: E402
from app.services.sandbox.backends import container as container_backend  # noqa: E402
from app.services.sandbox.runner import policy_from_session  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_selection():
    sandbox_backends.invalidate_backend_cache()
    yield
    sandbox_backends.invalidate_backend_cache()


def _with_docker(monkeypatch: pytest.MonkeyPatch, available: bool = True) -> None:
    monkeypatch.setattr(container_backend.shutil, 'which', lambda name: '/usr/bin/docker' if name == 'docker' else None)
    monkeypatch.setattr(container_backend, 'is_available', lambda: available)


def testContainerDisabledByDefault(monkeypatch: pytest.MonkeyPatch) -> None:
    """No AUGUST_CONTAINER_SANDBOX → the tier never activates, even with Docker up."""
    monkeypatch.delenv('AUGUST_CONTAINER_SANDBOX', raising=False)
    _with_docker(monkeypatch, available=True)
    assert container_backend.container_enabled() is False
    assert sandbox_backends.select_backend_name() != 'container'


def testContainerEnabledWithoutDockerFallsBack(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AUGUST_CONTAINER_SANDBOX', '1')
    _with_docker(monkeypatch, available=False)
    assert sandbox_backends.select_backend_name() != 'container'


def testContainerSelectedWhenEnabledAndAvailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AUGUST_CONTAINER_SANDBOX', '1')
    _with_docker(monkeypatch, available=True)
    assert sandbox_backends.select_backend_name() == 'container'


def testArgvShapeWorkspaceWrite(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv('AUGUST_SANDBOX_IMAGE', raising=False)
    monkeypatch.delenv('AUGUST_SANDBOX_MEMORY', raising=False)
    monkeypatch.setattr(container_backend.shutil, 'which', lambda name: 'docker' if name == 'docker' else None)
    policy = policy_from_session('workspace-write', str(tmp_path), sandbox_network=False)
    argv = container_backend.build_docker_argv('pytest -q', policy, 'august-sbx-test')
    assert argv is not None
    mount = str(tmp_path.resolve()).replace('\\', '/')
    assert f'{mount}:/workspace' in argv
    assert '--network' in argv and 'none' in argv
    assert '--workdir' in argv and '/workspace' in argv
    assert argv[argv.index('sh') + 1] == '-lc'
    assert argv[-1] == 'pytest -q'
    assert 'python:3.12-slim' in argv


def testArgvReadOnlyMount(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(container_backend.shutil, 'which', lambda name: 'docker' if name == 'docker' else None)
    policy = policy_from_session('read-only', str(tmp_path), sandbox_network=False)
    argv = container_backend.build_docker_argv('cat file', policy, 'august-sbx-test')
    assert argv is not None
    mount = str(tmp_path.resolve()).replace('\\', '/')
    assert f'{mount}:/workspace:ro' in argv


def testArgvNetworkAllowedOmitsNone(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(container_backend.shutil, 'which', lambda name: 'docker' if name == 'docker' else None)
    policy = policy_from_session('workspace-write', str(tmp_path), sandbox_network=True)
    argv = container_backend.build_docker_argv('curl example.com', policy, 'august-sbx-test')
    assert argv is not None
    assert '--network' not in argv


def testArgvNoneWithoutWorkspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """Home-anchored sessions (no workspace) can't mount — caller falls back."""
    monkeypatch.setattr(container_backend.shutil, 'which', lambda name: 'docker' if name == 'docker' else None)
    policy = policy_from_session('workspace-write', '', sandbox_network=False)
    assert container_backend.build_docker_argv('ls', policy, 'august-sbx-test') is None
