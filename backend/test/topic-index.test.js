const test = require('node:test');
const assert = require('node:assert/strict');

const sqliteStore = require('../services/memory/sqlite-memory-store');
// Ensure schema is initialised before any test runs.
sqliteStore.closeMemoryStore();
try { sqliteStore.ensureMemorySchema(); } catch (_) {}

const topicIndex = require('../services/memory/topic-index');

test('classifyTopic returns the expected slug for sample text', () => {
    assert.equal(topicIndex.classifyTopic('please fix the login bug'), 'debug');
    assert.equal(topicIndex.classifyTopic('write a hello world python script'), 'code_edit');
    assert.equal(topicIndex.classifyTopic('research the latest LLM benchmarks'), 'research');
    assert.equal(topicIndex.classifyTopic('plan the system architecture'), 'planning');
    assert.equal(topicIndex.classifyTopic('restart the docker container'), 'system_control');
    assert.equal(topicIndex.classifyTopic('hi there, how are you?'), 'chat');
});

test('indexSession persists topic and parent_topic', () => {
    const sessionId = `sess_topic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const out = topicIndex.indexSession({ sessionId, taskText: 'fix the broken API endpoint', parentTopic: 'engineering' });
    assert.ok(out);
    assert.equal(out.topic, 'debug');
    assert.equal(out.parentTopic, 'engineering');
    const fetched = topicIndex.getSessionTopic(sessionId);
    assert.equal(fetched.topic, 'debug');
    assert.equal(fetched.parentTopic, 'engineering');
});

test('getSessionsByTopic returns rows ordered by classified_at', () => {
    const a = `sess_a_${Date.now()}`;
    const b = `sess_b_${Date.now() + 1}`;
    const c = `sess_c_${Date.now() + 2}`;
    topicIndex.indexSession({ sessionId: a, taskText: 'write a feature' });
    topicIndex.indexSession({ sessionId: b, taskText: 'fix a bug' });
    topicIndex.indexSession({ sessionId: c, taskText: 'research graph memory' });
    const rows = topicIndex.getSessionsByTopic({ limit: 50 });
    assert.ok(rows.length >= 3);
    for (let i = 1; i < rows.length; i++) {
        assert.ok(new Date(rows[i - 1].classifiedAt) >= new Date(rows[i].classifiedAt));
    }
});

test('addRelationship and scanRelated traverse a 2-hop graph', () => {
    topicIndex.addRelationship({ type: 'memory', id: 'm1' }, { type: 'memory', id: 'm2' }, 'related', 1.0);
    topicIndex.addRelationship({ type: 'memory', id: 'm2' }, { type: 'memory', id: 'm3' }, 'derives_from', 0.5);
    const out = topicIndex.scanRelated({ sourceType: 'memory', sourceId: 'm1', depth: 2 });
    const ids = out.nodes.map(n => n.id);
    assert.ok(ids.includes('memory:m1'));
    assert.ok(ids.includes('memory:m2'));
    assert.ok(ids.includes('memory:m3'));
    assert.ok(out.edges.length >= 2);
});