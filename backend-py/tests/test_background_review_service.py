"""Background review *config* service tests (isolated data dir).

Covers save_config field merging and the config-change audit entry — the
sibling of test_alias_service.test_audit_recorded / test_fallback_service.
(The review *loop* is tested in test_background_review.py.)
"""
from app.services import backgroundReviewService

def testGetDefaultShape(isolatedData):
    cfg = backgroundReviewService.get_config()
    assert 'enabled' in cfg and 'reviewModel' in cfg
    assert 'reflectionModel' in cfg and 'autoMemoryModel' in cfg
    assert cfg['enabled'] is False

def testSavePartialMerge(isolatedData):
    out = backgroundReviewService.save_config(review_model='claude-sonnet-4-7', actor='test')
    assert out['reviewModel'] == 'claude-sonnet-4-7'
    assert out['enabled'] is False
    assert backgroundReviewService.get_config()['reviewModel'] == 'claude-sonnet-4-7'

def testAuditRecordedOnSave(isolatedData):
    """save_config must record a config-change audit entry (m6 parity with
    alias/fallback services) so self-configuration stays traceable."""
    from app.services.memory_store import listConfigAudit
    backgroundReviewService.save_config(review_model='claude-haiku-4-5', auto_memory_model='claude-sonnet-4-7', actor='test')
    entries = listConfigAudit(category='background_review')
    assert any((e['action'] == 'update' and e['actor'] == 'test' and (e['after'].get('reviewModel') == 'claude-haiku-4-5') for e in entries))

def testAuditCapturesBefore(isolatedData):
    """The audit `before` snapshot must reflect the prior config so a change
    is reversible/inspectable — not just the new state."""
    from app.services.memory_store import listConfigAudit
    backgroundReviewService.save_config(review_model='first-model', actor='test')
    backgroundReviewService.save_config(review_model='second-model', actor='test')
    entries = listConfigAudit(category='background_review')
    transition = next((e for e in entries if e['after'].get('reviewModel') == 'second-model'))
    assert transition['before'].get('reviewModel') == 'first-model'