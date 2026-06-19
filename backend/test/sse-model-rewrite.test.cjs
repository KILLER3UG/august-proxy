const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// Source-level + behavior tests for the SSE model-field rewrite optimization.
//
// The new implementation uses a string-level regex replacement instead of a
// recursive object walk. We verify both the structural change in source and
// the rewrite semantics on representative payloads.

const source = fs.readFileSync(
    path.join(__dirname, '..', 'adapters', 'anthropic.js'),
    'utf8'
);

test('streamAnthropicSSEToClient uses string-level rewrite (regex pattern present)', () => {
    // The new implementation should declare a regex literal matching
    //   "model":<whitespace>:"<chars-not-quote>"
    // i.e. a string-typed `"model":` field. Search for the literal escape
    // sequences `\s*:\s*` and `"[^"]*"` appearing together with `"model"`.
    assert.ok(
        source.includes('"model"\\s*:\\s*"[^"]*"'),
        'expected `"model"\\s*:\\s*"[^"]*"` regex literal in anthropic.js'
    );
});

test('streamAnthropicSSEToClient fast-paths chunks without a model field', () => {
    // The new code should check `data.includes('"model"')` (directly or via
    // a hasModelField helper) and forward non-matching chunks without parsing.
    const fastPathPattern = /\.includes\(\s*['"]"model"['"]\s*\)/;
    assert.ok(
        fastPathPattern.test(source),
        'expected `includes("\\"model\\"")` fast-path in streamAnthropicSSEToClient'
    );
});

test('streamAnthropicSSEToClient uses JSON.stringify for safe escaping', () => {
    // The replacement value must be a JSON.stringify(...) output, not raw interpolation.
    assert.ok(
        /JSON\.stringify\(\s*responseModel\s*\)/.test(source),
        'expected JSON.stringify(responseModel) for safe escaping in streamAnthropicSSEToClient'
    );
});

test('rewriteModelFieldsInValue is no longer called inside the streaming parser callback', () => {
    // Locate the SseStreamParser callback (the function passed to its constructor)
    // and verify it does not invoke the recursive walker.
    const callbackMatch = source.match(/new\s+SseStreamParser\(\s*\(event,\s*data\)\s*=>\s*\{([\s\S]*?)\}\s*\)/);
    assert.ok(callbackMatch, 'expected to find SseStreamParser callback');
    const callbackBody = callbackMatch[1];
    assert.ok(
        !callbackBody.includes('rewriteModelFieldsInValue'),
        'SseStreamParser callback should not call the recursive rewriteModelFieldsInValue'
    );
});

// ── Behavioral verification via the same regex / fast-path logic ──

function rewriteLine(data, escapedModel) {
    if (!escapedModel) return data;
    if (!data.includes('"model"')) return data;
    return data.replace(/"model"\s*:\s*"[^"]*"/g, `"model":${escapedModel}`);
}

test('rewrite replaces message_start.message.model with the safe-escaped value', () => {
    const data = JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_1', model: 'upstream-anthropic-model', role: 'assistant' }
    });
    const escaped = JSON.stringify('client-facing-alias');
    const out = rewriteLine(data, escaped);
    const parsed = JSON.parse(out);
    assert.equal(parsed.message.model, 'client-facing-alias');
    assert.equal(parsed.type, 'message_start');
    assert.equal(parsed.message.id, 'msg_1');
});

test('rewrite is a no-op on chunks with no model field', () => {
    const data = JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' }
    });
    const out = rewriteLine(data, JSON.stringify('whatever'));
    assert.equal(out, data, 'chunks without model field should pass through unchanged');
});

test('rewrite safely escapes quotes and backslashes in the replacement value', () => {
    const data = JSON.stringify({ message: { model: 'old' } });
    const escaped = JSON.stringify('weird"value\\with"quotes');
    const out = rewriteLine(data, escaped);
    const parsed = JSON.parse(out);
    assert.equal(parsed.message.model, 'weird"value\\with"quotes');
});

test('rewrite only replaces string-typed model fields (not nested objects)', () => {
    // When "model" appears as an object (e.g. metadata), the regex must not match.
    const data = JSON.stringify({ message: { model: 'old' }, metadata: { model: { nested: 1 } } });
    const out = rewriteLine(data, JSON.stringify('NEW'));
    const parsed = JSON.parse(out);
    assert.equal(parsed.message.model, 'NEW');
    assert.deepEqual(parsed.metadata.model, { nested: 1 }, 'nested object model field should be untouched');
});
