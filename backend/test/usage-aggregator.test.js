const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'august-usage-aggregator-'));
process.env.AUGUST_DATA_DIR = tempDataDir;

const {
    close,
    createSession,
    init,
    recordUsageEvent,
} = require('../services/storage/session-store');
const { getStats, getByModel, getByDay } = require('../services/usage/usage-aggregator');

test.after(() => {
    close();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
});

test('usage aggregator combines usage_events with legacy session totals', async () => {
    await init();
    const sessionIdWithEvents = `usage-events-${Date.now()}`;
    const legacySessionId = `legacy-${Date.now()}`;

    createSession({
        id: sessionIdWithEvents,
        title: 'New usage event session',
        agent_type: 'usage-test',
        provider: 'openai',
        model: 'gpt-new',
    });
    recordUsageEvent({
        sessionId: sessionIdWithEvents,
        source: 'unit-test',
        model: 'gpt-new',
        provider: 'openai',
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
    });

    createSession({
        id: legacySessionId,
        title: 'Legacy session total',
        agent_type: 'usage-test',
        provider: 'anthropic',
        model: 'claude-legacy',
    });
    const { updateSession } = require('../services/storage/session-store');
    updateSession(legacySessionId, { total_tokens: 50, total_cost: 0.0005 });

    const stats = getStats('30d');
    assert.equal(stats.totalTokens, 150);
    assert.equal(stats.sessions, 2);

    const byModel = getByModel('30d');
    assert.deepEqual(
        byModel.map(item => [item.model, item.tokens]),
        [
            ['gpt-new', 100],
            ['claude-legacy', 50],
        ]
    );

    const byDay = getByDay('30d');
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(byDay.find(item => item.date === today)?.tokens, 150);
});
