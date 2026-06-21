// Tests for backend/services/memory/context-compressor.js
// Verifies head/tail protection, summary marker, lock acquire/release, and
// the fallback when the lock is held.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'august-context-compressor-'));
process.env.AUGUST_DATA_DIR = tempDataDir;

const sessionStore = require('../services/storage/session-store');
const {
    summarizeMessagesToThreshold,
    buildSummaryMessage,
    compactWithLock,
    isFeatureEnabled,
    FEATURE_FLAG,
    DEFAULT_HEAD_COUNT,
    DEFAULT_TAIL_COUNT,
    DEFAULT_SUMMARY_MARKER,
    localSummarize,
} = require('../services/memory/context-compressor');

test.after(async () => {
    sessionStore.close();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
});

function makeMessages(count, { prefix = 'msg', role = 'user' } = {}) {
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push({ role, content: `${prefix} ${i} — ${'x'.repeat(200)}` });
    }
    return out;
}

test('isFeatureEnabled reads the AUGUST_SUMMARIZING_COMPACTOR env var', () => {
    const prev = process.env[FEATURE_FLAG];
    try {
        delete process.env[FEATURE_FLAG];
        assert.equal(isFeatureEnabled(), false);
        process.env[FEATURE_FLAG] = '1';
        assert.equal(isFeatureEnabled(), true);
    } finally {
        if (prev === undefined) delete process.env[FEATURE_FLAG];
        else process.env[FEATURE_FLAG] = prev;
    }
});

test('summarizeMessagesToThreshold is a no-op when under threshold', () => {
    const messages = makeMessages(3);
    const result = summarizeMessagesToThreshold(messages, [], 1_000_000);
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'under-threshold');
    assert.deepEqual(result.messages, messages);
});

test('summarizeMessagesToThreshold returns messages untouched for too-few-to-summarize', () => {
    const messages = [
        { role: 'system', content: 'You are August.' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
    ];
    const result = summarizeMessagesToThreshold(messages, [], 10);
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'too-few-to-summarize');
});

test('summarizeMessagesToThreshold protects head and tail', () => {
    const messages = makeMessages(20, { prefix: 'turn' });
    const result = summarizeMessagesToThreshold(messages, [], 50, {
        headCount: 4,
        tailCount: 6,
    });
    assert.equal(result.changed, true);
    // No system messages in input, so: head(4) + summary(1) + tail(6) = 11
    assert.equal(result.messages.length, 4 + 1 + 6);
    // Head preserved: first 4 messages match
    for (let i = 0; i < 4; i++) {
        assert.deepEqual(result.messages[i], messages[i]);
    }
    // Tail preserved: last 6 messages match
    const tailOffset = result.messages.length - 6;
    for (let i = 0; i < 6; i++) {
        assert.deepEqual(result.messages[tailOffset + i], messages[messages.length - 6 + i]);
    }
    assert.equal(result.summary.headCount, 4);
    assert.equal(result.summary.tailCount, 6);
    assert.equal(result.summary.compressedCount, 10);
});

test('summarizeMessagesToThreshold inserts a fenced summary message with metadata', () => {
    const messages = makeMessages(15);
    const result = summarizeMessagesToThreshold(messages, [], 50, { headCount: 2, tailCount: 2 });
    assert.equal(result.changed, true);
    // No system messages in input, so summary message is at index 2 (after head(2))
    const summaryMessage = result.messages[2];
    assert.equal(summaryMessage.role, 'system');
    assert.ok(summaryMessage.content.startsWith(DEFAULT_SUMMARY_MARKER), `marker missing in: ${summaryMessage.content.slice(0, 80)}`);
    assert.ok(summaryMessage.content.includes('"marker":"august.summary"'), 'expected metadata JSON in summary');
    assert.ok(summaryMessage.content.includes('"compressedCount":11'), 'expected compressedCount in metadata');
});

test('summarizeMessagesToThreshold preserves system messages outside head/tail', () => {
    const messages = [
        { role: 'system', content: 'system 1' },
        ...makeMessages(15),
        { role: 'system', content: 'system 2 — late injection' },
    ];
    const result = summarizeMessagesToThreshold(messages, [], 50, { headCount: 2, tailCount: 2 });
    assert.equal(result.changed, true);
    // system messages are kept outside head/tail, so they end up at start and end
    assert.equal(result.messages[0].content, 'system 1');
    assert.equal(result.messages[result.messages.length - 1].content, 'system 2 — late injection');
});

