"""GET/PUT /api/config/model-params — editing the wire capability families.

``app/providers/model_params.py`` reads operator families from
``config.json:modelParams.families`` and ``docs/CONFIGURATION.md`` documents
the section, but nothing in the app could write it, so teaching August about a
new gateway meant hand-editing a file and restarting. These tests pin the two
things that make the endpoint actually work rather than merely persist bytes:

* a saved family changes the answer for the *running* process (the write has to
  land through ``settings.reload()``, because model_params caches against the
  identity of the config dict), and
* a rejected write changes nothing at all.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

NEW_FAMILY = {
    'id': 'vectorgen',
    'tokens': ['vg-4', 'vector-pro'],
    'reasoningEffort': True,
    'extendedThinking': False,
}


def _client() -> TestClient:
    from app.main import app

    return TestClient(app)


def _operator(client: TestClient) -> list[dict]:
    return list(client.get('/api/config/model-params').json()['operator'])


def test_put_makes_the_family_live_in_this_process(isolatedData):
    client = _client()
    assert _operator(client) == []

    from app.providers.model_params import accepts_reasoning_effort

    assert accepts_reasoning_effort('vg-4-mini') is False

    resp = client.put('/api/config/model-params', json={'families': [NEW_FAMILY]})
    assert resp.status_code == 200, resp.text
    assert [f['id'] for f in resp.json()['operator']] == ['vectorgen']

    # The decision the harness acts on, not just the stored row.
    assert accepts_reasoning_effort('vg-4-mini') is True
    assert accepts_reasoning_effort('unrelated-model') is False


def test_builtin_table_is_reported_alongside(isolatedData):
    client = _client()
    body = client.get('/api/config/model-params').json()

    assert body['operator'] == []
    ids = {f['id'] for f in body['builtin']}
    assert {'openai-reasoning', 'deepseek', 'claude-extended-thinking'} <= ids
    assert body['builtin'], 'the fallback table is what makes the UI informative'
    # Built-ins are read-only: they carry no source the editor writes back.
    assert all(f['source'] == 'builtin' for f in body['builtin'])


def test_an_operator_entry_wins_over_a_builtin_of_the_same_id(isolatedData):
    client = _client()
    override = {
        'id': 'deepseek',
        'tokens': ['deepseek'],
        'reasoningEffort': False,
        'excludes': ['reasoner'],
    }
    assert client.put('/api/config/model-params', json={'families': [override]}).status_code == 200

    from app.providers import model_params

    spec = model_params.family_for('deepseek-chat')
    assert spec is not None and spec.source == 'config'
    assert model_params.accepts_reasoning_effort('deepseek-chat') is False
    assert model_params.accepts_reasoning_effort('deepseek-reasoner') is False


def test_one_bad_entry_rejects_the_whole_write(isolatedData):
    client = _client()
    bad = {'id': 'no-tokens'}  # tokens are what a family matches on
    resp = client.put(
        '/api/config/model-params',
        json={'families': [NEW_FAMILY, bad]},
    )
    assert resp.status_code == 400, resp.text
    detail = resp.json()['detail']
    assert detail['code'] == 'validation'
    assert 'family #1' in detail['message']

    # Nothing partial landed — including the entry that was valid.
    assert _operator(client) == []
    from app.providers.model_params import accepts_reasoning_effort

    assert accepts_reasoning_effort('vg-4-mini') is False


def test_valid_effort_tiers_are_accepted_and_stored(isolatedData):
    client = _client()
    entry = {**NEW_FAMILY, 'defaultEffort': 'medium', 'maxEffort': 'high'}
    assert client.put('/api/config/model-params', json={'families': [entry]}).status_code == 200

    stored = _operator(client)[0]
    assert stored['defaultEffort'] == 'medium'
    assert stored['maxEffort'] == 'high'

    from app.providers.model_params import family_for

    spec = family_for('vg-4-mini')
    assert spec is not None and spec.default_effort == 'medium' and spec.max_effort == 'high'


def test_a_bad_effort_tier_is_rejected(isolatedData):
    client = _client()
    resp = client.put(
        '/api/config/model-params',
        json={'families': [{**NEW_FAMILY, 'maxEffort': 'ultra'}]},
    )
    assert resp.status_code == 400
    assert _operator(client) == []


def test_empty_list_clears_overrides_without_losing_builtins(isolatedData):
    client = _client()
    client.put('/api/config/model-params', json={'families': [NEW_FAMILY]})
    assert len(_operator(client)) == 1

    resp = client.put('/api/config/model-params', json={'families': []})
    assert resp.status_code == 200
    assert _operator(client) == []
    body = resp.json()
    assert body['builtin'], 'clearing overrides must not clear the fallback table'
    from app.providers.model_params import accepts_reasoning_effort

    assert accepts_reasoning_effort('deepseek-reasoner') is True


def test_non_list_body_is_rejected(isolatedData):
    client = _client()
    resp = client.put('/api/config/model-params', json={'families': 'deepseek'})
    assert resp.status_code == 400
    assert _operator(client) == []


def test_resolve_names_the_answering_family(isolatedData):
    client = _client()
    built_in = client.get(
        '/api/config/model-params/resolve', params={'modelId': 'deepseek-reasoner'}
    ).json()
    assert built_in['family']['id'] == 'deepseek'
    assert built_in['family']['source'] == 'builtin'
    assert built_in['reasoningEffort'] is True
    assert built_in['extendedThinking'] is False

    entry = {**NEW_FAMILY, 'defaultEffort': 'high'}
    client.put('/api/config/model-params', json={'families': [entry]})
    resolved = client.get(
        '/api/config/model-params/resolve', params={'modelId': 'vg-4-mini'}
    ).json()
    assert resolved['family']['id'] == 'vectorgen'
    assert resolved['family']['source'] == 'config'
    assert resolved['defaultEffort'] == 'high'


def test_resolve_reports_the_absence_a_model_suffers(isolatedData):
    """The point of the endpoint: "no family matched", not a silent no."""
    client = _client()
    body = client.get(
        '/api/config/model-params/resolve', params={'modelId': 'plain-llama-3'}
    ).json()
    assert body['family'] is None
    assert body['reasoningEffort'] is False
    assert body['extendedThinking'] is False
    assert body['defaultEffort'] is None

    assert client.get('/api/config/model-params/resolve').json()['family'] is None
