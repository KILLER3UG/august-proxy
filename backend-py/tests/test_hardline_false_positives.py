r"""The credential-read guard must be blind to ordinary paths and sharp on keys.

`id_rsa|id_ed25519` was widened to `id_\w+` so every OpenSSH key type is
covered. Left unanchored, it matched anywhere in the path rather than at the
start of a path component, so it refused to read files that merely CONTAIN
those letters:

    /home/u/grid_layout/main.py     -> `id_l` inside `grid_layout`
    /repo/user_id_seed.sql          -> `id_seed` inside `user_id_seed.sql`
    /tmp/test_x_id_still_0/keep.txt -> `id_still` inside the directory name

A model asked to inspect one of those reports that the file does not exist,
which is a silent wrong answer rather than a visible refusal.

These tests pin both directions. A guard that stops blocking real keys is
worse than the false positive it replaced, so the negative cases are the
important half.
"""

from __future__ import annotations

import pytest
from app.services.sandbox.hardline import check_hardline_command, check_hardline_path


class TestRealCredentialsStayBlocked:
    @pytest.mark.parametrize(
        'path',
        [
            '/home/u/.ssh/id_rsa',
            '/home/u/.ssh/id_ed25519',
            '/home/u/.ssh/id_ecdsa',
            '/home/u/.ssh/id_dsa',
            '/home/u/.ssh/id_rsa.bak',  # still a key, still a component start
            '/srv/app/providers.json',
            '/home/u/.aws/credentials',
            '/home/u/.aws/config',
            '/repo/.git-credentials',
            '/home/u/.netrc',
            '/certs/server.pem',
            '/certs/server.key',
            '/home/u/credentials',
            '/home/u/.ssh/*',  # the directory rule, as typed
        ],
    )
    def test_credential_reads_are_refused(self, path: str):
        assert check_hardline_path(path, for_write=False) is not None

    def test_an_ssh_key_still_blocks_a_command_reading_it(self):
        assert check_hardline_command('cat /home/u/.ssh/id_rsa') is not None

    def test_a_pem_header_in_a_PATH_still_blocks(self):
        # `check_hardline_path` sees the whole string as one token, so the
        # header pattern works there.
        assert check_hardline_path('/tmp/leaked-----BEGIN RSA PRIVATE KEY-----', for_write=False)

    def test_known_gap_a_pem_header_split_across_a_COMMAND_line_is_not_matched(self):
        """Pre-existing, NOT introduced by the component-anchoring change.

        `_tokenize` splits a command on whitespace, so the multi-word
        `-----BEGIN ... PRIVATE KEY-----` pattern can never match a single
        token on the command path. The realistic exposure is low — a command
        echoing a header it already has in hand — and `check_hardline_path`
        covers the file-read case, which is where a pasted key would actually
        enter. Pinned as a known gap so a future fix to `_tokenize` is
        noticed, not assumed.
        """
        assert check_hardline_command('cat "-----BEGIN RSA PRIVATE KEY-----" notes.txt') is None


class TestOrdinaryPathsAreNotFalsePositives:
    @pytest.mark.parametrize(
        'path',
        [
            '/home/u/grid_layout/main.py',  # contains `id_l`
            '/repo/user_id_seed.sql',  # contains `id_seed`
            '/tmp/test_x_id_still_0/keep.txt',  # contains `id_still`
            '/repo/valid_identity.py',  # contains `id_identity`
            '/repo/void_system/loader.go',
            '/repo/src/idempotent.py',  # starts with `id`, not `id_`
        ],
    )
    def test_ordinary_files_are_readable(self, path: str):
        assert check_hardline_path(path, for_write=False) is None

    def test_a_command_touching_an_ordinary_file_is_allowed(self):
        assert check_hardline_command('cat /home/u/grid_layout/main.py') is None

    def test_the_false_positive_does_not_leak_into_write_mode(self):
        """Writes were never affected by this — `_PROTECTED_WRITE_PATTERN`
        has no `id_` rule — but pinning it keeps the two consistent."""
        for p in ('/home/u/grid_layout/main.py', '/repo/user_id_seed.sql'):
            assert check_hardline_path(p, for_write=True) is None
