const assert = require('node:assert/strict');
const test = require('node:test');
const { LlmAdapterBase, DEFAULT_MINIMAX_MAX_TOKENS } = require('../adapters/base');

// Re-implements the clamp applied in buildOpenAIRequest so the contract is
// verifiable without spinning up the full Anthropic adapter (which has heavy
// transitive dependencies on config/logger/etc.).
function clampMaxTokens(requestedMaxTokens, backendModel) {
    const adapterBase = new LlmAdapterBase({ profileName: 'claude', logPrefix: 'Test' });
    const preferred = adapterBase.resolvePreferredMaxTokens(requestedMaxTokens, backendModel);
    return Math.max(1024, Math.min(preferred || 8192, 64000));
}

test('clamp raises absurd max_tokens: 1 up to the 1024 floor', () => {
    assert.equal(clampMaxTokens(1, 'some-non-minimax-model'), 1024);
});

test('clamp uses 8192 default when max_tokens is missing for non-MiniMax model', () => {
    assert.equal(clampMaxTokens(undefined, 'gpt-4o'), 8192);
    assert.equal(clampMaxTokens(undefined, 'claude-opus-4-7'), 8192);
});

test('clamp uses 8192 default when max_tokens is null for non-MiniMax model', () => {
    assert.equal(clampMaxTokens(null, 'deepseek-v4-flash-free'), 8192);
});

test('clamp preserves MiniMax high default when max_tokens is missing', () => {
    assert.equal(clampMaxTokens(undefined, 'MiniMax-M2.7'), DEFAULT_MINIMAX_MAX_TOKENS);
    assert.equal(clampMaxTokens(undefined, 'minimax-m2'), 64000);
});

test('clamp respects explicit reasonable max_tokens value (4096)', () => {
    assert.equal(clampMaxTokens(4096, 'gpt-4o'), 4096);
    assert.equal(clampMaxTokens(4096, 'MiniMax-M2.7'), 4096);
});

test('clamp respects explicit value below the 1024 floor by raising it', () => {
    // `max_tokens: 100` is small but valid → clamp raises to the 1024 floor.
    assert.equal(clampMaxTokens(100, 'gpt-4o'), 1024);
});

test('clamp falls back to default when explicit value is 0 (treated as falsy/unspecified)', () => {
    // `max_tokens: 0` is meaningless upstream. The `|| 8192` short-circuit
    // treats 0 as "no value specified" and uses the default. Documented behavior.
    assert.equal(clampMaxTokens(0, 'gpt-4o'), 8192);
});

test('clamp caps oversized explicit value at 64000', () => {
    assert.equal(clampMaxTokens(100000, 'gpt-4o'), 64000);
    assert.equal(clampMaxTokens(999999, 'MiniMax-M2.7'), 64000);
});

test('clamp preserves explicit 64000 boundary exactly', () => {
    assert.equal(clampMaxTokens(64000, 'gpt-4o'), 64000);
});

test('DEFAULT_MINIMAX_MAX_TOKENS is 64000 (regression guard for MiniMax ceiling)', () => {
    assert.equal(DEFAULT_MINIMAX_MAX_TOKENS, 64000);
});
