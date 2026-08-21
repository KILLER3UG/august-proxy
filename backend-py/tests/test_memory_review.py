"""Memory review plan parsing and apply (no live model)."""

from __future__ import annotations

from app.services.memory.memory_review import apply_review_actions, parse_review_plan


def test_parse_review_plan_extracts_capped_actions():
    raw = """Here is the plan:
{"improve":[{"id":1,"rewritten":"Prefer pytest","why":"clearer"}],
 "remove":[{"id":2,"why":"stale"},{"id":3,"why":"dup"}],
 "enhance":[{"content":"Uses ruff","why":"standing"}]}
"""
    plan = parse_review_plan(raw)
    assert plan['improve'] == [{'id': 1, 'rewritten': 'Prefer pytest', 'why': 'clearer'}]
    assert [x['id'] for x in plan['remove']] == [2, 3]
    assert plan['enhance'][0]['content'] == 'Uses ruff'


def test_parse_review_plan_empty_on_garbage():
    plan = parse_review_plan('not json')
    assert plan['improve'] == []
    assert plan['remove'] == []
    assert plan['enhance'] == []
    assert plan['skills'] == []


def test_apply_review_actions(brain_ready):
    from app.services.memory.auto_memory import saveAutoMemory
    from app.services.memory_store import _conn

    saveAutoMemory('k1', 'noisy fact about pytest maybe', source='auto')
    saveAutoMemory('k2', 'stale leftover', source='auto')
    conn = _conn()
    rows = {r['key']: int(r['id']) for r in conn.execute('SELECT id, key FROM auto_memories').fetchall()}
    stats = apply_review_actions(
        [
            {'kind': 'improve', 'id': rows['k1'], 'rewritten': 'Prefer pytest'},
            {'kind': 'remove', 'id': rows['k2']},
            {'kind': 'enhance', 'content': 'Always run ruff'},
        ]
    )
    assert stats == {'improved': 1, 'removed': 1, 'enhanced': 1}
    left = [dict(r) for r in conn.execute('SELECT key, content, pinned, source FROM auto_memories').fetchall()]
    contents = {r['key']: r['content'] for r in left}
    assert contents['k1'] == 'Prefer pytest'
    assert 'k2' not in contents
    pinned = [r for r in left if r['pinned']]
    assert any('ruff' in str(r['content']).lower() for r in pinned)
