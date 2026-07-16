"""Alias service tests — no template catalog."""

import pytest
from app.services import alias_service


def test_crud_roundtrip(isolatedData):
    entry = alias_service.createAlias(
        alias='fast', target_model='claude-sonnet-4-7', target_provider='Anthropic', actor='test'
    )
    assert entry['alias'] == 'fast'
    assert entry['target_model'] == 'claude-sonnet-4-7'
    listed = alias_service.listAliases()
    assert any((a['alias'] == 'fast' for a in listed))
    wire = alias_service.alias_to_wire(entry)
    assert wire['targetModel'] == 'claude-sonnet-4-7'
    updated = alias_service.update_alias('fast', target_model='claude-haiku-4-5', actor='test')
    assert updated['target_model'] == 'claude-haiku-4-5'
    assert alias_service.delete_alias('fast', actor='test') is True


def test_empty_provider_rejected(isolatedData):
    with pytest.raises(ValueError):
        alias_service.createAlias(alias='bad', target_model='m', target_provider='', actor='test')


def test_empty_model_rejected(isolatedData):
    with pytest.raises(ValueError):
        alias_service.createAlias(alias='bad', target_model='', target_provider='Any', actor='test')


def test_any_provider_name_accepted(isolatedData):
    ok, _ = alias_service.validateTarget('CustomGateway', 'my-model')
    assert ok is True


def test_replace_validates_each(isolatedData):
    with pytest.raises(ValueError):
        alias_service.replaceAliases(
            [
                {'alias': 'ok', 'targetModel': 'x', 'targetProvider': 'P'},
                {'alias': 'bad', 'targetModel': '', 'targetProvider': 'P'},
            ],
            actor='test',
        )
