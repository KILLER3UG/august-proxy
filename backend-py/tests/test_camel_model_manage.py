"""Characterization tests for CamelModel on the manage router bodies."""
from __future__ import annotations

from app.routers.manage import AliasCreate, AliasUpdate, SettingsUpdate


def test_alias_create_serializes_by_alias():
    body = AliasCreate(
        alias='fast',
        target_model='gpt-4o-mini',
        target_provider='openai',
    )
    dumped = body.model_dump(by_alias=True)
    assert dumped['alias'] == 'fast'
    assert dumped['targetModel'] == 'gpt-4o-mini'
    assert dumped['targetProvider'] == 'openai'


def test_alias_create_accepts_camelcase_input():
    body = AliasCreate.model_validate(
        {
            'alias': 'cheap',
            'targetModel': 'claude-haiku',
            'targetProvider': 'anthropic',
        }
    )
    assert body.alias == 'cheap'
    assert body.target_model == 'claude-haiku'
    assert body.target_provider == 'anthropic'


def test_alias_update_accepts_camelcase_input():
    body = AliasUpdate.model_validate(
        {'targetModel': 'gpt-4o', 'targetProvider': 'openai'}
    )
    assert body.target_model == 'gpt-4o'
    assert body.target_provider == 'openai'
    dumped = body.model_dump(by_alias=True)
    assert dumped['targetModel'] == 'gpt-4o'
    assert dumped['targetProvider'] == 'openai'


def test_settings_update_basic():
    body = SettingsUpdate(updates={'ui.theme': 'dark', 'logging.level': 'info'})
    assert body.updates['ui.theme'] == 'dark'
    assert body.updates['logging.level'] == 'info'
    dumped = body.model_dump(by_alias=True)
    assert dumped['updates']['ui.theme'] == 'dark'
