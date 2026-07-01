"""Alias service tests — CRUD, validation, audit (isolated data dir)."""
import pytest
from app.services import aliasService

def testCrudRoundtrip(isolatedData):
    entry = aliasService.createAlias(alias='fast', targetModel='claude-sonnet-4-7', targetProvider='Anthropic', actor='test')
    assert entry['alias'] == 'fast'
    assert entry['targetModel'] == 'claude-sonnet-4-7'
    listed = aliasService.listAliases()
    assert any((a['alias'] == 'fast' for a in listed))
    updated = aliasService.updateAlias('fast', targetModel='claude-haiku-4-5', actor='test')
    assert updated['targetModel'] == 'claude-haiku-4-5'
    assert aliasService.deleteAlias('fast', actor='test') is True
    assert aliasService.deleteAlias('fast', actor='test') is False

def testUnknownProviderRejected(isolatedData):
    with pytest.raises(ValueError):
        aliasService.createAlias(alias='bad', targetModel='m', targetProvider='ZZZ_NotAProvider', actor='test')

def testKnownProviderAccepted(isolatedData):
    ok, __ = aliasService.validateTarget('Anthropic', 'claude-sonnet-4-7')
    assert ok is True

def testReplaceValidatesEach(isolatedData):
    with pytest.raises(ValueError):
        aliasService.replaceAliases([{'alias': 'ok', 'targetModel': 'claude-sonnet-4-7', 'targetProvider': 'Anthropic'}, {'alias': 'bad', 'targetModel': 'm', 'targetProvider': 'Nope'}], actor='test')

def testAuditRecorded(isolatedData):
    from app.services.memoryStore import listConfigAudit
    aliasService.createAlias(alias='audited', targetModel='claude-sonnet-4-7', targetProvider='Anthropic', actor='test')
    entries = listConfigAudit(category='alias')
    assert any((e['action'] == 'create' and e['after'].get('alias') == 'audited' for e in entries))