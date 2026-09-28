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
