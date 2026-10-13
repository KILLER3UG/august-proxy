"""The kernel venv's write half — provisioning, discovery, and the refusals.

Discovery (``venv_python``) shipped first with nothing in backend-py/app that
ever created a venv, so the folder was unreachable and a package needing
Python >= 3.13 (manimgx, whose wheel is cp313 abi3 — the bundled desktop
interpreter is 3.12.9) had nowhere to go. These pin the action that closes
that: find an interpreter, create the venv, skip or install the seed set —
and refuse, with receipts, every wrong shape.

The venv-creation test is REAL (``sys.executable -m venv`` in a tmp dir, no
network — the backend's own interpreter is >= 3.13); the pip path is stubbed
nowhere because ``packages=[]`` skips it by design.
"""

from __future__ import annotations

import subprocess
import sys

import pytest
from app.services.workbench import kernel


def _ws(tmp_path):
    ws = tmp_path / 'ws'
    ws.mkdir()
    return ws


async def test_provision_creates_a_discoverable_venv(tmp_path):
    ws = _ws(tmp_path)
    out = await kernel.provision_kernel_venv(
        str(ws), interpreter=sys.executable, packages=[],
    )
    assert out['ok'] is True, out
    # Discovery — the half that predates this action — now finds what the
    # action made.
    found = kernel.venv_python(str(ws))
    assert found is not None
    assert found == out['python']
    assert out['version'] == f'{sys.version_info[0]}.{sys.version_info[1]}'
    # …and the interpreter the venv produced actually runs.
    probe = subprocess.run([found, '-c', 'print(1)'], capture_output=True, text=True)
    assert probe.returncode == 0 and probe.stdout.strip() == '1'


async def test_provision_refuses_a_second_venv(tmp_path):
    ws = _ws(tmp_path)
    first = await kernel.provision_kernel_venv(str(ws), interpreter=sys.executable, packages=[])
    assert first['ok'] is True
    second = await kernel.provision_kernel_venv(str(ws), interpreter=sys.executable, packages=[])
    assert second['ok'] is False
    assert 'already provisioned' in second['error']
    assert second['venv'] == first['venv']


async def test_provision_refuses_an_interpreter_below_313(tmp_path, monkeypatch):
    ws = _ws(tmp_path)
    monkeypatch.setattr(kernel, '_interpreter_version', lambda _exe: (3, 12))
    out = await kernel.provision_kernel_venv(str(ws), interpreter='python')
    assert out['ok'] is False
    assert '3.13' in out['error']


async def test_provision_receipt_when_no_interpreter_qualifies(tmp_path, monkeypatch):
    ws = _ws(tmp_path)
    monkeypatch.setattr('shutil.which', lambda _name: None)
    out = await kernel.provision_kernel_venv(str(ws))
    assert out['ok'] is False
    assert '>= 3.13' in out['error']


async def test_provision_needs_a_live_workspace(tmp_path):
    out = await kernel.provision_kernel_venv(str(tmp_path / 'nope'), interpreter=sys.executable)
    assert out['ok'] is False
    assert 'workspace' in out['error']


def test_find_interpreter_picks_the_first_qualifying_name(monkeypatch):
    monkeypatch.setattr(
        'shutil.which',
        lambda name: f'/opt/{name}' if name in ('python3.13', 'python') else None,
    )
    monkeypatch.setattr(
        kernel, '_interpreter_version',
        lambda exe: (3, 13) if 'python3.13' in exe else (3, 12),
    )
    assert kernel.find_interpreter() == '/opt/python3.13'


def test_find_interpreter_empty_when_nothing_qualifies(monkeypatch):
    monkeypatch.setattr('shutil.which', lambda _name: None)
    assert kernel.find_interpreter() == ''


# ── the route: the only door that writes a venv ─────────────────────────────


async def test_provision_route_returns_the_receipt(tmp_path, monkeypatch):
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    ws = tmp_path / 'ws'
    ws.mkdir()

    async def _fake_provision(_workspace, interpreter='', packages=None):
        return {'ok': True, 'venv': str(ws), 'version': '3.14'}

    monkeypatch.setattr(kernel, 'provision_kernel_venv', _fake_provision)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        resp = await ac.post(
            '/api/workbench/kernel/provision', json={'workspace': str(ws)}
        )
    assert resp.status_code == 200
    assert resp.json()['ok'] is True


async def test_provision_route_needs_a_live_workspace(tmp_path):
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        resp = await ac.post('/api/workbench/kernel/provision', json={})
        assert resp.status_code == 400
        resp = await ac.post(
            '/api/workbench/kernel/provision',
            json={'workspace': str(tmp_path / 'no-such-dir')},
        )
        assert resp.status_code == 400
