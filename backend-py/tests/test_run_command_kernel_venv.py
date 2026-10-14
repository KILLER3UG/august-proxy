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


def test_the_tree_that_may_run_is_the_tree_that_may_not_be_written(ws) -> None:
    """One rule, two halves — asserted against the SAME derived path.

    `run_command` is exempted to EXECUTE this venv, so `write_file` must not be
    able to put code inside it. The exemption follows `kernel._KERNEL_SUBDIR`
    while the door in `hardline._agent_state_reason` matches the literal
    `.aug/kernel`, and the door's own tests spell that same literal — so renaming
    the constant leaves the door guarding a directory nothing uses, its tests
    still green, while the exemption moves to the real one. Measured: with
    `_KERNEL_SUBDIR` set to `.aug/kernels`, `test_sandbox_hardline`'s kernel cases
    pass and this one fails.

    Deriving both sides from `kernel_venv_dir()` is what makes the pair move
    together or fail here.
    """
    from pathlib import Path

    from app.services.sandbox.hardline import check_hardline_path
    from app.services.workbench.kernel import kernel_venv_dir

    venv = kernel_venv_dir(str(ws))
    assert 'kernel' in venv.replace(chr(92), '/'), f'not derived from the real constant: {venv}'

    program = Path(venv) / 'Scripts' / 'python.exe'
    program.parent.mkdir(parents=True, exist_ok=True)
    program.write_bytes(b'\x00binary-not-run')

    # The execution exemption is live for exactly this tree...
    assert file_tools._isKernelVenvProgram(f'"{program}"') is True

    # ...so every writable location inside it must be refused, reads allowed.
    for target in (
        str(program),
        str(Path(venv) / 'Lib' / 'site-packages' / 'evil' / '__init__.py'),
        str(Path(venv) / 'pyvenv.cfg'),
    ):
        assert check_hardline_path(target, for_write=True) is not None, target
        assert check_hardline_path(target, for_write=False) is None, target

    # And the tree next door is untouched — the rule is the venv, not `.aug`.
    assert check_hardline_path(str(ws / '.aug' / 'notes.md'), for_write=True) is None
