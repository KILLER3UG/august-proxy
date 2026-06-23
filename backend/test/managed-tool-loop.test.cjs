const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { MAX_MANAGED_TOOL_ROUNDS } = require('../adapters/base');

test('MAX_MANAGED_TOOL_ROUNDS exported from base is 10', () => {
    assert.equal(MAX_MANAGED_TOOL_ROUNDS, 10);
});

function readAdapterFile(relPath) {
    return fs.readFileSync(path.join(__dirname, '..', 'adapters', relPath), 'utf8');
}

function countManagedLoopHeaders(source) {
    // Match the loop header: `for (let attempt = 0; attempt < N; attempt++)`
    // inside the managed tool resolution functions. We accept either the new
    // constant form or the legacy literal.
    const matches = source.match(/for\s*\(\s*let\s+attempt\s*=\s*0\s*;\s*attempt\s*<\s*(?:MAX_MANAGED_TOOL_ROUNDS|4)\s*;\s*attempt\s*\+\+\s*\)/g);
    return matches || [];
}

test('anthropic.js has exactly 2 managed-tool loop headers and they use MAX_MANAGED_TOOL_ROUNDS', () => {
    const source = readAdapterFile('anthropic.js');
    const headers = countManagedLoopHeaders(source);
    assert.equal(headers.length, 2, `expected exactly 2 managed-tool loops in anthropic.js, found ${headers.length}`);

    // Both must reference the constant — not the literal 4.
    const literalFours = headers.filter(h => /attempt\s*<\s*4/.test(h));
    assert.equal(literalFours.length, 0, 'no managed-tool loop in anthropic.js should still use the literal 4');
    assert.ok(source.includes('MAX_MANAGED_TOOL_ROUNDS'), 'anthropic.js must import MAX_MANAGED_TOOL_ROUNDS from ./base');
});

test('openai.js has exactly 1 managed-tool loop header and it uses MAX_MANAGED_TOOL_ROUNDS', () => {
    const source = readAdapterFile('openai.js');
    const headers = countManagedLoopHeaders(source);
    assert.equal(headers.length, 1, `expected exactly 1 managed-tool loop in openai.js, found ${headers.length}`);

    const literalFours = headers.filter(h => /attempt\s*<\s*4/.test(h));
    assert.equal(literalFours.length, 0, 'no managed-tool loop in openai.js should still use the literal 4');
    assert.ok(source.includes('MAX_MANAGED_TOOL_ROUNDS'), 'openai.js must import MAX_MANAGED_TOOL_ROUNDS from ./base');
});
