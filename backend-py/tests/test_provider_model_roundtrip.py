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


def test_reference_modal_fields_round_trip(store_with_model):
    """The output cap and modality badges must survive the provider read path.

    ``_provider_to_dict`` reads them off ``ModelConfig``, but
    ``getProvidersAsModels()`` rebuilds each entry from an explicit kwarg list
    that never included them — so the GET answered null for a value that was
    stored. That is not merely cosmetic: ModelRow seeds its field with
    ``model.maxOutputTokens ?? 128000``, so opening the editor and saving ANY
    change silently resets a real cap (a small local model's 8192) to 128000,
    and the modality pills collapse to ['text'].
    """
    from app.routers.providers import _provider_to_dict
    from app.services import config_service

    store = config_service.getProvidersStore()
    store['providers'][0]['models'][0].update(
        {'maxOutputTokens': 8192, 'inputTypes': ['text', 'image'], 'outputTypes': ['text']}
    )
    config_service.saveProvidersStore(store)

    provider = config_service.getProvidersAsModels()[0]
    model = provider.models[0]
    assert model.max_output_tokens == 8192
    assert model.input_types == ['text', 'image']

    out = _provider_to_dict(provider)['models'][0]
    assert out['maxOutputTokens'] == 8192, 'a stored cap must not read back as null'
    assert out['inputTypes'] == ['text', 'image']
    assert out['outputTypes'] == ['text']
