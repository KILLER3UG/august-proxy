"""Alias service tests — CRUD, validation, audit (isolated data dir)."""
import pytest
from app.services import aliasService

def testCrudRoundtrip(isolatedData):
    entry = aliasService.create_alias(alias='fast', target_model='claude-sonnet-4-7', target_provider='Anthropic', actor='test')
    assert entry['alias'] == 'fast'
    assert entry['targetModel'] == 'claude-sonnet-4-7'
    listed = aliasService.list_aliases()
    assert any((a['alias'] == 'fast' for a in listed))
    updated = aliasService.update_alias('fast', target_model='claude-haiku-4-5', actor='test')
    assert updated['targetModel'] == 'claude-haiku-4-5'
    assert aliasService.delete_alias('fast', actor='test') is True
    assert aliasService.delete_alias('fast', actor='test') is False

def testUnknownProviderRejected(isolatedData):
    with pytest.raises(ValueError):
        aliasService.create_alias(alias='bad', target_model='m', target_provider='ZZZ_NotAProvider', actor='test')

def testKnownProviderAccepted(isolatedData):
    ok, __ = aliasService.validate_target('Anthropic', 'claude-sonnet-4-7')
    assert ok is True

def testReplaceValidatesEach(isolatedData):
    with pytest.raises(ValueError):
        aliasService.replace_aliases([{'alias': 'ok', 'targetModel': 'claude-sonnet-4-7', 'targetProvider': 'Anthropic'}, {'alias': 'bad', 'targetModel': 'm', 'targetProvider': 'Nope'}], actor='test')

def testAuditRecorded(isolatedData):
    from app.services.memory_store import listConfigAudit
    aliasService.create_alias(alias='audited', target_model='claude-sonnet-4-7', target_provider='Anthropic', actor='test')
    entries = listConfigAudit(category='alias')
    assert any((e['action'] == 'create' and e['after'].get('alias') == 'audited' for e in entries))