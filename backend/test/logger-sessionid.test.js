// Tests for the expanded sessionId resolution in backend/lib/logger.js
// Verifies the new fallback chain (body.user, body.metadata.user_id, headers,
// synthetic key) so /v1 traffic from external clients (Claude Desktop etc.)
// gets a sessionId and a usage_events row.

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractSessionId, resolveSessionId, syntheticSessionId } = require('../lib/logger');

test('extractSessionId returns empty string when body is missing or non-object', () => {
    assert.equal(extractSessionId(null), '');
    assert.equal(extractSessionId(undefined), '');
    assert.equal(extractSessionId('not-an-object'), '');
    assert.equal(extractSessionId(42), '');
});

test('extractSessionId finds sessionId at the top level', () => {
    assert.equal(extractSessionId({ sessionId: 'sid-1' }), 'sid-1');
});

test('extractSessionId finds session_id at the top level', () => {
    assert.equal(extractSessionId({ session_id: 'sid-2' }), 'sid-2');
});

test('extractSessionId finds metadata.sessionId', () => {
    assert.equal(extractSessionId({ metadata: { sessionId: 'sid-3' } }), 'sid-3');
});

test('extractSessionId finds metadata.session_id', () => {
    assert.equal(extractSessionId({ metadata: { session_id: 'sid-4' } }), 'sid-4');
});

test('extractSessionId falls back to body.user (OpenAI common)', () => {
    assert.equal(extractSessionId({ user: 'user-42' }), 'user-42');
});

test('extractSessionId falls back to body.metadata.user_id (Anthropic common)', () => {
    assert.equal(extractSessionId({ metadata: { user_id: 'anthropic-user-7' } }), 'anthropic-user-7');
});

test('extractSessionId prefers sessionId over user when both are present', () => {
    assert.equal(extractSessionId({ sessionId: 'sid', user: 'user' }), 'sid');
});

test('syntheticSessionId produces the documented format', () => {
    const sid = syntheticSessionId({ provider: 'openai', model: 'gpt-4o' });
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(sid, `proxy:openai:gpt-4o:${today}`);
});

test('syntheticSessionId sanitizes unsafe characters', () => {
    const sid = syntheticSessionId({ provider: 'op/ai:1', model: 'gpt 4' });
    assert.ok(sid.startsWith('proxy:op_ai_1:gpt_4:'), `unexpected format: ${sid}`);
});

test('syntheticSessionId falls back to "unknown" for missing fields', () => {
    const sid = syntheticSessionId({});
    assert.match(sid, /^proxy:unknown:unknown:\d{4}-\d{2}-\d{2}$/);
});

test('resolveSessionId prefers metadata.sessionId when present', () => {
    const sid = resolveSessionId(
        { user: 'u', sessionId: 's' },
        { sessionId: 'meta-sid' }
    );
    assert.equal(sid, 'meta-sid');
});

test('resolveSessionId falls back to body fields when metadata is empty', () => {
    assert.equal(resolveSessionId({ sessionId: 's' }, {}), 's');
    assert.equal(resolveSessionId({ metadata: { user_id: 'a-uid' } }, {}), 'a-uid');
    assert.equal(resolveSessionId({ user: 'u' }, {}), 'u');
});

test('resolveSessionId falls back to headers when body has nothing', () => {
    const sid = resolveSessionId(
        {},
        {
            headers: {
                'x-session-id': 'hdr-sid',
                'x-conversation-id': 'cid-1',
                'x-request-id': 'req-1',
            },
        }
    );
    assert.equal(sid, 'hdr-sid');
});

test('resolveSessionId prefers x-session-id over other headers', () => {
    const sid = resolveSessionId(
        {},
        { headers: { 'x-conversation-id': 'cid', 'x-session-id': 'sess' } }
    );
    assert.equal(sid, 'sess');
});

test('resolveSessionId generates a synthetic key when nothing is found', () => {
    const sid = resolveSessionId({}, { provider: 'openai', model: 'gpt-4o' });
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(sid, `proxy:openai:gpt-4o:${today}`);
});

test('resolveSessionId always returns a value (never empty)', () => {
    const sid = resolveSessionId(null, {});
    assert.ok(sid.length > 0, `expected non-empty sessionId, got "${sid}"`);
    assert.match(sid, /^proxy:unknown:unknown:\d{4}-\d{2}-\d{2}$/);
});
