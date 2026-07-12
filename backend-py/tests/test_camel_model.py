"""Characterization tests for the CamelModel camelCase JSON boundary.

These prove the core invariant of Phase 2 naming conversion: internal
attributes are snake_case, but JSON serialized with ``by_alias=True``
(and accepted on input) is camelCase. This is independent of the rest of
the naming conversion.
"""
from __future__ import annotations

from app.routers.models import ModelInfo, ModelList


def test_response_serializes_camelcase():
    model = ModelInfo(
        context_window=200000,
        display_name='Sonnet',
        id='claude-3-5-sonnet',
    )
    dumped = model.model_dump(by_alias=True)
    assert dumped['contextWindow'] == 200000
    assert dumped['displayName'] == 'Sonnet'


def test_request_accepts_camelcase_input():
    payload = {'contextWindow': 200000, 'displayName': 'Sonnet', 'id': 'x'}
    model = ModelInfo(**payload)
    assert model.context_window == 200000
    assert model.display_name == 'Sonnet'


def test_model_list_preserves_camelcase_keys():
    sample = {
        'id': 'm1',
        'contextWindow': 128000,
        'displayName': 'M',
        'provider': 'p',
    }
    listing = ModelList(
        models=[ModelInfo(**sample)],
        has_more=False,
        total=1,
    )
    data = listing.model_dump(by_alias=True)
    assert data['models'][0]['contextWindow'] == 128000
    assert data['hasMore'] is False
    assert data['total'] == 1


def test_extra_fields_preserved():
    model = ModelInfo(**{'id': 'x', 'customField': 'y'})
    assert model.model_dump(by_alias=True)['customField'] == 'y'
