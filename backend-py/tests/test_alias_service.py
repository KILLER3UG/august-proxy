"""Alias service tests — CRUD, validation, audit (isolated data dir)."""

import pytest
from app.services import alias_service


def testCrudRoundtrip(isolatedData):
    entry = alias_service.createAlias(
        alias='fast', target_model='claude-sonnet-4-7', target_provider='Anthropic', actor='test'
    )
    assert entry['alias'] == 'fast'
    assert entry['target_model'] == 'claude-sonnet-4-7'
    listed = alias_service.listAliases()
    assert any((a['alias'] == 'fast' for a in listed))
    # On-disk config.json keeps camelCase wire keys
    wire = alias_service.alias_to_wire(entry)
    assert wire['targetModel'] == 'claude-sonnet-4-7'
    updated = alias_service.update_alias('fast', target_model='claude-haiku-4-5', actor='test')
    assert updated['target_model'] == 'claude-haiku-4-5'
    assert alias_service.delete_alias('fast', actor='test') is True
    assert alias_service.delete_alias('fast', actor='test') is False


def testUnknownProviderRejected(isolatedData):
    with pytest.raises(ValueError):
        alias_service.createAlias(alias='bad', target_model='m', target_provider='ZZZ_NotAProvider', actor='test')


def testKnownProviderAccepted(isolatedData):
    ok, __ = alias_service.validateTarget('Anthropic', 'claude-sonnet-4-7')
    assert ok is True


def testReplaceValidatesEach(isolatedData):
    with pytest.raises(ValueError):
        alias_service.replaceAliases(
            [
                {'alias': 'ok', 'targetModel': 'claude-sonnet-4-7', 'targetProvider': 'Anthropic'},
                {'alias': 'bad', 'targetModel': 'm', 'targetProvider': 'Nope'},
            ],
            actor='test',
        )


def testAuditRecorded(isolatedData):
    from app.services.memory_store import list_config_audit

    alias_service.createAlias(
        alias='audited', target_model='claude-sonnet-4-7', target_provider='Anthropic', actor='test'
    )
    entries = list_config_audit(category='alias')
    assert any((e['action'] == 'create' and e['after'].get('alias') == 'audited' for e in entries))
