"""Roundtrip tests for the bulk memory import endpoint.

The endpoint (``POST /api/august/memory/import``) is the human-facing write
door for facts imported from another AI's memory export. These tests pin:
  * basic roundtrip of a JSON array of {key, value}
  * Claude-style {fact, details} flattening
  * per-row `source` preservation (`imported:claude` is stored verbatim)
  * rollback recorded for overwrite (so the user can restore)
  * malformed rows are reported in `failed`, not raised
"""

from __future__ import annotations

import pytest
from app.main import app
from app.services import memory_store
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    return TestClient(app)


def _list_facts_by_source(source: str) -> list[dict]:
    """Read back facts filtered by source (test helper, not used in prod)."""
    conn = memory_store._conn()
    rows = conn.execute(
        "SELECT * FROM facts WHERE source = ? ORDER BY fact_key", (source,)
    ).fetchall()
    return [dict(r) for r in rows]


def test_import_basic_roundtrip(client):
    body = {
        'items': [
            {'key': 'user-name', 'value': 'Sheesh', 'category': 'user'},
            {'key': 'work-context', 'value': 'August Proxy maintainer', 'category': 'project'},
        ],
        'defaultSource': 'imported:claude',
    }
    r = client.post('/api/august/memory/import', json=body)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data['ok'] is True
    assert data['count'] == 2
    assert data['total'] == 2
    assert data['failed'] == []
    assert {row['key'] for row in data['results']} == {'user-name', 'work-context'}
    assert all(row['source'] == 'imported:claude' for row in data['results'])

    persisted = _list_facts_by_source('imported:claude')
    assert {r['fact_key'] for r in persisted} == {'user-name', 'work-context'}


def test_import_claude_fact_details_shape(client):
    """Claude memory dumps use {fact, details}; the endpoint should flatten."""
    body = {
        'items': [
            {
                'key': 'claude-only',
                'value': {'fact': 'Lives in Dapitan', 'details': 'Zamboanga del Norte'},
            }
        ],
        'defaultCategory': 'user',
        'defaultSource': 'imported:claude',
    }
    r = client.post('/api/august/memory/import', json=body)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data['count'] == 1
    assert data['results'][0]['category'] == 'user'
    assert data['results'][0]['source'] == 'imported:claude'

    row = memory_store.get_fact('claude-only')
    assert row is not None
    # factValue is JSON-encoded text on the wire; decode for the assertion.
    import json as _json
    assert _json.loads(row['factValue']) == {
        'fact': 'Lives in Dapitan', 'details': 'Zamboanga del Norte',
    }
    assert row['source'] == 'imported:claude'


def test_import_invalid_category_falls_back_to_default(client):
    body = {
        'items': [
            {'key': 'weird-cat', 'value': 'x', 'category': 'not-a-real-category'},
        ],
        'defaultCategory': 'reference',
        'defaultSource': 'imported:chatgpt',
    }
    r = client.post('/api/august/memory/import', json=body)
    assert r.status_code == 200
    data = r.json()
    assert data['count'] == 1
    assert data['results'][0]['category'] == 'reference'
    assert data['results'][0]['source'] == 'imported:chatgpt'


def test_import_mixed_valid_and_invalid_rows(client):
    body = {
        'items': [
            {'key': 'good-1', 'value': 'ok'},
            {'key': '', 'value': 'no key'},  # bad: empty key
            {'value': 'no key field at all'},  # bad: missing key
            {'key': 'good-2', 'value': 42},  # numeric value is fine
            'not an object',  # bad: wrong type
        ],
        'defaultSource': 'imported:claude',
    }
    r = client.post('/api/august/memory/import', json=body)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data['count'] == 2
    assert data['total'] == 5
    assert len(data['failed']) == 3
    failed_indices = {f['index'] for f in data['failed']}
    assert failed_indices == {1, 2, 4}
    # The two good rows are present and have the source set.
    assert {row['key'] for row in data['results']} == {'good-1', 'good-2'}


def test_import_overwrite_records_rollback(client):
    # Seed a fact with a non-imported source.
    memory_store.save_fact('profile-name', 'Alice', category='user', source='user', confidence=0.9)
    # Re-import with `imported:claude` and updated value.
    body = {
        'items': [
            {'key': 'profile-name', 'value': 'Bob', 'category': 'user'},
        ],
        'defaultSource': 'imported:claude',
    }
    r = client.post('/api/august/memory/import', json=body)
    assert r.status_code == 200
    assert r.json()['count'] == 1

    row = memory_store.get_fact('profile-name')
    assert row is not None
    # factValue is JSON-encoded text on the wire.
    import json as _json
    assert _json.loads(row['factValue']) == 'Bob'
    # The source is now `imported:claude` — overwrite does not preserve the
    # original source (this matches the single-entry manage_memory contract).
    assert row['source'] == 'imported:claude'

    # A rollback entry should have been recorded for the pre-overwrite value.
    from app.services.rollback_store import list_entries

    entries = list_entries() or []
    matching = [e for e in entries if e.get('target') == 'profile-name']
    assert matching, entries
    assert all(e.get('type') == 'restore_memory_item' for e in matching)
    assert all(e.get('after') for e in matching)
