"""The `rm` guard must survive a flag permutation (triage #100).

Correcting the triage first, because the finding was wrong about what it was
looking at. `_ALLOWEDCommandPrefixes` contains `rm`, `chmod`, `chown`, `find` and
full shells — but it is a FIRST-WORD filter: it decides which BINARY may be
invoked, not which arguments are safe. The second layer, a `dangerous` substring
list, is what decides destructive invocations. Removing `rm` from the allowlist
would break a coding agent that cannot delete a build directory, and would close
nothing, because the allowlist was never the boundary.

The real hole is in that substring list: it carries `rm -rf /` and `rm -rf ~` as
literal strings, so one exact spelling. Flag order, extra spacing, the long
form, a deeper target and `$HOME` all passed. These tests pin the spellings that
used to get through, and — just as importantly — the workspace-scoped `rm` that
must keep working.
"""

from __future__ import annotations

import pytest
from app.services.tool_registrations.file_tools import _destructive_rm


class TestBypassesThatUsedToWork:
    @pytest.mark.parametrize(
        'command',
        [
            'rm -rf /',
            'rm -fr /',  # flag order
            'rm  -rf  /',  # extra spacing
            'rm --recursive --force /',  # long form
            'rm -rf /etc',  # deeper target
            'rm -rf /usr/bin',  # deeper still
            'rm -rf ~',  # home, spelled
            'rm -rf $HOME',  # home, expanded
            'rm -rf ~/projects',  # home subtree
            'rm -rf ..',  # climbing out
            'cd /tmp && rm -rf /',  # after a separator
            'echo hi; rm -rf /',  # after a separator
            'true && rm --recursive --force ~',
        ],
    )
    def test_a_recursive_force_rm_aimed_outside_is_caught(self, command):
        assert _destructive_rm(command), f'{command!r} bypassed the rm guard'


class TestTheWiring:
    """The helper is not the guard until `_runCommand` actually calls it.

    Every other test here exercises `_destructive_rm` directly, so they all
    passed against a build where `_runCommand` no longer consulted it. This
    class drives the entry point instead, and asserts nothing was executed.
    """

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        'command',
        ['rm -rf /', 'rm -fr /', 'rm --recursive --force ~', 'rm -rf $HOME'],
    )
    async def test_run_command_refuses_it_without_executing(self, command, monkeypatch):
        from app.services.tool_registrations import file_tools

        ran: list[str] = []

        async def _must_not_run(*a, **kw):
            ran.append(command)
            return 'SHOULD NEVER HAPPEN'

        monkeypatch.setattr(file_tools, 'run_sandboxed', _must_not_run, raising=False)
        out = await file_tools._runCommand(command)
        assert not ran, f'{command!r} was EXECUTED despite the guard'
        assert 'outside the workspace' in out or 'dangerous pattern' in out, (
            f'{command!r} produced no refusal: {out!r}'
        )

    @pytest.mark.asyncio
    async def test_the_ordinary_case_is_not_refused_by_the_guard(self):
        """The guard must not swallow the path to the real sandbox.

        No monkeypatch here: `run_sandboxed` is imported INSIDE `_runCommand`,
        so there is no module attribute to patch — the first draft raised
        AttributeError for exactly that reason. All that matters is that the
        guard did not claim it, so a harmless nonexistent target is used and the
        command is left to fail on its own terms.
        """
        from app.services.tool_registrations import file_tools

        out = await file_tools._runCommand('rm -rf nosuchdir-august-probe')
        assert 'outside the workspace' not in out, (
            f'a workspace-scoped rm was refused by the guard: {out!r}'
        )
        assert 'dangerous pattern' not in out

class TestWorkspaceWorkThatMustKeepWorking:
    @pytest.mark.parametrize(
        'command',
        [
            'rm -rf build',
            'rm -rf ./node_modules',
            'rm -rf dist/*.map',
            'rm -f package-lock.json',
            'rm stale.txt',
            'git clean -fdx',  # still caught by the substring list, not here
            'npm run clean',
            'echo removing the old build && rm -rf build',
        ],
    )
    def test_ordinary_removal_is_not_caught(self, command):
        assert not _destructive_rm(command), (
            f'{command!r} was refused — the agent must still be able to delete '
            'its own build output'
        )

    def test_rm_without_recursion_is_not_caught(self):
        """`rm -f /etc/passwd` names one file; that is the sandbox's call."""
        assert not _destructive_rm('rm -f /etc/passwd')

    def test_a_recursive_rm_inside_the_workspace_is_not_caught(self):
        assert not _destructive_rm('rm -rf src/old')

    def test_the_word_rm_inside_a_path_is_not_mistaken_for_the_command(self):
        """`rm` as a directory name must not trip the guard."""
        assert not _destructive_rm('ls -la /home/x/rm/')
        assert not _destructive_rm('cat rm/notes.txt')