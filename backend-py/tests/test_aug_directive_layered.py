"""T6 layered AGENTS.md (plan §9.4) — global → git-root→cwd walk,
AGENTS.override.md wins, 32 KiB cap dropping least-specific first."""

from __future__ import annotations

import pytest
from app.services import aug_directive_service as svc


@pytest.fixture
def fakeGlobal(tmp_path, monkeypatch):
    """Point the global layer at a tmp data dir."""
    globalDir = tmp_path / 'global-data'
    globalDir.mkdir()

    def fakeDataPath(*parts: str):
        return globalDir.joinpath(*parts)

    monkeypatch.setattr('app.lib.paths.dataPath', fakeDataPath)
    return globalDir


class TestLayeredLoad:
    def testWalksFromGitRootToWorkspace(self, tmp_path, fakeGlobal):
        root = tmp_path / 'repo'
        nested = root / 'packages' / 'app'
        nested.mkdir(parents=True)
        (root / '.git').mkdir()
        (root / 'AGENTS.md').write_text('# Root rules\nUse uv.', encoding='utf-8')
        (nested / 'AGENTS.md').write_text('# App rules\nRun vitest.', encoding='utf-8')

        loaded = svc.load_layered(str(nested))
        assert loaded is not None
        body = loaded['body']
        assert body.index('Root rules') < body.index('App rules')  # least-specific first
        scopes = [layer['scope'] for layer in loaded['layers']]
        assert scopes == ['tree', 'workspace']
        assert loaded['truncated'] is False

    def testOverrideWinsAtItsLevel(self, tmp_path, fakeGlobal):
        root = tmp_path / 'repo'
        root.mkdir()
        (root / '.git').mkdir()
        (root / 'AGENTS.md').write_text('regular instructions', encoding='utf-8')
        (root / 'AGENTS.override.md').write_text('OVERRIDE instructions', encoding='utf-8')

        loaded = svc.load_layered(str(root))
        assert loaded is not None
        assert 'OVERRIDE instructions' in loaded['body']
        assert 'regular instructions' not in loaded['body']
        assert len(loaded['layers']) == 1

    def testGlobalLayerComesFirst(self, tmp_path, fakeGlobal):
        (fakeGlobal / 'AGENTS.md').write_text('global: always reply in English', encoding='utf-8')
        ws = tmp_path / 'ws'
        ws.mkdir()
        (ws / 'AGENTS.md').write_text('workspace: use tabs', encoding='utf-8')

        loaded = svc.load_layered(str(ws))
        assert loaded is not None
        body = loaded['body']
        assert body.index('global:') < body.index('workspace:')
        assert [layer['scope'] for layer in loaded['layers']] == ['global', 'workspace']

    def testNoLayersReturnsNone(self, tmp_path, fakeGlobal):
        ws = tmp_path / 'empty-ws'
        ws.mkdir()
        assert svc.load_layered(str(ws)) is None

    def testCapDropsLeastSpecificLayersFirst(self, tmp_path, fakeGlobal):
        (fakeGlobal / 'AGENTS.md').write_text('G' * 20_000, encoding='utf-8')
        root = tmp_path / 'repo'
        root.mkdir()
        (root / '.git').mkdir()
        (root / 'AGENTS.md').write_text('R' * 20_000, encoding='utf-8')
        (root / 'AGENTS.override.md').write_text('', encoding='utf-8')  # empty → ignored
        ws = root / 'deep'
        ws.mkdir()
        (ws / 'AGENTS.md').write_text('W' * 20_000, encoding='utf-8')

        loaded = svc.load_layered(str(ws))
        assert loaded is not None
        # 60 KB across 3 layers → global dropped, then root dropped.
        assert 'W' * 100 in loaded['body']
        assert 'G' not in loaded['body']
        assert 'R' not in loaded['body']
        assert loaded['truncated'] is True

    def testSingleOversizedLayerHardTruncatesWithMarker(self, tmp_path, fakeGlobal):
        ws = tmp_path / 'big-ws'
        ws.mkdir()
        (ws / 'AGENTS.md').write_text('X' * 40_000, encoding='utf-8')

        loaded = svc.load_layered(str(ws))
        assert loaded is not None
        assert loaded['truncated'] is True
        assert '[... directive truncated at 32 KiB]' in loaded['body']
        assert len(loaded['body'].encode('utf-8')) <= 32 * 1024 + 100

    def testFrontmatterStrippedFromEveryLayer(self, tmp_path, fakeGlobal):
        ws = tmp_path / 'fm-ws'
        ws.mkdir()
        (ws / 'AGENTS.md').write_text(
            '---\ndescription: project rules\n---\nthe actual body', encoding='utf-8'
        )
        loaded = svc.load_layered(str(ws))
        assert loaded is not None
        assert loaded['body'] == 'the actual body'
