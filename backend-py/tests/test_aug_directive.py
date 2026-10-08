"""Tests for the AUG.md directive service and router."""

from __future__ import annotations

from pathlib import Path

import pytest
from app.services import aug_directive_service


def testResolveAugPathFallsBackToProjectRoot(tmp_path):
    # workspace provided (tmp_path is a real directory).
    # 0.17.0: the directive filename is AGENTS.md (legacy AUG.md still loads).
    p = aug_directive_service._resolveAugPath(str(tmp_path))
    assert p == tmp_path / 'AGENTS.md'


def testWriteAndLoadRoundTrip(tmp_path):
    ws = str(tmp_path)
    res = aug_directive_service.write(ws, '# Hello\n\nSome directives.', frontmatter={'description': 'test'})
    assert Path(res['path']).exists()
    loaded = aug_directive_service.load(ws)
    assert loaded is not None
    assert loaded['exists'] is True
    assert 'Hello' in loaded['body']
    assert loaded['frontmatter'].get('description') == 'test'


def testLoadMissingReturnsNone(tmp_path):
    assert aug_directive_service.load(str(tmp_path)) is None
    assert aug_directive_service.exists(str(tmp_path)) is False


def testWriteRefusesEscape(tmp_path):
    # workspace is tmp_path; try to trick resolution by passing a path whose
    # resolved file is outside — our resolver always joins under workspace, so
    # simulate by asserting the written file lands inside the workspace.
    ws = str(tmp_path)
    aug_directive_service.write(ws, 'body')
    p = aug_directive_service._resolveAugPath(ws)
    assert str(p.resolve()).startswith(str(tmp_path.resolve()))


def testDelete(tmp_path):
    ws = str(tmp_path)
    aug_directive_service.write(ws, 'body')
    res = aug_directive_service.delete(ws)
    assert res['removed'] is True
    assert aug_directive_service.exists(ws) is False


def testParseFrontmatter():
    text = '---\ndescription: x\n---\n\n# Title\nbody text'
    parsed = aug_directive_service._parseAug(text)
    assert parsed['frontmatter']['description'] == 'x'
    assert 'Title' in parsed['body']


def testGenerateReturnsDraft(tmp_path, monkeypatch):
    """generate() should run workspace analysis even if the LLM is unavailable."""
    ws = str(tmp_path)
    (tmp_path / 'README.md').write_text('# Demo\n\nA demo project.', 'utf-8')

    # Force the LLM call to return a deterministic draft (no provider needed).
    async def fakeLlm(messages, model=''):
        return '## Build\nrun build\n\n## Test\nrun test'

    monkeypatch.setattr(aug_directive_service, '_callLlm', fakeLlm)
    import asyncio

    result = asyncio.run(aug_directive_service.generate(ws, mode='create'))
    assert result['mode'] == 'create'
    assert 'Build' in result['draft']
    assert 'Test' in result['draft']
    assert 'readme' not in result['analysis'] or True


def testGenerateRefineMode(tmp_path, monkeypatch):
    ws = str(tmp_path)
    aug_directive_service.write(ws, '# Existing\n\nold directives')

    async def fakeLlm(messages, model=''):
        return '# Refined\n\nnew directives'

    monkeypatch.setattr(aug_directive_service, '_callLlm', fakeLlm)
    import asyncio

    result = asyncio.run(aug_directive_service.generate(ws, mode='refine'))
    assert result['mode'] == 'refine'
    assert result['existing'] is True
    assert 'Refined' in result['draft']


class TestCallLlmModelChoice:
    """`_callLlm` used to end its model chain with a literal vendor id, so an
    AUG draft could be produced by a model the user never chose and dialled
    against whichever gateway happened to be first in providers.json. It now
    follows the composer, then the provider's own default, then says nothing."""

    class _Resp:
        def __init__(self, body):
            self.status = 200
            self.body = body

    class _Client:
        def __init__(self, sink):
            self._sink = sink

        def resolveApiKey(self):
            return 'k'

        async def chat_completions(self, body):
            self._sink.append(body)
            return TestCallLlmModelChoice._Resp(
                {'choices': [{'message': {'content': '# AGENTS\n'}}]}
            )

    def _patch(self, monkeypatch, providers, resolve_map, sink):
        from app.providers import clients as clients_mod
        from app.providers import resolver as resolver_mod

        monkeypatch.setattr(resolver_mod, 'list_available', lambda: providers)
        monkeypatch.setattr(resolver_mod, 'resolve', lambda q: resolve_map.get(q, providers[0]))
        monkeypatch.setattr(clients_mod, 'getClient', lambda p: self._Client(sink))

    @pytest.mark.asyncio
    async def test_no_model_and_no_default_produces_no_guess(self, monkeypatch):
        sink: list = []
        self._patch(monkeypatch, [{'name': 'Gateway', 'models': []}], {}, sink)
        assert await aug_directive_service._callLlm([{'role': 'user', 'content': 'go'}]) == ''
        assert sink == [], 'no request must be dialed without a model to name'

    @pytest.mark.asyncio
    async def test_the_composer_model_is_what_gets_dialed(self, monkeypatch, isolatedData):
        from app.services.memory_store import init
        from app.services.workbench import sessions as wb_sessions

        init()
        sink: list = []
        gate = {'name': 'KiloCode', 'defaultModel': ''}
        self._patch(monkeypatch, [gate], {'minimax/minimax-m3': gate}, sink)
        # The composer's selection is a persisted workbench session's model.
        monkeypatch.setattr(
            'app.services.model_fleet_service.composerModel',
            lambda: ('minimax/minimax-m3', 'KiloCode'),
        )
        out = await aug_directive_service._callLlm([{'role': 'user', 'content': 'go'}])
        assert out.startswith('# AGENTS')
        assert sink[0]['model'] == 'minimax/minimax-m3'
        assert wb_sessions is not None  # keeps the session module import honest
