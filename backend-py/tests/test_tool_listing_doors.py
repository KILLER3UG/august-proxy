"""The tool surface had the third and fourth listing doors.

`/api/workspace/files` and `/api/workbench/workspace/files` were closed on
2026-10-12 by routing both through `sandbox.paths.listable_root`. The two entry
points the *agent* uses — the `list_directory` tool and the `search_files` tool —
were never in that pair, and they answer the same question about the same paths.

This file is the measurement, not the theory: on this machine, before the fix,
`list_directory("~/.ssh")` returned a row per key and `search_files(path="~/.ssh")`
accepted the store as a search root (the refusal, if any, had to come from the
per-file hardline check, which `rg` never consults for the root itself).
"""

from __future__ import annotations

import asyncio
import os

import pytest


@pytest.fixture
def store_root(tmp_path):
    """A temp tree that a folderless session can read (temp is an implicit root)
    and that contains a credential store with a secret inside it."""
    ssh = tmp_path / '.ssh'
    ssh.mkdir()
    (ssh / 'id_ed25519').write_text('PRIVATE KEY MATERIAL', encoding='utf-8')
    (ssh / 'config').write_text('Host *\n  IdentityFile ~/.ssh/id_ed25519\n', encoding='utf-8')
    (tmp_path / 'notes.md').write_text('PRIVATE KEY MATERIAL appears here too', encoding='utf-8')
    return tmp_path


class TestListDirectoryIsAListingDoor:
    def test_a_credential_store_is_not_listable(self, store_root):
        from app.services.tool_registrations.file_tools import _listDirectory

        out = asyncio.run(_listDirectory(str(store_root / '.ssh')))
        assert 'id_ed25519' not in out, f'the store was listed: {out!r}'
        assert 'config' not in out, f'the store was listed: {out!r}'
        assert 'Refused' in out or 'blocked' in out.lower(), f'no refusal reported: {out!r}'

    def test_a_store_nested_in_a_listable_parent_is_not_named(self, store_root):
        from app.services.tool_registrations.file_tools import _listDirectory

        out = asyncio.run(_listDirectory(str(store_root)))
        assert 'notes.md' in out, f'the ordinary listing broke: {out!r}'
        assert '.ssh' not in out, f'the store rode along with its parent: {out!r}'

    def test_an_ordinary_directory_still_lists(self, store_root):
        from app.services.tool_registrations.file_tools import _listDirectory

        good = store_root / 'proj'
        good.mkdir()
        (good / 'a.py').write_text('x = 1', encoding='utf-8')
        out = asyncio.run(_listDirectory(str(good)))
        assert 'a.py' in out, out


class TestSearchFilesIsAListingDoor:
    """`rg` is handed the resolved root and walks it. The per-file hardline
    guard never runs on that walk, so accepting a store as a search root is a
    content leak, not just a name leak — a query for a string inside a key
    returns the key's path and the matching line."""

    def test_a_credential_store_is_not_a_search_root(self, store_root):
        from app.services.tool_registrations.file_tools import _searchFiles as search_files

        out = asyncio.run(search_files('PRIVATE KEY MATERIAL', path=str(store_root / '.ssh')))
        assert 'id_ed25519' not in out, f'the store was searched: {out!r}'
        assert 'Refused' in out or 'blocked' in out.lower(), f'no refusal reported: {out!r}'

    def test_a_store_under_a_searched_parent_is_not_searched(self, store_root):
        from app.services.tool_registrations.file_tools import _searchFiles as search_files

        out = asyncio.run(search_files('PRIVATE KEY MATERIAL', path=str(store_root)))
        assert 'notes.md' in out, f'the ordinary search broke: {out!r}'
        assert '.ssh' not in out, f'a key inside the store matched: {out!r}'


class TestSearchResultsAreFramedByTheGuardNotByAColon:
    """`rg` prints `path:lineno:text`, and a path may contain `:1:`.

    The result filter used to find the path by splitting on the FIRST
    `:digits:` group. Put a credential-named file under a directory whose own name
    carries one (a timestamped export like `run:10:13:56`, a `backup:2026:10`
    folder) and the guard was handed `./run` — a string naming nothing, which it
    approved — so the line came back carrying the secret path AND the matched
    content. The search now asks rg for NUL framing and refuses any line it cannot
    frame instead of guessing where the path ends.
    """

    # Windows refuses ':' in a file or directory name, so the end-to-end shape of
    # this attack can only be built on a POSIX filesystem — which is where the
    # proxy also runs (the CI job is Ubuntu). The judgement itself is tested
    # without a filesystem below, so the rule is covered on both shapes.
    @pytest.mark.skipif(os.name == 'nt', reason="':' cannot appear in a Windows path name")
    @pytest.mark.asyncio
    async def test_a_colon_in_a_directory_name_does_not_hide_a_hit(self, tmp_path):
        from app.services.tool_registrations.file_tools import _searchFiles

        nest = tmp_path / 'run:10:13:56'
        nest.mkdir()
        (nest / 'id_rsa').write_text('PRIVATE KEY MATERIAL', encoding='utf-8')
        (tmp_path / 'notes.md').write_text('PRIVATE KEY MATERIAL in the clear', encoding='utf-8')

        out = await _searchFiles('PRIVATE KEY MATERIAL', str(tmp_path))
        assert 'notes.md' in out, f'the ordinary hit disappeared: {out!r}'
        assert 'id_rsa' not in out, f'the colon in the directory name hid the secret: {out!r}'

    def test_a_line_without_a_frame_is_dropped_not_trusted(self):
        from app.services.tool_registrations.file_tools import _rgLineIsListable

        # No NUL: an rg build without `--null`, a truncated read, a shape that
        # lost the separator. The old code asked the guard about the prefix and
        # kept the line; nothing is kept that cannot be named.
        assert _rgLineIsListable('./repo/secrets/id_rsa:1:SECRET') is False
        assert _rgLineIsListable('') is False
        assert _rgLineIsListable(chr(0) + '1:SECRET') is False

    def test_a_framed_line_is_judged_on_its_whole_path(self, tmp_path):
        from app.services.tool_registrations.file_tools import _rgLineIsListable

        good = tmp_path / 'app.py'
        good.write_text('x = 1', encoding='utf-8')
        assert _rgLineIsListable(f'{good}{chr(0)}1:x = 1') is True

        key = tmp_path / 'id_ed25519'
        key.write_text('PRIVATE', encoding='utf-8')
        assert _rgLineIsListable(f'{key}{chr(0)}1:PRIVATE') is False

        # No filesystem needed: this is the line rg would print for
        # `repo/run:10:13:56/id_rsa`, where the first `:digits:` sits inside the
        # path. Judged as itself, the key is refused; truncated at `repo/run`, the
        # old filter asked about nothing and kept the line.
        colon_path = f'{tmp_path}/run:10:13:56/id_rsa'
        assert _rgLineIsListable(f'{colon_path}{chr(0)}1:PRIVATE') is False
        # …and a NON-secret file under the same odd directory name still reads,
        # so the fix is not "drop anything with a colon in it".
        harmless = f'{tmp_path}/run:10:13:56/app.py'
        assert _rgLineIsListable(f'{harmless}{chr(0)}1:x = 1') is True


