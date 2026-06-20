const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'august-usage-store-'));
process.env.AUGUST_DATA_DIR = tempDataDir;

const {
    close,
    createSession,
    getSession,
    init,
    listUsageEvents,
    recordUsageEvent,
} = require('../services/storage/session-store');

test.after(() => {
    close();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
});

test('recordUsageEvent persists usage and updates session totals', async () => {
    await init();
    const sessionId = `usage-session-${Date.now()}`;
    createSession({
        id: sessionId,
        title: 'Usage recorder unit test',
        agent_type: 'usage-test',
        provider: 'openai',
        model: 'gpt-test',
        metadata: { test: true },
    });

    const event = recordUsageEvent({
        sessionId,
        requestId: 'req-unit-1',
        source: 'unit-test',
        requestType: 'chat',
        model: 'gpt-test',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        inputCostPer1M: 1,
        outputCostPer1M: 2,
        inputCost: 0.0001,
        outputCost: 0.0001,
        totalCost: 0.0002,
        metadata: { case: 'first' },
    });

    assert.ok(event.id);
    assert.equal(event.session_id, sessionId);
    assert.equal(event.request_id, 'req-unit-1');
    assert.equal(event.total_tokens, 150);
    assert.deepEqual(event.metadata, { case: 'first' });

    const events = listUsageEvents(sessionId, { order: 'asc' });
    assert.equal(events.length, 1);
    assert.equal(events[0].total_tokens, 150);

    const session = getSession(sessionId);
    assert.equal(session.total_tokens, 150);
    assert.equal(Number(session.total_cost), 0.0002);
    assert.equal(session.model, 'gpt-test');
});
