const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeUsage,
    extractUsageTokens,
    usageToOpenAiShape,
    usageToAnthropicShape,
} = require('../services/usage/usage-normalizer');

test('normalizeUsage handles OpenAI usage shape and cost rates', () => {
    const usage = normalizeUsage({
        usage: {
            prompt_tokens: 1200,
            completion_tokens: 300,
            total_tokens: 1500,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 50,
        },
        model: 'gpt-test',
        provider: 'openai',
        source: 'unit-test',
        inputCostPer1M: 5,
        outputCostPer1M: 15,
    });

    assert.equal(usage.inputTokens, 1200);
    assert.equal(usage.outputTokens, 300);
    assert.equal(usage.cacheCreationInputTokens, 100);
    assert.equal(usage.cacheReadInputTokens, 50);
    assert.equal(usage.totalTokens, 1500);
    assert.ok(Math.abs(usage.inputCost - 0.006) < 1e-9);
    assert.equal(usage.outputCost, 0.0045);
    assert.ok(Math.abs(usage.totalCost - 0.0105) < 1e-9);
});

test('normalizeUsage handles Anthropic usage shape', () => {
    const usage = normalizeUsage({
        usage: {
            input_tokens: 700,
            output_tokens: 200,
        },
        model: 'claude-test',
        provider: 'anthropic',
        source: 'unit-test',
    });

    assert.equal(usage.inputTokens, 700);
    assert.equal(usage.outputTokens, 200);
    assert.equal(usage.totalTokens, 900);
});

test('normalizeUsage falls back to calculated total and zero-cost when rates are missing', () => {
    const usage = normalizeUsage({
        inputTokens: 10,
        outputTokens: 20,
        model: 'fallback-model',
    });

    assert.equal(usage.totalTokens, 30);
    assert.equal(usage.inputCost, 0);
    assert.equal(usage.outputCost, 0);
    assert.equal(usage.totalCost, 0);
});

test('extractUsageTokens returns zero tokens for empty payloads', () => {
    assert.deepEqual(extractUsageTokens({}), {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
    });
});

test('usage shape helpers preserve normalized token names', () => {
    assert.deepEqual(usageToOpenAiShape({
        inputTokens: 11,
        outputTokens: 22,
        totalTokens: 33,
    }), {
        prompt_tokens: 11,
        completion_tokens: 22,
        total_tokens: 33,
    });

    assert.deepEqual(usageToAnthropicShape({
        inputTokens: 11,
        outputTokens: 22,
        totalTokens: 33,
    }), {
        input_tokens: 11,
        output_tokens: 22,
    });
});
