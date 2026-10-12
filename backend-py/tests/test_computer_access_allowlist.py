"""The "Computer access" allowlist was a promise the backend never kept.

Settings → Computer access (`ComputerAccessSettings.tsx`) writes
`security.filesystemScope` and `security.allowedRoots`, and the UI offers
"allowlist" vs "the whole computer". The only references to those keys
anywhere in the backend were the getter and setter in `routers/security.py`
that stored them — nothing read them to make a decision. A user who
restricted computer access to two project folders was told they had, while
every file tool still did exactly what it liked.

These tests pin that the setting is enforced and that the default empty
allowlist remains useful without granting folderless sessions unrestricted
computer access. Folderless reads cover the folderless AREA: the user's home
directory plus the system temp directory that folderless writes are confined to
(reading back what the write gate lets you create is the same policy); paths in
neither are refused. Explicit roots and the whole-computer setting widen it.
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


class TestUnconfiguredAllowlist:
    """The default stays useful while a folderless session gets a safe root."""

    def test_an_empty_allowlist_does_not_block_the_workspace(self, ws, _set_security):
        _set_security('allowlist', [])
        path, err = bind_path(str(ws / 'a.txt'), str(ws))
        assert err is None
        assert path is not None

    def test_the_stored_default_shape_does_not_block_a_selected_workspace(self, ws, _set_security):
        """A workspace the user selected remains implicitly available."""
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

    def test_a_custom_allowed_root_is_available_from_a_project_session(
        self, ws, tmp_path, _set_security
    ):
        shared = tmp_path / 'shared'
        shared.mkdir()
        _set_security('allowlist', [str(shared)])

        path, err = bind_path(str(shared / 'reference.txt'), str(ws))

        assert err is None
        assert path == (shared / 'reference.txt').resolve()

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


LIST_DOORS = pytest.mark.parametrize(
    'door',
    [
        pytest.param('/api/workspace/files', id='tree'),
        pytest.param('/api/workbench/workspace/files', id='mention-picker'),
    ],
)


class TestBothListingDoorsShareOneGate:
    """Two routes list directories, so two routes could disagree.

    `/api/workbench/workspace/files` (the composer @-mention picker) took the
    `path` query, `expanduser()`ed it and walked it with no containment at all,
    while `/api/workspace/files` had been given the hardline + allowlist guard.
    Same request, different verdict: 200 against 403 for one `~/.ssh`. They now
    call one pair of functions (`sandbox.paths.listable_root` for the root,
    `listable_entry` for each child), and a parametrized test over BOTH URLs is
    what keeps them from drifting apart again — a single-door test is exactly
    what let the divergence survive the first round of fixes.
    """

    @LIST_DOORS
    @pytest.mark.asyncio
    async def test_a_credential_directory_is_refused_by_both(self, door, client, tmp_path):
        ssh = tmp_path / '.ssh'
        ssh.mkdir()
        (ssh / 'id_rsa').write_text('PRIVATE', encoding='utf-8')

        resp = await client.get(door, params={'path': str(ssh)})
        assert resp.status_code == 403, f'{door} -> {resp.status_code} {resp.text}'
        assert 'id_rsa' not in resp.text

    @LIST_DOORS
    @pytest.mark.asyncio
    async def test_a_refusal_reports_a_refusal(self, door, client, tmp_path):
        """The picker swallows exceptions to keep typing responsive.

        That blanket catch used to eat its own 403 and answer 200 with an empty
        list, so a refusal was indistinguishable from "no matches" — and the
        asymmetry this class exists to prevent looked fixed while still being
        open. A denial must still reach the caller as a denial.
        """
        ssh = tmp_path / '.ssh'
        ssh.mkdir()

        resp = await client.get(door, params={'path': str(ssh)})
        assert resp.status_code == 403, f'{door} -> {resp.status_code} {resp.text}'

    @LIST_DOORS
    @pytest.mark.asyncio
    async def test_a_store_inside_an_allowed_parent_is_not_named(self, door, client, tmp_path):
        """Asking for a listable parent must not reveal the store inside it."""
        home = tmp_path / 'home'
        (home / '.aws').mkdir(parents=True)
        (home / '.aws' / 'credentials').write_text('KEY', encoding='utf-8')
        (home / 'notes.md').write_text('# hi', encoding='utf-8')

        resp = await client.get(door, params={'path': str(home)})
        assert resp.status_code == 200, f'{door} -> {resp.status_code} {resp.text}'
        assert 'notes.md' in resp.text
        assert '.aws' not in resp.text
        assert 'credentials' not in resp.text

    @LIST_DOORS
    @pytest.mark.asyncio
    async def test_a_recursion_only_leak_is_still_closed(self, door, client, tmp_path):
        """A secret below the requested root must not be named either.

        Only the picker recurses, so this is where "we share the root guard" is
        not enough on its own: the per-entry rule has to be shared too. The
        tree door answers 200 with the store filtered out of its single level;
        the picker must not walk into it at depth 2.
        """
        proj = tmp_path / 'proj'
        (proj / 'src').mkdir(parents=True)
        (proj / 'src' / 'main.py').write_text('print()', encoding='utf-8')
        (proj / '.aws').mkdir()
        (proj / '.aws' / 'credentials').write_text('KEY', encoding='utf-8')

        resp = await client.get(door, params={'path': str(proj)})
        assert resp.status_code == 200, f'{door} -> {resp.status_code} {resp.text}'
        assert '.aws' not in resp.text
        assert 'credentials' not in resp.text

    @LIST_DOORS
    @pytest.mark.asyncio
    async def test_an_ordinary_directory_lists_in_both(self, door, client, tmp_path):
        good = tmp_path / 'ordinary'
        good.mkdir()
        # Top level, because the tree door lists one level and the picker
        # recurses — a nested file would pass one door and fail the other for
        # reasons that have nothing to do with the gate under test.
        (good / 'readme.md').write_text('# hi', encoding='utf-8')

        resp = await client.get(door, params={'path': str(good)})
        assert resp.status_code == 200, f'{door} -> {resp.status_code} {resp.text}'
        assert 'readme.md' in resp.text


class TestFolderlessSessionReadsHomeByDefault:
    """A folderless chat can use common personal files without opening every
    path on the machine. Extra roots and whole-computer access are explicit."""

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

    def test_unbound_reads_stay_in_home_without_configured_roots(
        self, tmp_path, monkeypatch, _set_security
    ):
        """An unconfigured folderless read is limited to the folderless area —
        the user's home PLUS the system temp directory the write gate already
        uses. The refusal case has to sit outside BOTH, so the temp root is
        pinned to its own empty directory here; without that the fixture's
        "outside-home" path would be inside the real `%TEMP%` and would read as
        allowed (which is the point of the paired test below)."""
        import tempfile
        from pathlib import Path

        _set_security('allowlist', [])
        home = tmp_path / 'home'
        home.mkdir()
        elsewhere = tmp_path / 'outside-home'
        elsewhere.mkdir()
        temp = tmp_path / 'system-temp'
        temp.mkdir()
        monkeypatch.setattr(Path, 'home', lambda: home)
        monkeypatch.setattr(tempfile, 'gettempdir', lambda: str(temp))

        path, err = bind_path(str(home / 'notes.txt'), None)
        assert err is None
        assert path == (home / 'notes.txt').resolve()
        denied, message = bind_path(str(elsewhere / 'private.txt'), None)
        assert denied is None
        assert message is not None and 'allowed roots' in message

    def test_folderless_temp_writes_remain_available_outside_home(
        self, tmp_path, monkeypatch, _set_security
    ):
        import tempfile
        from pathlib import Path

        _set_security('allowlist', [])
        home = tmp_path / 'home'
        temp = tmp_path / 'system-temp'
        home.mkdir()
        temp.mkdir()
        monkeypatch.setattr(Path, 'home', lambda: home)
        monkeypatch.setattr(tempfile, 'gettempdir', lambda: str(temp))

        path, err = bind_path(str(temp / 'scratch.txt'), None, for_write=True)
        assert err is None
        assert path == (temp / 'scratch.txt').resolve()

    def test_folderless_temp_reads_are_available_outside_home(
        self, tmp_path, monkeypatch, _set_security
    ):
        """The WRITE gate sends folderless work to the system temp directory, so
        the READ gate must be able to open that same directory — a session that
        writes a scratch file and then reads it back is the ordinary next step,
        and refusing it means the app can create what it cannot look at.

        Windows cannot see this bug: `%TEMP%` sits under the home directory, so
        the home rule already covered it. On the ubuntu runner `/tmp` is outside
        `$HOME`, and once the empty allowlist stopped being a no-op that is
        exactly where 29 tool tests came back as 'Sandbox blocked access outside
        your allowed roots' while the suite stayed green locally. Patching both
        `Path.home` and `tempfile.gettempdir` reproduces the Linux shape on any
        OS, which is the only reason this is now caught before a push."""
        import tempfile
        from pathlib import Path

        _set_security('allowlist', [])
        home = tmp_path / 'home'
        temp = tmp_path / 'system-temp'
        home.mkdir()
        temp.mkdir()
        (temp / 'scratch.txt').write_text('mine', encoding='utf-8')
        monkeypatch.setattr(Path, 'home', lambda: home)
        monkeypatch.setattr(tempfile, 'gettempdir', lambda: str(temp))

        path, err = bind_path(str(temp / 'scratch.txt'), None)
        assert err is None, err
        assert path == (temp / 'scratch.txt').resolve()

        # A write into temp that a read cannot follow used to be the asymmetry;
        # both halves of the folderless area are now one policy, and the same
        # path answers both directions.
        again, again_err = bind_path(str(temp / 'scratch.txt'), None, for_write=True)
        assert again_err is None and again == path

        # …and the tightened default keeps its teeth: neither home nor temp.
        elsewhere = tmp_path / 'outside-both'
        elsewhere.mkdir()
        refused, why = bind_path(str(elsewhere / 'private.txt'), None)
        assert refused is None
        assert why is not None and 'allowed roots' in why
