"""Path segments that reach a filesystem join must be segments.

Two routes took a caller-supplied id, appended a suffix, and joined it onto a
data directory — trusting that the value was a single path segment.

  * `GET /api/observations/{obs_id}.png` — a `[^/]+` route segment rejects a
    forward slash, but a percent-encoded `%5C` DECODES to a backslash, which
    is a separator on Windows and reached the handler as real traversal. It
    escaped past `observations/` and past the data dir itself with one more
    `..`. The reach is narrow — the suffix is appended here, so only `*.png`
    is servable — but it was live.
  * `sessionId` / `checkpointId` reach `data/checkpoints/<sid>/<ck>/` with no
    validation at all, so a crafted id read a `manifest.json` from anywhere on
    disk.

Same shape, same fix: reject separators, then prove containment on the
RESOLVED path so a symlink cannot substitute for the check.
"""

from __future__ import annotations

import pytest
from app.main import app
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    """The repo has no shared `client` fixture — see test_camel_model_git.py."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


@pytest.fixture
def brain(isolatedData):
    from app.services.memory_store import init

    init()
    return isolatedData


class TestObservationsPngRoute:
    @pytest.mark.asyncio
    async def test_a_real_observation_is_served(self, client, isolatedData):
        """The control: the guard must not break the route it protects."""
        from pathlib import Path

        from app.lib.paths import dataPath

        obs = dataPath('observations')
        obs.mkdir(parents=True, exist_ok=True)
        (obs / 'obs_ok.png').write_bytes(b'\x89PNG\r\n\x1a\n' + b'real')

        resp = await client.get('/api/observations/obs_ok.png')
        assert resp.status_code == 200, resp.text
        assert resp.content.startswith(b'\x89PNG')
        assert Path(obs / 'obs_ok.png').is_file()

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        'obs_id',
        [
            r'..\secret',  # one level out
            r'..\..\secret',  # out of the data dir entirely
            '..\\..\\secret',
            'sub\\file',
            '..',
            '.',
            '',
        ],
    )
    async def test_traversal_shapes_are_refused(self, client, isolatedData, obs_id: str):
        resp = await client.get(f'/api/observations/{obs_id}.png')
        assert resp.status_code == 404, f'{obs_id!r} was not refused: {resp.status_code}'

    @pytest.mark.asyncio
    async def test_a_file_outside_the_data_dir_is_not_servable(self, client, isolatedData):
        """Prove the refusal is real, not a route that 404s for any input."""
        from pathlib import Path

        from app.lib.paths import dataPath

        secret = dataPath('secret.png')
        secret.write_bytes(b'\x89PNG\r\n\x1a\n' + b'NOT-FOR-SERVING')
        try:
            assert secret.is_file()
            resp = await client.get(r'/api/observations/..%5Csecret.png')
            assert resp.status_code == 404
            assert b'NOT-FOR-SERVING' not in resp.content
        finally:
            secret.unlink(missing_ok=True)


class TestCheckpointIdSegments:
    def test_a_manifest_outside_the_store_is_not_readable(self, brain, isolatedData):
        """`checkpointId` of `..\\..\\<dir>` used to walk out of the store.

        The re-validation added for manifest CONTENTS made this survivable,
        but the manifest LOCATION traversal was still open in the same file,
        and a planted manifest is a far better primitive than a refused one.
        """
        import json
        from pathlib import Path

        from app.services.workbench.checkpoint_service import get_checkpoint

        elsewhere = Path(str(isolatedData)) / 'planted'
        elsewhere.mkdir(parents=True, exist_ok=True)
        (elsewhere / 'manifest.json').write_text(
            json.dumps({'id': 'planted', 'files': []}), encoding='utf-8'
        )

        assert get_checkpoint('s1', r'..\..\planted') is None
        assert get_checkpoint(r'..\..', 'anything') is None

    def test_listing_an_unsafe_session_id_is_empty_not_an_error(self, brain, isolatedData):
        from app.services.workbench.checkpoint_service import list_checkpoints

        assert list_checkpoints(r'..\..') == []

    def test_pruning_an_unsafe_session_id_is_a_no_op(self, brain, isolatedData):
        from app.services.workbench.checkpoint_service import _prune_old

        # Must not raise, and must not touch anything outside the store.
        _prune_old(r'..\..\Windows')

    def test_restore_with_an_unsafe_id_reports_not_found(self, brain, isolatedData):
        from app.services.workbench.checkpoint_service import restore_checkpoint

        result = restore_checkpoint('s1', r'..\..\planted')
        assert result['ok'] is False
        assert result['error'] == 'Checkpoint not found'

    def test_a_legitimate_id_still_works(self, brain, isolatedData):
        """The control: real ids are single safe segments and must pass."""
        from pathlib import Path

        from app.services.workbench.checkpoint_service import (
            create_checkpoint,
            get_checkpoint,
            list_checkpoints,
            restore_checkpoint,
        )

        ws = Path(str(isolatedData)) / 'ws'
        ws.mkdir(exist_ok=True)
        f = ws / 'keep.txt'
        f.write_text('v1', encoding='utf-8')

        ck = create_checkpoint('s-ok_1', workspace_path=str(ws), paths=[str(f)], tool_name='write_file')
        assert ck is not None
        assert [e['path'] for e in ck['files']] == [str(f.resolve())], ck

        f.write_text('destroyed', encoding='utf-8')
        result = restore_checkpoint('s-ok_1', ck['id'])
        assert result['ok'] is True, result
        assert result['errors'] == [], result
        assert result['restored'] == 1, result
        assert f.read_text(encoding='utf-8') == 'v1'