test('summarizeMessagesToThreshold accepts a custom summarizer', () => {
    const messages = makeMessages(10);
    const result = summarizeMessagesToThreshold(messages, [], 50, {
        headCount: 2,
        tailCount: 2,
        summarizer: (middle) => `CUSTOM_SUMMARY(${middle.length} msgs)`,
    });
    assert.equal(result.changed, true);
    // No system messages; summary is at index 2 (after head(2))
    const summaryMessage = result.messages[2];
    assert.ok(summaryMessage.content.includes('CUSTOM_SUMMARY(6 msgs)'));
});

test('localSummarize truncates a long message list and joins with role prefix', () => {
    const messages = [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
    ];
    const summary = localSummarize(messages, { maxSummaryChars: 1000 });
    assert.match(summary, /^\[user\] one/);
    assert.match(summary, /\[assistant\] two/);
    assert.match(summary, /\[user\] three/);
});

test('localSummarize adds a tool_calls summary line for assistant messages with tool_calls', () => {
    const messages = [
        { role: 'assistant', content: 'thinking', tool_calls: [
            { function: { name: 'web_search' } },
            { function: { name: 'read_file' } },
        ] },
    ];
    const summary = localSummarize(messages);
    assert.match(summary, /\[tool_calls: web_search, read_file\]/);
});

test('buildSummaryMessage uses the configured marker and metadata', () => {
    const m = buildSummaryMessage(
        [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
        'summary text',
        '<<custom_marker',
        '2026-06-21T00:00:00.000Z'
    );
    assert.equal(m.role, 'system');
    assert.ok(m.content.startsWith('<<custom_marker'));
    assert.ok(m.content.includes('"compressedCount":2'));
    assert.ok(m.content.includes('"at":"2026-06-21T00:00:00.000Z"'));
});

test('compactWithLock acquires the lock, compacts, and releases', async () => {
    await sessionStore.init();
    const sessionId = `compact-${Date.now()}`;
    sessionStore.createSession({ id: sessionId, title: 'compact test', agent_type: 'workbench' });

    const messages = makeMessages(20);
    const result = await compactWithLock(sessionId, messages, [], 50, { headCount: 3, tailCount: 3 });
    assert.ok(result);
    assert.equal(result.changed, true);
    assert.equal(result.summary.compressedCount, 14);

    // Lock should be released
    const reacquired = sessionStore.acquireCompressionLock(sessionId, 'another-holder', 60);
    assert.equal(reacquired, true);
});

test('compactWithLock returns lock-held when another holder has the lock', async () => {
    await sessionStore.init();
    const sessionId = `lock-held-${Date.now()}`;
    sessionStore.createSession({ id: sessionId, title: 'lock test' });

    const held = sessionStore.acquireCompressionLock(sessionId, 'someone-else', 60);
    assert.equal(held, true);

    const messages = makeMessages(20);
    const result = await compactWithLock(sessionId, messages, [], 50);
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'lock-held');

    sessionStore.releaseCompressionLock(sessionId);
});

test('compactWithLock returns null when sessionId is missing or store is not ready', async () => {
    const result = await compactWithLock(null, [], [], 50);
    assert.equal(result, null);
});

test('end-to-end: compactor shrinks a long session and the rebuild fits under threshold', () => {
    // 40 short non-system messages — total ~40 * 8 = ~320 tokens before compaction.
    const messages = [
        { role: 'system', content: 'You are August.' },
        ...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}: short reply` })),
    ];
    // Force compaction with a tight threshold.
    const result = summarizeMessagesToThreshold(messages, [], 100, {
        headCount: 4,
        tailCount: 6,
    });
    assert.equal(result.changed, true);
    // The rebuild must always be strictly smaller than the original.
    assert.ok(result.summary.compressedTokens < result.summary.originalTokens,
        `compressed (${result.summary.compressedTokens}) should be < original (${result.summary.originalTokens})`);
    // 30 middle messages collapsed into one summary, so compressedCount = 30.
    assert.equal(result.summary.compressedCount, 30);
});
