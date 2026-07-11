"""Alias service tests — CRUD, validation, audit (isolated data dir)."""
import pytest
from app.services import alias_service

def testCrudRoundtrip(isolatedData):
    entry = alias_service.createAlias(alias='fast', targetModel='claude-sonnet-4-7', targetProvider='Anthropic', actor='test')
    assert entry['alias'] == 'fast'
    assert entry['targetModel'] == 'claude-sonnet-4-7'
    listed = alias_service.listAliases()
    assert any((a['alias'] == 'fast' for a in listed))
    updated = alias_service.updateAlias('fast', targetModel='claude-haiku-4-5', actor='test')
    assert updated['targetModel'] == 'claude-haiku-4-5'
    assert alias_service.deleteAlias('fast', actor='test') is True
    assert alias_service.deleteAlias('fast', actor='test') is False

def testUnknownProviderRejected(isolatedData):
    with pytest.raises(ValueError):
        alias_service.createAlias(alias='bad', targetModel='m', targetProvider='ZZZ_NotAProvider', actor='test')

def testKnownProviderAccepted(isolatedData):
    ok, __ = alias_service.validateTarget('Anthropic', 'claude-sonnet-4-7')
    assert ok is True

def testReplaceValidatesEach(isolatedData):
    with pytest.raises(ValueError):
        alias_service.replaceAliases([{'alias': 'ok', 'targetModel': 'claude-sonnet-4-7', 'targetProvider': 'Anthropic'}, {'alias': 'bad', 'targetModel': 'm', 'targetProvider': 'Nope'}], actor='test')

def testAuditRecorded(isolatedData):
    from app.services.memory_store import listConfigAudit
    alias_service.createAlias(alias='audited', targetModel='claude-sonnet-4-7', targetProvider='Anthropic', actor='test')
    entries = listConfigAudit(category='alias')
    assert any((e['action'] == 'create' and e['after'].get('alias') == 'audited' for e in entries))