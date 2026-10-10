"""The "Computer access" allowlist was a promise the backend never kept.

Settings → Computer access (`ComputerAccessSettings.tsx`) writes
`security.filesystemScope` and `security.allowedRoots`, and the UI offers
"allowlist" vs "the whole computer". The only references to those keys
anywhere in the backend were the getter and setter in `routers/security.py`
that stored them — nothing read them to make a decision. A user who
restricted computer access to two project folders was told they had, while
every file tool still did exactly what it liked.

These tests pin that the setting is now enforced, and — just as important —
that NOT configuring it changes nothing for anyone who never opened the
setting. The stored default is `allowlist` + `[]`; read literally that would
deny every file operation on a fresh install, so an empty list has to mean
"not configured" rather than "nothing permitted".
"""

from __future__ import annotations

import pytest
from app.main import app
from app.services.sandbox.paths import bind_path
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    """No shared `client` fixture exists — see test_camel_model_git.py."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


@pytest.fixture
def ws(tmp_path):
    root = tmp_path / 'workspace'
    root.mkdir()
    return root


@pytest.fixture
def _set_security(monkeypatch):
    """Install a security config the way `PUT /api/security` would."""
    from app.services import config_service

    def _apply(scope: str, roots: list[str]) -> None:
        cfg = dict(config_service.getConfig() or {})
        cfg['security'] = {'filesystemScope': scope, 'allowedRoots': roots}
        monkeypatch.setattr(config_service, 'getConfig', lambda: cfg)

    return _apply


class TestUnconfiguredIsUnchanged:
    """The regression that would brick every existing user."""

    def test_an_empty_allowlist_does_not_block_the_workspace(self, ws, _set_security):
        _set_security('allowlist', [])
        path, err = bind_path(str(ws / 'a.txt'), str(ws))
        assert err is None
        assert path is not None

    def test_the_stored_default_shape_also_does_not_block(self, ws, _set_security):
        """Exactly what a user who never touched the setting has on disk."""
        _set_security('allowlist', [])
        assert bind_path(str(ws / 'deep' / 'b.txt'), str(ws))[1] is None


class TestConfiguredAllowlistIsEnforced:
    def test_a_path_outside_every_allowed_root_is_refused(self, ws, tmp_path, _set_security):
        elsewhere = tmp_path / 'elsewhere'
        elsewhere.mkdir()
        _set_security('allowlist', [str(ws)])
        path, err = bind_path(str(elsewhere / 'secret.txt'), None)
        assert path is None
        assert err is not None
        assert 'allowed roots' in err

    def test_a_path_inside_an_allowed_root_is_allowed(self, ws, _set_security):
        _set_security('allowlist', [str(ws)])
        path, err = bind_path(str(ws / 'ok.txt'), None)
        assert err is None
        assert path == (ws / 'ok.txt').resolve()

    def test_the_session_workspace_stays_implicitly_allowed(self, ws, tmp_path, _set_security):
        """The user pointed this chat at the folder; an allowlist that excluded
        it would contradict that rather than express it."""
        other_ws = tmp_path / 'other'
        other_ws.mkdir()
        _set_security('allowlist', [str(other_ws)])
        path, err = bind_path(str(ws / 'in_ws.txt'), str(ws))
        assert err is None
        assert path is not None

    def test_scope_root_means_no_gate_at_all(self, tmp_path, _set_security):
        _set_security('root', [str(tmp_path)])
        assert bind_path(str(tmp_path / 'anything.txt'), None)[1] is None

    def test_one_of_several_roots_matching_is_enough(self, tmp_path, _set_security):
        a = tmp_path / 'a'
        b = tmp_path / 'b'
        a.mkdir()
        b.mkdir()
        _set_security('allowlist', [str(a), str(b)])
        assert bind_path(str(b / 'x.txt'), None)[1] is None

    def test_a_nested_path_under_a_root_is_allowed(self, tmp_path, _set_security):
        root = tmp_path / 'proj'
        (root / 'src' / 'deep').mkdir(parents=True)
        _set_security('allowlist', [str(root)])
        assert bind_path(str(root / 'src' / 'deep' / 'm.py'), None)[1] is None

    def test_a_sibling_with_a_shared_prefix_is_not_inside(self, tmp_path, _set_security):
        """`/x/proj` must not authorise `/x/project-secret`.

        Containment is by path COMPONENT, not string prefix — the mistake that
        makes prefix checks worthless.
        """
        proj = tmp_path / 'proj'
        proj.mkdir()
        sibling = tmp_path / 'project-secret'
        sibling.mkdir()
        _set_security('allowlist', [str(proj)])
        assert bind_path(str(sibling / 'creds.txt'), None)[0] is None

    def test_the_denial_names_the_setting_the_user_can_change(self, tmp_path, _set_security):
        _set_security('allowlist', [str(tmp_path / 'allowed')])
        _, err = bind_path(str(tmp_path / 'other.txt'), None)
        assert err is not None
        assert 'Computer access' in err


class TestTheFileListerUsesTheSameGate:
    """`/api/workspace/files` listed any directory on the machine."""

    @pytest.mark.asyncio
    async def test_a_credential_directory_cannot_be_listed(self, client, tmp_path):
        ssh = tmp_path / '.ssh'
        ssh.mkdir()
        (ssh / 'id_rsa').write_text('PRIVATE', encoding='utf-8')

        resp = await client.get('/api/workspace/files', params={'path': str(ssh)})
        assert resp.status_code in (403, 404), resp.text
        assert 'id_rsa' not in resp.text

    @pytest.mark.asyncio
    async def test_a_credential_store_is_filtered_out_of_a_parent_listing(self, client, tmp_path):
        """Asking for the parent must not reveal the store inside it."""
        home = tmp_path / 'home'
        (home / '.ssh').mkdir(parents=True)
        (home / '.ssh' / 'id_rsa').write_text('PRIVATE', encoding='utf-8')
        (home / 'notes.md').write_text('# hi', encoding='utf-8')

        resp = await client.get('/api/workspace/files', params={'path': str(home)})
        assert resp.status_code == 200, resp.text
        assert 'notes.md' in resp.text
        assert '.ssh' not in resp.text
        assert 'id_rsa' not in resp.text

    @pytest.mark.asyncio
    async def test_reading_one_public_key_still_works(self, isolatedData):
        """The read guard deliberately allows `authorized_keys`.

        The directory being unLISTABLE is a different question from a named
        non-secret file being readable, and collapsing the two would be a
        regression of a considered decision.
        """
        from app.services.sandbox.hardline import check_hardline_path

        ssh = isolatedData / '.ssh'
        ssh.mkdir(parents=True, exist_ok=True)
        (ssh / 'authorized_keys').write_text('ssh-rsa AAAA...', encoding='utf-8')
        assert check_hardline_path(str(ssh / 'authorized_keys'), for_write=False) is None
        # …while the private key beside it is still refused.
        (ssh / 'id_rsa').write_text('PRIVATE', encoding='utf-8')
        assert check_hardline_path(str(ssh / 'id_rsa'), for_write=False) is not None

    @pytest.mark.asyncio
    async def test_an_ordinary_directory_still_lists(self, client, tmp_path):
        good = tmp_path / 'ordinary'
        good.mkdir()
        (good / 'readme.md').write_text('# hi', encoding='utf-8')

        resp = await client.get('/api/workspace/files', params={'path': str(good)})
        assert resp.status_code == 200, resp.text
        assert 'readme.md' in resp.text


class TestFolderlessSessionReadsTheMachine:
    """A chat with no folder bound reads MORE of the machine than one anchored
    at the home directory, so the old default did the opposite of what it looked
    like: `workspacePath = ~` contained every path under it, which is a gate,
    not a starting point. Home is therefore refused as a workspace."""

    def test_the_home_directory_is_refused_as_a_workspace(self):
        from pathlib import Path

        from app.services.sandbox.paths import normalize_session_workspace

        assert normalize_session_workspace(str(Path.home())) == ''
        assert normalize_session_workspace('~') == ''
        assert normalize_session_workspace('   ') == ''
        # A real project under home is a choice, not the default.
        assert normalize_session_workspace(str(Path.home() / 'project')) == str(
            Path.home() / 'project'
        )

    def test_a_session_constructed_at_home_loads_as_folderless(self):
        from pathlib import Path

        from app.services.workbench.sessions import WorkbenchSession

        session = WorkbenchSession(id='wb_x', workspacePath=str(Path.home()))
        assert session.toDict()['workspacePath'] == ''

    def test_binding_home_blocks_reads_that_no_folder_allows(self, tmp_path, _set_security):
        """The consequence, measured rather than argued: the same read outside
        the bound directory is refused with a workspace and permitted without
        one. A stand-in home keeps this off the real one — on Windows the
        genuine home contains the whole temp tree, which would prove nothing."""
        _set_security('allowlist', [])
        home = tmp_path / 'home'
        home.mkdir()
        elsewhere = tmp_path / 'elsewhere'
        elsewhere.mkdir()
        note = elsewhere / 'notes.txt'
        note.write_text('hello', encoding='utf-8')

        assert bind_path(str(note), str(home))[0] is None
        path, err = bind_path(str(note), None)
        assert err is None
        assert path == note.resolve()