class TestTheFallbackSearchCarriesTheSameRule:
    """The Python fallback runs when rg is missing, so it needs the rule too.

    It used to lean on its own "any part starts with a dot" check, which happens
    to cover `.ssh` today — a label list doing a guard's job. `.config/gh` is the
    proof that the two are not the same rule: the dot check matches `.config`, and
    the store is `.config/gh`.
    """

    def test_the_fallback_refuses_a_key_by_name_rule(self, tmp_path):
        from pathlib import Path

        from app.services.sandbox.paths import bind_path
        from app.services.tool_registrations.file_tools import _pySearchFilesSync

        root = tmp_path / 'repo'
        (root / 'nested').mkdir(parents=True)
        (root / 'nested' / 'id_rsa').write_text('PRIVATE KEY MATERIAL', encoding='utf-8')
        (root / 'app.py').write_text('PRIVATE KEY MATERIAL', encoding='utf-8')
        bound, err = bind_path(str(root), None, for_write=False)
        assert err is None and bound is not None

        out = _pySearchFilesSync('PRIVATE KEY MATERIAL', Path(bound))
        assert 'app.py' in out, out
        assert 'id_rsa' not in out, f'the fallback named a key: {out!r}'


class TestTheShellDoorsCarryTheStoreRule:
    """A shell command enumerates a directory just as a tool does.

    `check_hardline_command` matched credential NAMES (`id_rsa`, `credentials`) and
    the store-directory rule lived only in `is_credential_directory`, which the
    command path never called. So `ls ~/.ssh` — probed on this machine, before the
    fix, returned None — walked straight past the guard that refuses the same path
    through every file door, and the listing lands in the transcript and upstream.

    Code mode (`run_command` and `list_files` inside the sandbox preamble) is a
    SEPARATE copy of the guard, injected as a template, and it carried neither the
    store rule nor `is_credential_directory` at all — so the same path was open a
    second time, in the surface whose whole purpose is running commands.
    """

    @pytest.mark.parametrize(
        'cmd',
        [
            'ls ~/.ssh',
            'ls -la ~/.aws',
            'find ~/.ssh -type f',
            r'dir %USERPROFILE%\.ssh',
            'ls ~/.config/gh',
            'ls $HOME/.gnupg',
        ],
    )
    def test_a_store_named_in_a_command_is_refused(self, cmd):
        from app.services.sandbox.hardline import check_hardline_command

        reason = check_hardline_command(cmd)
        assert reason is not None, f'the shell door allowed {cmd!r}'
        assert 'credential store' in reason, reason

    @pytest.mark.parametrize(
        'cmd',
        [
            'ls -la src',
            'cat README.md',
            'grep -rn aws .',
            'ls .aws-sdk',
            'ls src/.ssh_helpers',
            'python manage.py migrate',
            r'ls C:\dev\my.aws.thing\app.py',
            'git log --oneline',
        ],
    )
    def test_an_ordinary_command_is_still_allowed(self, cmd):
        """The rule is a component match, not a substring match.

        `.aws-sdk` and `.ssh_helpers` are ordinary directories; refusing them would
        push the model to work around a guard that cries wolf, which is how guards
        get removed.
        """
        from app.services.sandbox.hardline import check_hardline_command

        assert check_hardline_command(cmd) is None, check_hardline_command(cmd)

    def test_the_named_non_secret_member_of_a_store_stays_readable(self):
        """The considered decision, kept on the new door too.

        `.ssh` is unlistable, but `authorized_keys` and `config` are readable by
        name — that asymmetry is deliberate and pinned by
        `test_computer_access_allowlist.py`. A port of the rule that widened it to
        the whole subtree would be a silent policy change delivered through code
        mode.
        """
        from app.services.sandbox.hardline import check_hardline_command

        assert check_hardline_command('cat ~/.ssh/authorized_keys') is None
        assert check_hardline_command('cat ~/.ssh/config') is None
