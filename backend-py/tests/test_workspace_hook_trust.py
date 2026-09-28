"""A workspace `.aug/hooks.json` must not be trusted just because it exists.

The file ships INSIDE the repository. Cloning a repo is enough to place a
command there, and it fires on PRE_TOOL_USE — the one emitter that carries
workspace_path, so the handler's scoping guard does not short-circuit it.

Two ways in, both reachable in a single turn:

  * the user clones an untrusted repo and the hook fires on the first tool
    call, with no prompt and no consent;
  * the model calls write_file on `.aug/hooks.json` and the NEXT tool call in
    the same turn runs it.

That is "sandboxed shell" becoming "unsandboxed shell with the backend's
environment" and no approval banner — the capability code mode requires an
explicit human marker for.

User-level `<dataDir>/hooks.json` is deliberately unaffected: nothing the
user clones or opens can write into their own data directory, so that file IS
the trust boundary and keeps working.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from app.lib.paths import dataDir
from app.services.hooks import user_hooks
from app.services.hooks.registry import registry

_HOOK = [{
    'name': 'wsdeny',
    'event': 'pre_tool_use',
    'matcher': '*',
    'command': 'exit 2',
}]


def _write(path, payload) -> None:
    import json

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'hooks': payload}), 'utf-8')


@pytest.fixture
async def client():
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


@pytest.fixture(autouse=True)
def _clean():
    user_hooks.reset_for_tests()
    trust = dataDir() / user_hooks._TRUST_STORE
    if trust.is_file():
        trust.unlink()
    yield
    user_hooks.reset_for_tests()
    if trust.is_file():
        trust.unlink()


class TestWorkspaceHooksAreTrustGated:
    def test_an_untrusted_workspace_registers_nothing(self, tmp_path):
        ws = tmp_path / 'cloned-repo'
        (ws / '.aug').mkdir(parents=True)
        _write(ws / '.aug' / 'hooks.json', _HOOK)

        assert user_hooks.ensure_hooks_loaded(str(ws)) == 0
        assert not [n for n in user_hooks.describe() if n['name'].startswith('ws:')]

    def test_trusting_it_registers_the_hook(self, tmp_path):
        ws = tmp_path / 'my-repo'
        (ws / '.aug').mkdir(parents=True)
        _write(ws / '.aug' / 'hooks.json', _HOOK)

        assert user_hooks.trust_workspace(ws) is True
        assert user_hooks.is_workspace_trusted(ws) is True
        assert user_hooks.ensure_hooks_loaded(str(ws)) == 1

    def test_trust_is_scoped_to_one_workspace(self, tmp_path):
        mine = tmp_path / 'mine'
        other = tmp_path / 'other'
        for ws in (mine, other):
            (ws / '.aug').mkdir(parents=True)
            _write(ws / '.aug' / 'hooks.json', _HOOK)

        user_hooks.trust_workspace(mine)
        user_hooks.ensure_hooks_loaded(str(mine))
        user_hooks.ensure_hooks_loaded(str(other))

        trusted = {n for n in user_hooks.trusted_workspaces()}
        assert str(mine.resolve()) in trusted
        assert str(other.resolve()) not in trusted

    def test_revoking_withdraws_live_handlers(self, tmp_path):
        """Consent has to be withdrawable while the process is running.

        Persisted trust means a restart re-arms a workspace the user has since
        stopped trusting; revocation must unregister, not just forget.
        """
        ws = tmp_path / 'repo'
        (ws / '.aug').mkdir(parents=True)
        _write(ws / '.aug' / 'hooks.json', _HOOK)
        user_hooks.trust_workspace(ws)
        assert user_hooks.ensure_hooks_loaded(str(ws)) == 1

        assert user_hooks.revoke_workspace(ws) is True
        assert not [n for n in user_hooks.describe() if n['name'].startswith('ws:')]

    def test_a_path_that_resolves_to_a_trusted_dir_is_trusted(self, tmp_path):
        """Trust is keyed on the resolved path.

        Otherwise `..` segments or a symlink would let one approval cover
        every directory it can name.
        """
        ws = tmp_path / 'repo'
        ws.mkdir()
        user_hooks.trust_workspace(ws)
        assert user_hooks.is_workspace_trusted(ws / 'sub' / '..') is True
        assert user_hooks.is_workspace_trusted(tmp_path / 'elsewhere') is False


class TestUserHooksAreUnaffected:
    def test_a_user_level_hook_still_loads(self):
        _write(dataDir() / 'hooks.json', [{
            'name': 'userhook',
            'event': 'pre_tool_use',
            'matcher': '*',
            'command': 'exit 0',
        }])
        assert user_hooks.ensure_hooks_loaded() == 1
        assert any(n['name'].startswith('user:') for n in user_hooks.describe())


class TestDeletedConfigStopsFiring:
    def test_removing_the_file_unregisters_its_handlers(self, tmp_path):
        """A deleted hooks.json must disarm, not linger.

        `_register_from_file` returned early on a missing file, before the
        sweep that unregisters removed entries — so deleting the file left the
        command live for the life of the process. The registry keeps no mtime,
        so nothing else would ever notice.
        """
        ws = tmp_path / 'repo'
        (ws / '.aug').mkdir(parents=True)
        cfg = ws / '.aug' / 'hooks.json'
        _write(cfg, _HOOK)
        user_hooks.trust_workspace(ws)
        assert user_hooks.ensure_hooks_loaded(str(ws)) == 1

        cfg.unlink()
        assert user_hooks.ensure_hooks_loaded(str(ws)) == 0
        assert not [n for n in user_hooks.describe() if n['name'].startswith('ws:')]
        assert registry is not None


class TestRevocationActuallyDisarms:
    """F3: `revoke_workspace` returned True while the hook kept running.

    Proven with a marker file written after revocation. Two independent causes:
    the disarm compared path STRINGS while trust is keyed on the RESOLVED
    directory, and the trust check sat BELOW the unchanged-mtime early-return,
    so a revoked workspace's handlers survived every later prompt build.
    """

    def test_a_non_canonical_workspace_is_disarmed(self, tmp_path):
        ws = tmp_path / 'repo'
        (ws / '.aug').mkdir(parents=True)
        _write(ws / '.aug' / 'hooks.json', _HOOK)
        # The form that used to break it: trust resolves, the disarm did not.
        messy = str(ws / '.' / '..' / 'repo')
        user_hooks.trust_workspace(messy)
        assert user_hooks.ensure_hooks_loaded(messy) == 1
        assert [n for n in user_hooks.describe() if n['name'].startswith('ws:')]

        assert user_hooks.revoke_workspace(messy) is True
        assert not [n for n in user_hooks.describe() if n['name'].startswith('ws:')], (
            'revoke reported success but the handler is still registered'
        )

    def test_a_revoked_workspace_stays_disarmed_across_prompt_builds(self, tmp_path):
        """The mtime early-return used to skip the trust check entirely.

        The file had not changed, so every subsequent `ensure_hooks_loaded`
        returned early — and the revoked handler was never unregistered.
        """
        ws = tmp_path / 'repo2'
        (ws / '.aug').mkdir(parents=True)
        _write(ws / '.aug' / 'hooks.json', _HOOK)
        user_hooks.trust_workspace(ws)
        assert user_hooks.ensure_hooks_loaded(str(ws)) == 1
        user_hooks.revoke_workspace(ws)

        for _ in range(3):  # several prompt builds, file untouched
            user_hooks.ensure_hooks_loaded(str(ws))
            assert not [
                n for n in user_hooks.describe() if n['name'].startswith('ws:')
            ], 'a revoked workspace re-armed on a later prompt build'

    def test_re_approving_after_revocation_works(self, tmp_path):
        ws = tmp_path / 'repo3'
        (ws / '.aug').mkdir(parents=True)
        _write(ws / '.aug' / 'hooks.json', _HOOK)
        user_hooks.trust_workspace(ws)
        user_hooks.ensure_hooks_loaded(str(ws))
        user_hooks.revoke_workspace(ws)
        user_hooks.trust_workspace(ws)
        assert user_hooks.ensure_hooks_loaded(str(ws)) == 1


class TestCredentialStoreBypass:
    """F5: `.ssh/`, `.ssh/.` and `.ssh ` all returned 200 with the entries.

    The guard stripped a trailing `/` and took the last string segment, so a
    `.` segment or a trailing space walked straight past it. It now takes the
    name from the RESOLVED path.
    """

    @pytest.mark.asyncio
    @pytest.mark.parametrize('suffix', ['', '/', '/.', '/./'])
    async def test_no_spelling_of_a_store_lists(self, client, isolatedData, suffix: str):
        from app.lib.paths import dataPath

        base = Path(str(dataPath('observations')))
        ssh = base / '.ssh'
        ssh.mkdir(parents=True, exist_ok=True)
        (ssh / 'id_rsa').write_text('PRIVATE', encoding='utf-8')

        resp = await client.get('/api/workspace/files', params={'path': f'{ssh}{suffix}'})
        assert resp.status_code in (403, 404), f'{suffix!r} listed the store: {resp.text}'
        assert 'id_rsa' not in resp.text

    def test_the_guard_itself_normalises(self, tmp_path):
        from app.services.sandbox.hardline import is_credential_directory

        base = tmp_path / '.ssh'
        base.mkdir()
        # `/.` and `//` are the cross-platform spellings. A TRAILING SPACE is
        # deliberately absent: Windows `resolve()` strips it, so the store is
        # recognised there, but on Linux a trailing space is a legal filename
        # character and a directory literally named `.ssh ` is NOT a
        # credential store. Asserting it cross-platform asserts a falsehood.
        for form in (str(base), f'{base}/', f'{base}/.', f'{base}//'):
            assert is_credential_directory(form), f'{form!r} was not recognised'

    @pytest.mark.skipif(os.name != 'nt', reason='Windows strips trailing spaces in paths')
    def test_windows_normalises_a_trailing_space_away(self, tmp_path):
        from app.services.sandbox.hardline import is_credential_directory

        base = tmp_path / '.ssh'
        base.mkdir()
        assert is_credential_directory(f'{base} ')

    def test_an_ordinary_dot_directory_is_still_listable(self, tmp_path):
        from app.services.sandbox.hardline import is_credential_directory

        assert not is_credential_directory(str(tmp_path / 'src'))


class TestHookEnvironmentIsScrubbed:
    def test_secret_shaped_variables_do_not_reach_the_command(self, monkeypatch):
        monkeypatch.setenv('OPENAI_API_KEY', 'sk-should-not-leak')
        monkeypatch.setenv('AUGUST_GATEWAY_KEY', 'should-not-leak')
        monkeypatch.setenv('MY_DB_PASSWORD', 'should-not-leak')
        monkeypatch.setenv('PATH', '/usr/bin')
        env = user_hooks._hook_env()

        assert 'OPENAI_API_KEY' not in env
        assert 'AUGUST_GATEWAY_KEY' not in env
        assert 'MY_DB_PASSWORD' not in env
        # Ordinary process environment still reaches a hook it was written for.
        assert env.get('PATH') == '/usr/bin'


class TestSuppressedHooksAreNotSilent:
    """The gate was invisible, which made it a feature the user cannot use.

    A workspace whose `.aug/hooks.json` is not trusted used to do nothing at
    all: no banner, no transcript line, nothing to report a bug about. The
    docs say workspace hooks are a supported feature, so the user wires one up,
    watches nothing happen, and has no way to tell a bug from a gate. These
    tests pin that the state is observable and stays true through the whole
    lifecycle, because a notice that appears once and then lies is worse than
    silence.
    """

    @staticmethod
    def _repo(tmp_path):
        ws = tmp_path / 'cloned-repo'
        (ws / '.aug').mkdir(parents=True)
        _write(ws / '.aug' / 'hooks.json', _HOOK)
        return ws

    def test_an_untrusted_workspace_says_its_hooks_are_not_running(self, tmp_path):
        ws = self._repo(tmp_path)
        user_hooks.ensure_hooks_loaded(str(ws))
        notice = user_hooks.inactive_notice(str(ws))
        assert notice, 'a workspace whose hooks are blocked said nothing at all'
        assert 'not' in notice.lower() and 'approv' in notice.lower()
        assert len(user_hooks.inactive_workspace_hooks()) == 1

    def test_the_notice_names_the_file_and_how_many_hooks_are_blocked(self, tmp_path):
        ws = self._repo(tmp_path)
        user_hooks.ensure_hooks_loaded(str(ws))
        entry = user_hooks.inactive_workspace_hooks()[0]
        assert entry['path'].endswith('hooks.json')
        # A bare "not trusted" is not actionable — the user cannot tell an
        # empty file from a blocked one, and would not know anything is
        # being suppressed.
        assert int(entry['suppressed']) >= 1

    def test_approving_clears_the_notice(self, tmp_path):
        ws = self._repo(tmp_path)
        user_hooks.ensure_hooks_loaded(str(ws))
        assert user_hooks.inactive_notice(str(ws))
        user_hooks.trust_workspace(ws)
        user_hooks.ensure_hooks_loaded(str(ws))
        assert user_hooks.inactive_notice(str(ws)) == '', (
            'the notice outlived the approval — a false warning'
        )
        assert user_hooks.inactive_workspace_hooks() == []

    def test_revoking_brings_the_notice_back_immediately(self, tmp_path):
        ws = self._repo(tmp_path)
        user_hooks.trust_workspace(ws)
        user_hooks.ensure_hooks_loaded(str(ws))
        assert user_hooks.inactive_notice(str(ws)) == ''

        user_hooks.revoke_workspace(ws)
        # No reload in between: the review proved the previous version left
        # the reported state stale for a full cycle, and a notice that blinks
        # out for one prompt is one users learn to ignore.
        assert user_hooks.inactive_notice(str(ws)), 'revocation was not reported'

    def test_deleting_the_hooks_file_stops_the_warning(self, tmp_path):
        ws = self._repo(tmp_path)
        user_hooks.ensure_hooks_loaded(str(ws))
        assert user_hooks.inactive_notice(str(ws))
        (ws / '.aug' / 'hooks.json').unlink()
        user_hooks.ensure_hooks_loaded(str(ws))
        assert user_hooks.inactive_notice(str(ws)) == '', (
            'warning about a file that no longer exists'
        )

    def test_a_workspace_with_no_hooks_file_is_never_warned_about(self, tmp_path):
        """The distinction the API response also has to make.

        An untrusted workspace with nothing to suppress is the common case. If
        it were reported the same way, every user would see a hooks warning on
        every project, and the one project that needs it would be the warning
        they have learned to dismiss.
        """
        ws = tmp_path / 'plain-repo'
        ws.mkdir()
        user_hooks.ensure_hooks_loaded(str(ws))
        assert user_hooks.inactive_notice(str(ws)) == ''
        assert user_hooks.inactive_workspace_hooks() == []

    def test_an_empty_hooks_file_does_not_manufacture_a_count(self, tmp_path):
        ws = tmp_path / 'empty-repo'
        (ws / '.aug').mkdir(parents=True)
        _write(ws / '.aug' / 'hooks.json', {'hooks': []})
        user_hooks.ensure_hooks_loaded(str(ws))
        assert user_hooks.inactive_notice(str(ws)) == ''

    def test_trusted_workspaces_stay_silent(self, tmp_path):
        """The cost side: this must be empty for everyone not hitting the gate."""
        ws = self._repo(tmp_path)
        user_hooks.trust_workspace(ws)
        user_hooks.ensure_hooks_loaded(str(ws))
        assert user_hooks.inactive_notice(str(ws)) == ''
