import asyncio
import json

import pytest
from app.services.workbench import providers as wp


def _fake_store(tmp_path, monkeypatch, models=('claude-sonnet-5',), default='m-default'):
    """Install a two-provider store so a qualified hint has something to hit."""
    store = {
        'providers': [
            {
                'id': 'zen-1',
                'name': 'Opencode Zen',
                'apiFormat': 'openaiChat',
                'baseUrl': 'https://zen.example/v1',
                'enabled': True,
                'defaultModel': default,
                'models': [{'id': m, 'name': m} for m in models],
            },
            {
                'id': 'other-2',
                'name': 'Other',
                'apiFormat': 'openaiChat',
                'baseUrl': 'https://other.example/v1',
                'enabled': True,
                'defaultModel': 'o-default',
                'models': [{'id': 'o-1', 'name': 'o-1'}],
            },
        ]
    }
    # Write a REAL store file rather than patching an accessor: the resolver
    # reads the store itself, and patching `config_service.getProvidersStore` in
    # my first version left it reading the ambient one — which is why the
    # provider-name case failed for reasons that had nothing to do with the code
    # under test.
    (tmp_path / 'providers.json').write_text(json.dumps(store), encoding='utf-8')
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(tmp_path / 'brain.sqlite'))
    return store


class TestQualifiedHintResolves:
    """A hint shaped `provider/model` used to fall through the resolver as a
    provider NAME, so the whole string survived as the model and was later
    handed to apiFormat normalization ("unknown apiFormat
    'opencode-zen-41527c/claude-sonnet-5'"). The reviewer then resolved to
    nothing at all."""

    def _client(self, monkeypatch, hint, seen):
        class FakeClient:
            def resolveApiKey(self):
                return 'k'

            async def chat_completions(self, body):
                seen['model'] = body['model']
                return type('R', (), {'body_json': {'choices': [{'message': {'content': 'KEEP'}}]}, 'is_error': False, 'status_code': 200})()

            async def close(self):
                pass

        monkeypatch.setattr('app.providers.clients.getClient', lambda p: (seen.setdefault('provider', p), FakeClient())[1])
        return wp.make_review_llm_client(None, hint)

    def test_a_qualified_hint_selects_that_provider_and_model(self, tmp_path, monkeypatch):
        _fake_store(tmp_path, monkeypatch)
        seen = {}
        fn = self._client(monkeypatch, 'other-2/o-1', seen)
        assert fn is not None, 'a qualified hint must resolve to a reviewer'
        assert seen['provider']['id'] == 'other-2', seen['provider']
        assert asyncio.run(fn([{'role': 'user', 'content': 'x'}])) == 'KEEP'
        # The model that reaches the wire is the model, not the whole hint.
        assert seen['model'] == 'o-1', seen['model']

    def test_a_qualified_hint_by_provider_name_also_works(self, tmp_path, monkeypatch):
        _fake_store(tmp_path, monkeypatch)
        seen = {}
        fn = self._client(monkeypatch, 'Opencode Zen/claude-sonnet-5', seen)
        assert fn is not None
        assert seen['provider']['name'] == 'Opencode Zen'
        # My first version asserted the model WITHOUT calling the closure, so it
        # failed on a missing dict key rather than on anything real.
        assert asyncio.run(fn([{'role': 'user', 'content': 'x'}])) == 'KEEP'
        assert seen['model'] == 'claude-sonnet-5', seen['model']

    def test_a_bare_model_name_still_resolves_as_before(self, tmp_path, monkeypatch):
        """No regression for the form every existing caller uses."""
        _fake_store(tmp_path, monkeypatch, models=('m-7',), default='m-7')
        seen = {}
        fn = self._client(monkeypatch, 'm-7', seen)
        assert fn is not None
        asyncio.run(fn([{'role': 'user', 'content': 'x'}]))
        assert seen['model'] == 'm-7'
        assert seen['provider']['id'] in ('zen-1', 'other-2')

    def test_a_qualified_hint_naming_an_unknown_provider_resolves_nothing(self, tmp_path, monkeypatch):
        """A typo must fail closed rather than silently reviewing with some
        other provider's default."""
        _fake_store(tmp_path, monkeypatch)
        seen = {}
        assert self._client(monkeypatch, 'no-such-provider/o-1', seen) is None
        assert seen == {}