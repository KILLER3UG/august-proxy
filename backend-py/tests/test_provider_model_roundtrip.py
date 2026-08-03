"""Reasoning-effort metadata must round-trip through the provider read path."""

from __future__ import annotations

import json

import pytest


@pytest.fixture()
def store_with_model(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.services import config_service

    config_service.saveProvidersStore(
        {
            'providers': [
                {
                    'id': 'p1',
                    'name': 'P1',
                    'apiFormat': 'openaiChat',
                    'baseUrl': 'https://example.com/v1',
                    'enabled': True,
                    'models': [
                        {
                            'id': 'reasoner-1',
                            'name': 'reasoner-1',
                            'contextWindow': 128000,
                            'source': 'manual',
                            'supportsReasoningEffort': True,
                            'maxReasoningEffort': 'medium',
                        }
                    ],
                }
            ]
        }
    )
    return tmp_path


def test_config_service_preserves_reasoning_fields(store_with_model):
    from app.services import config_service

    providers = config_service.getProvidersAsModels()
    assert len(providers) == 1
    model = providers[0].models[0]
    assert model.supports_reasoning_effort is True
    assert model.max_reasoning_effort == 'medium'


def test_provider_to_dict_emits_reasoning_fields(store_with_model):
    from app.routers.providers import _provider_to_dict
    from app.services import config_service

    provider = config_service.getProvidersAsModels()[0]
    out = _provider_to_dict(provider)
    model = out['models'][0]
    assert model['supportsReasoningEffort'] is True
    assert model['maxReasoningEffort'] == 'medium'


@pytest.mark.asyncio
async def test_add_model_persists_reasoning_fields(store_with_model):
    from app.models.config import ModelCreate
    from app.routers.providers import addModel
    from app.services import config_service

    await addModel(
        'p1',
        ModelCreate(
            id='new-reasoner',
            supports_reasoning_effort=False,
            max_reasoning_effort='low',
        ),
    )
    providers = config_service.getProvidersAsModels()
    model = next(m for m in providers[0].models if m.id == 'new-reasoner')
    assert model.supports_reasoning_effort is False
    assert model.max_reasoning_effort == 'low'
