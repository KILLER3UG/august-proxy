"""Checkpoint paths must pass the same gate the file tools pass.

`create_checkpoint_for_tool` runs BEFORE the file tool is dispatched, on the
raw `toolInput` path — so `write_file(path="C:\\Users\\<u>\\.ssh\\id_rsa")`
was correctly refused downstream while `shutil.copy2` had already staged the
private key under `data/checkpoints/` with its absolute path in
`manifest.json`. The write was blocked; the exfiltration was not.

`restore_checkpoint` is the mirror: it wrote with `copy2` and deleted with
`unlink()` straight from `Path(entry['path'])`, and a manifest is a file on
disk. These tests pin both directions, and pin that the ordinary
in-workspace save point still works.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from app.services.workbench.checkpoint_service import (
    create_checkpoint,
    create_checkpoint_for_tool,
    restore_checkpoint,
)


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


@pytest.fixture
def data_dir(isolatedData) -> Path:
    """The data dir as a Path — `isolatedData` is what checkpoints live under."""
    return Path(str(isolatedData))


@pytest.fixture
def ws(data_dir) -> Path:
    """A bound workspace. Sibling of `checkpoints/`, NOT inside it."""
    root = data_dir / 'ws'
    root.mkdir(exist_ok=True)
    return root


@pytest.fixture
def live_session(ws):
    """A real workbench session rooted at `ws`.

    `restore_checkpoint` now takes its containment root from the LIVE session
    rather than from the manifest — a manifest is a file an attacker can
    plant, so its `workspacePath` is a claim about the past, not an authority
    (verified: a planted manifest could otherwise redirect a restore to an
    arbitrary directory, for both write and delete). So a restore test has to
    have a session to contain against, exactly as production does.
    """
    from app.services.workbench.sessions import create_workbench_session

    return create_workbench_session(goal='checkpoint guard', workspacePath=str(ws))


def _staged_blobs(data_dir: Path) -> list[bytes]:
    """Every file body staged under the checkpoint store, for leak assertions."""
    store = data_dir / 'checkpoints'
    if not store.is_dir():
        return []
    return [p.read_bytes() for p in store.rglob('*') if p.is_file()]


def _rewrite_manifest(data_dir: Path, session_id: str, ck_id: str, **overrides) -> None:
    """Edit a manifest in place — the threat model is that it is a file on disk."""
    man = data_dir / 'checkpoints' / session_id / ck_id / 'manifest.json'
    data = json.loads(man.read_text(encoding='utf-8'))
    data.update(overrides)
    man.write_text(json.dumps(data, indent=2), encoding='utf-8')


class TestHardlineRefusedAtCreate:
    """A credential path is not save-point material in any mode, Full Access included."""

    def test_ssh_private_key_inside_the_workspace_is_not_copied(self, brain, data_dir, ws):
        # Placed INSIDE the workspace so only the hardline guard can catch it —
        # containment would pass and the test would prove nothing.
        ssh = ws / '.ssh'
        ssh.mkdir()
        key = ssh / 'id_rsa'
        key.write_text('-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEY\n', encoding='utf-8')

        ck = create_checkpoint_for_tool('s1', str(ws), 'write_file', {'path': str(key)})

        assert ck is not None, 'a checkpoint record is still written — just with no file'
        assert ck['files'] == []
        assert all(b'SECRETKEY' not in blob for blob in _staged_blobs(data_dir))

    def test_providers_store_inside_the_workspace_is_not_copied(self, brain, data_dir, ws):
        providers = ws / 'providers.json'
        providers.write_text('{"apiKey": "sk-live-SECRET"}', encoding='utf-8')

        ck = create_checkpoint_for_tool('s2', str(ws), 'write_file', {'path': str(providers)})

        assert ck is not None
        assert ck['files'] == []
        assert all(b'sk-live' not in blob for blob in _staged_blobs(data_dir))

    def test_credential_outside_the_workspace_is_not_copied(self, brain, data_dir, ws):
        """The originally-reported path: a home-directory key, never in the workspace."""
        key = data_dir / 'home' / '.ssh' / 'id_rsa'
        key.parent.mkdir(parents=True, exist_ok=True)
        key.write_text('-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEY\n', encoding='utf-8')

        ck = create_checkpoint_for_tool('s3', str(ws), 'write_file', {'path': str(key)})

        assert ck is not None
        assert ck['files'] == []
        assert all(b'SECRETKEY' not in blob for blob in _staged_blobs(data_dir))

    def test_a_pem_outside_the_workspace_is_not_copied(self, brain, data_dir, ws):
        """Catches the read-mode half: `.pem` is a credential READ rule, not a write rule.

        The write tool would refuse this path too, but the checkpoint has
        already copied the bytes into the data dir by then — which is the
        whole point of checking the read mode here.
        """
        pem = data_dir / 'Documents' / 'bank.key'
        pem.parent.mkdir(parents=True, exist_ok=True)
        pem.write_text('-----BEGIN PRIVATE KEY-----\nPEMSECRET\n', encoding='utf-8')

        ck = create_checkpoint_for_tool('s3b', str(ws), 'write_file', {'path': str(pem)})

        assert ck is not None
        assert ck['files'] == []
        assert all(b'PEMSECRET' not in blob for blob in _staged_blobs(data_dir))


class TestContainmentRefusedAtCreate:
    def test_absolute_path_outside_the_workspace_is_not_copied(self, brain, data_dir, ws):
        """The old escape hatch: 'allow it if it exists and is a file'.

        This file exists and is not a credential, so nothing but the
        containment check stops it.
        """
        outside = data_dir / 'outside.txt'
        outside.write_text('outside-secret', encoding='utf-8')

        ck = create_checkpoint_for_tool('s4', str(ws), 'write_file', {'path': str(outside)})

        assert ck is not None
        assert ck['files'] == []
        assert all(b'outside-secret' not in blob for blob in _staged_blobs(data_dir))

    def test_relative_traversal_out_of_the_workspace_is_not_copied(self, brain, data_dir, ws):
        escaped = data_dir / 'escaped.txt'
        escaped.write_text('escaped-secret', encoding='utf-8')

        ck = create_checkpoint_for_tool('s5', str(ws), 'write_file', {'path': '../escaped.txt'})

        assert ck is not None
        assert ck['files'] == []
        assert all(b'escaped-secret' not in blob for blob in _staged_blobs(data_dir))

    def test_relative_path_that_cancels_back_inside_is_still_allowed(self, brain, ws):
        """The control for the test above: `sub/../x.txt` lands back under the
        workspace, so containment must NOT refuse it — this pins that the
        check is containment and not a blunt 'no dots' rule."""
        (ws / 'ok.txt').write_text('fine', encoding='utf-8')
        (ws / 'sub').mkdir(exist_ok=True)

        ck = create_checkpoint_for_tool('s5b', str(ws), 'write_file', {'path': 'sub/../ok.txt'})

        assert ck is not None
        assert [e['path'] for e in ck['files']] == [str((ws / 'ok.txt').resolve())]

    def test_no_workspace_bounds_the_path_to_the_temp_area(self, brain, data_dir):
        """No workspace means no containment anchor, so only `bind_path`'s
        workspace-less WRITE rule — the system temp area — is left. The drive
        root is outside it on every platform, and the file is never created."""
        probe = Path(data_dir.anchor) / 'august_no_workspace_probe.txt'

        ck = create_checkpoint_for_tool('s6', '', 'write_file', {'path': str(probe)})

        assert ck is not None
        assert ck['files'] == []
        assert not probe.exists()


class TestNormalPathStillWorks:
    def test_in_workspace_file_is_snapshotted_and_restored(self, brain, ws, live_session):
        f = ws / 'hello.txt'
        f.write_text('v1', encoding='utf-8')

        ck = create_checkpoint(live_session.id, workspace_path=str(ws), paths=[str(f)], tool_name='write_file')
        assert ck is not None
        assert [e['path'] for e in ck['files']] == [str(f.resolve())]

        f.write_text('v2-destroyed', encoding='utf-8')
        result = restore_checkpoint(live_session.id, ck['id'])
        assert result['ok'] is True
        assert result['restored'] == 1
        assert result['errors'] == []
        assert f.read_text(encoding='utf-8') == 'v1'

    def test_relative_path_resolves_under_the_workspace(self, brain, ws):
        (ws / 'notes.md').write_text('notes', encoding='utf-8')

        ck = create_checkpoint('s8', workspace_path=str(ws), paths=['notes.md'], tool_name='write_file')
        assert ck is not None
        assert ck['files'][0]['path'] == str((ws / 'notes.md').resolve())

    def test_nested_workspace_path_round_trips(self, brain, ws, live_session):
        nested = ws / 'src' / 'deep'
        nested.mkdir(parents=True)
        f = nested / 'mod.py'
        f.write_text('x = 1', encoding='utf-8')

        ck = create_checkpoint(live_session.id, workspace_path=str(ws), paths=['src/deep/mod.py'], tool_name='write_file')
        assert ck is not None
        f.write_text('x = 999', encoding='utf-8')
        restore_checkpoint(live_session.id, ck['id'])
        assert f.read_text(encoding='utf-8') == 'x = 1'

    def test_new_file_is_tracked_and_deleted_on_restore(self, brain, ws, live_session):
        newf = ws / 'brand_new.txt'
        ck = create_checkpoint(live_session.id, workspace_path=str(ws), paths=[str(newf)], tool_name='write_file')
        assert ck is not None
        assert ck['files'][0]['existed'] is False

        newf.write_text('created after', encoding='utf-8')
        result = restore_checkpoint(live_session.id, ck['id'])
        assert result['ok'] is True
        assert result['deleted'] == 1
        assert not newf.exists()


class TestManifestCannotWidenItsOwnContainment:
    """F4: ``workspacePath`` was the field the ``rel`` fix forgot.

    The manifest is a file an attacker can plant, so its ``workspacePath`` is
    a claim about the past -- but it was being used as the containment ROOT,
    so a planted manifest naming a victim directory moved containment with it
    and both the write branch and the delete branch then operated outside the
    workspace. Verified for both. The root is now the LIVE session's
    workspace, which lives outside any directory a manifest can reach.
    """

    def test_a_planted_workspace_cannot_redirect_a_write(
        self, brain, data_dir, ws, live_session
    ):
        victim = data_dir / 'victim'
        victim.mkdir(parents=True, exist_ok=True)
        loot = victim / 'loot.txt'
        loot.write_text('ORIGINAL', encoding='utf-8')

        target = ws / 'a.txt'
        target.write_text('v1', encoding='utf-8')
        ck = create_checkpoint(
            live_session.id, workspace_path=str(ws), paths=[str(target)], tool_name='write_file'
        )
        assert ck is not None
        _rewrite_manifest(
            data_dir,
            live_session.id,
            ck['id'],
            workspacePath=str(victim),  # the planted root
            files=[{'path': str(loot), 'rel': 'a.txt', 'existed': True, 'size': 0}],
        )

        restore_checkpoint(live_session.id, ck['id'])

        assert loot.read_text(encoding='utf-8') == 'ORIGINAL', (
            'a planted manifest workspacePath redirected a write outside the workspace'
        )

    def test_a_planted_workspace_cannot_redirect_a_delete(
        self, brain, data_dir, ws, live_session
    ):
        victim = data_dir / 'victim2'
        victim.mkdir(parents=True, exist_ok=True)
        secret = victim / 'secret.txt'
        secret.write_text('KEEP', encoding='utf-8')

        target = ws / 'b.txt'
        ck = create_checkpoint(
            live_session.id, workspace_path=str(ws), paths=[str(target)], tool_name='write_file'
        )
        assert ck is not None
        _rewrite_manifest(
            data_dir,
            live_session.id,
            ck['id'],
            workspacePath=str(victim),
            files=[{'path': str(secret), 'rel': 'b.txt', 'existed': False, 'size': 0}],
        )

        result = restore_checkpoint(live_session.id, ck['id'])

        assert secret.exists(), 'a planted manifest deleted a file outside the workspace'
        assert result['deleted'] == 0

    def test_a_restore_with_no_live_session_refuses(self, brain, data_dir, ws, live_session):
        """No live session means nothing to contain against.

        Falling back to the manifest's own claim is exactly the bug, so the
        refusal is the point: a checkpoint for a session that no longer exists
        cannot be shown to land anywhere safe.
        """
        target = ws / 'c.txt'
        target.write_text('v1', encoding='utf-8')
        ck = create_checkpoint(
            live_session.id, workspace_path=str(ws), paths=[str(target)], tool_name='write_file'
        )
        assert ck is not None
        from app.services.workbench import sessions as sessions_mod

        sessions_mod._sessions.pop(live_session.id, None)
        result = restore_checkpoint(live_session.id, ck['id'])
        assert result['ok'] is False
        assert 'contain' in result['error'].lower()


class TestRestoreRevalidatesManifest:
    """A manifest is a file on disk — it is not trusted on the way out."""

    def test_planted_hardline_path_is_neither_written_nor_deleted(self, brain, data_dir, ws, live_session):
        key = ws / '.ssh' / 'id_rsa'
        key.parent.mkdir(exist_ok=True)
        key.write_text('REAL-KEY', encoding='utf-8')

        ck = create_checkpoint(live_session.id, workspace_path=str(ws), paths=[str(ws / 'a.txt')], tool_name='write_file')
        assert ck is not None
        # A restore would `copy2` over this key (existed=True) or `unlink` it
        # (existed=False). Both are refused, and the real file is untouched.
        _rewrite_manifest(
            data_dir,
            live_session.id,
            ck['id'],
            files=[
                {'path': str(key), 'rel': 'a.txt', 'existed': False, 'size': 0},
                {'path': str(key), 'rel': 'a.txt', 'existed': True, 'size': 0},
            ],
        )

        result = restore_checkpoint(live_session.id, ck['id'])

        assert key.read_text(encoding='utf-8') == 'REAL-KEY', 'restore damaged a protected key'
        assert result['deleted'] == 0
        assert result['restored'] == 0
        assert len(result['errors']) == 2

    def test_planted_path_outside_the_workspace_is_not_deleted(self, brain, data_dir, ws, live_session):
        outside = data_dir / 'outside.txt'
        outside.write_text('untouched', encoding='utf-8')

        ck = create_checkpoint(live_session.id, workspace_path=str(ws), paths=[str(ws / 'a.txt')], tool_name='write_file')
        assert ck is not None
        _rewrite_manifest(
            data_dir,
            live_session.id,
            ck['id'],
            files=[{'path': str(outside), 'rel': 'a.txt', 'existed': False, 'size': 0}],
        )

        result = restore_checkpoint(live_session.id, ck['id'])

        assert outside.exists(), 'restore deleted a file outside the workspace'
        assert outside.read_text(encoding='utf-8') == 'untouched'
        assert result['deleted'] == 0

    def test_widening_the_manifest_workspace_does_not_reach_a_hardline_path(self, brain, data_dir, ws, live_session):
        """`workspacePath` is manifest data too, so widening it must not widen reach.

        The hardline guard is deliberately independent of the anchor: a
        manifest that names a directory containing the key still cannot have
        it written or deleted.
        """
        key = data_dir / 'loose' / 'id_rsa'
        key.parent.mkdir(parents=True, exist_ok=True)
        key.write_text('REAL-KEY', encoding='utf-8')

        ck = create_checkpoint(live_session.id, workspace_path=str(ws), paths=[str(ws / 'a.txt')], tool_name='write_file')
        assert ck is not None
        _rewrite_manifest(
            data_dir,
            live_session.id,
            ck['id'],
            workspacePath=str(data_dir),  # the whole data dir, not `ws`
            files=[{'path': str(key), 'rel': 'a.txt', 'existed': False, 'size': 0}],
        )

        result = restore_checkpoint(live_session.id, ck['id'])

        assert key.exists(), 'a widened workspacePath reached a hardline path'
        assert result['deleted'] == 0

    def test_absolute_rel_cannot_redirect_the_snapshot_copy(self, brain, data_dir, ws):
        """`rel` is manifest data: an absolute value escapes the `files/` dir.

        Joined as `files_dir / rel`, an absolute `rel` REPLACES the whole
        path — the restore would copy any readable file on the machine into
        the workspace, past every check that was done on the target.
        """
        loot = data_dir / 'elsewhere' / 'loot.txt'
        loot.parent.mkdir(parents=True, exist_ok=True)
        loot.write_text('planted-payload', encoding='utf-8')

        target = ws / 'target.txt'
        target.write_text('original', encoding='utf-8')

        ck = create_checkpoint('s13', workspace_path=str(ws), paths=[str(target)], tool_name='write_file')
        assert ck is not None
        _rewrite_manifest(
            data_dir,
            's13',
            ck['id'],
            files=[{'path': str(target), 'rel': str(loot), 'existed': True, 'size': 0}],
        )

        restore_checkpoint('s13', ck['id'])

        assert target.read_text(encoding='utf-8') == 'original', 'restore copied from outside files/'

    def test_climbing_rel_cannot_redirect_the_snapshot_copy(self, brain, data_dir, ws):
        """The same door via `..` — `rel.replace('..','_')` handles the literal
        form, so this pins the containment check as the backstop."""
        loot = data_dir / 'elsewhere' / 'loot2.txt'
        loot.parent.mkdir(parents=True, exist_ok=True)
        loot.write_text('planted-payload-2', encoding='utf-8')

        target = ws / 'target2.txt'
        target.write_text('original2', encoding='utf-8')

        ck = create_checkpoint('s14', workspace_path=str(ws), paths=[str(target)], tool_name='write_file')
        assert ck is not None
        _rewrite_manifest(
            data_dir,
            's14',
            ck['id'],
            files=[{'path': str(target), 'rel': '../../elsewhere/loot2.txt', 'existed': True, 'size': 0}],
        )

        restore_checkpoint('s14', ck['id'])

        assert target.read_text(encoding='utf-8') == 'original2'
