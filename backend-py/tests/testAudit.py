"""Config audit log tests (isolated data dir)."""

from app.services.memory_store import listConfigAudit, recordConfigAudit


def testRecordAndList(isolatedData):
    rid = recordConfigAudit('alias', 'create', actor='test', before=None, after={'alias': 'x'})
    assert rid > 0
    entries = listConfigAudit(category='alias')
    assert any((e['after'] == {'alias': 'x'} for e in entries))


def testBeforeAfterJsonRoundtrip(isolatedData):
    recordConfigAudit('agent', 'update', actor='t', before={'a': 1}, after={'a': 2})
    entries = listConfigAudit(category='agent')
    e = next((x for x in entries if x['action'] == 'update'))
    assert e['before'] == {'a': 1}
    assert e['after'] == {'a': 2}


def testLimitRespected(isolatedData):
    for i in range(5):
        recordConfigAudit('fallback', 'configure', actor='t', before=None, after={'i': i})
    assert len(listConfigAudit(category='fallback', limit=3)) == 3
