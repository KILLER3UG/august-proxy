"""run_command's first-word filter must admit the session's own kernel venv.

A kernel-venv scene runs as a PATH —
``<ws>/.aug/kernel/venv/Scripts/python.exe scene.py`` — and there is no
``python`` on PATH that is that interpreter, so before this the command was
refused as "not in the allowed list": the tier was the risk, not the venv.
The venv is session-owned (the user provisioned it from Settings), so a
program inside THIS workspace's venv is the one sanctioned path-form
exception. Everything else — including a venv belonging to another
workspace — still hits the allowlist.

The sandbox runner is stubbed: what is under test is the gate's DECISION,
not a subprocess.
"""

from __future__ import annotations

import pytest
from app.services.tool_registrations import file_tools


def _plant_venv(ws, *, interpreter='Scripts/python.exe'):
    program = ws / '.aug' / 'kernel' / 'venv' / interpreter
    program.parent.mkdir(parents=True, exist_ok=True)
    program.write_bytes(b'\x00binary-not-run')
    return program


def _stub_sandbox(monkeypatch):
    """Stub the sandbox runner; the fixture already scoped `_workspace`.

    The first draft re-patched `_workspace` from inside this helper and
    closed over a name that does not exist there — the fixture owns that
    patch, and re-applying it silently replaced a valid workspace with a
    broken lambda, so the gate under test saw no workspace at all.
    """
    ran: list[str] = []

    class _Ran:
        # The fields _runCommand reads off the sandbox result.
        ok = True
        denial_reason = ''
        hardline = False
        enforcement = ''
        stdout = ''
        stderr = ''

        def as_tool_text(self) -> str:
            return 'ran'

    async def _fake_sandboxed(command, _policy, **_kw):
        ran.append(str(command))
        return _Ran()

    monkeypatch.setattr(file_tools, 'run_sandboxed', _fake_sandboxed, raising=False)
    return ran


@pytest.fixture
def ws(tmp_path, monkeypatch):
    root = tmp_path / 'ws'
    root.mkdir()
    monkeypatch.setattr(file_tools, '_workspace', lambda: str(root))
    return root


async def test_a_venv_program_passes_the_first_word_gate(ws, monkeypatch):
    program = _plant_venv(ws)
    ran = _stub_sandbox(monkeypatch)
    out = await file_tools._runCommand(f'"{program}" scene.py')
    assert 'not in the allowed list' not in out, out
    assert ran, 'the command never reached the sandbox runner'


async def test_the_venvs_console_scripts_pass_too(ws, monkeypatch):
    # manimgx's CLI is a console script in the same Scripts/ directory.
    program = _plant_venv(ws, interpreter='Scripts/manimgx.exe')
    ran = _stub_sandbox(monkeypatch)
    out = await file_tools._runCommand(f'{program} render scene.py')
    assert 'not in the allowed list' not in out, out
    assert ran


async def test_a_program_outside_the_venv_is_still_refused(ws, monkeypatch):
    _stub_sandbox(monkeypatch)
    out = await file_tools._runCommand('C:/Windows/System32/python.exe scene.py')
    assert 'not in the allowed list' in out


async def test_another_workspaces_venv_is_refused(ws, tmp_path, monkeypatch):
    other = tmp_path / 'other-ws'
    _plant_venv(other)
    _stub_sandbox(monkeypatch)
    out = await file_tools._runCommand(
        f'"{other / ".aug" / "kernel" / "venv" / "Scripts" / "python.exe"}" scene.py'
    )
    assert 'not in the allowed list' in out


async def test_no_venv_no_exception(ws, monkeypatch):
    # The workspace exists but nothing was provisioned — the gate is closed.
    ran = _stub_sandbox(monkeypatch)
    out = await file_tools._runCommand(
        f'"{ws / ".aug" / "kernel" / "venv" / "Scripts" / "python.exe"}" scene.py'
    )
    assert 'not in the allowed list' in out
    assert not ran
