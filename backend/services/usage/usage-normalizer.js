/* ── usage-normalizer ── canonical token/cost shape ── */
/* Normalizes OpenAI, Anthropic, and August-specific usage payloads before
   they are written to request logs, session-store, or observability views. */

function toNonNegativeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function firstPositiveNumber(...values) {
    for (const value of values) {
        const n = toNonNegativeNumber(value);
        if (n > 0) return n;
    }
    return 0;
}

function estimateCost(tokens, ratePer1M) {
    const count = toNonNegativeNumber(tokens);
    const rate = toNonNegativeNumber(ratePer1M);
    return rate > 0 ? (count / 1000000) * rate : 0;
}

function extractUsageTokens(usage = {}) {
    if (!usage || typeof usage !== 'object') {
        return {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
        };
    }

    const inputTokens = firstPositiveNumber(
        usage.prompt_tokens,
        usage.input_tokens,
        usage.prompt_token_count,
        usage.input_token_count
    );
    const outputTokens = firstPositiveNumber(
        usage.completion_tokens,
        usage.output_tokens,
        usage.completion_token_count,
        usage.output_token_count
    );
    const cacheCreationInputTokens = firstPositiveNumber(
        usage.cache_creation_input_tokens,
        usage.cache_creation_input_tokens ?? usage.cache_creation_tokens
    );
    const cacheReadInputTokens = firstPositiveNumber(
        usage.cache_read_input_tokens,
        usage.cached_tokens,
        usage.cache_read_tokens
    );

    return {
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
    };
}

function normalizeUsage(input = {}) {
    const usage = input.usage && typeof input.usage === 'object' ? input.usage : input;
    const hasTopLevelTokens = input.inputTokens !== undefined || input.outputTokens !== undefined;
    const tokens = hasTopLevelTokens
        ? {
            inputTokens: toNonNegativeNumber(input.inputTokens),
            outputTokens: toNonNegativeNumber(input.outputTokens),
            cacheCreationInputTokens: toNonNegativeNumber(input.cacheCreationInputTokens),
            cacheReadInputTokens: toNonNegativeNumber(input.cacheReadInputTokens),
        }
        : extractUsageTokens(usage);
    const inputCostPer1M = toNonNegativeNumber(
        input.inputCostPer1M ?? input.inputCostRate ?? usage.input_cost_per_1m
    );
    const outputCostPer1M = toNonNegativeNumber(
        input.outputCostPer1M ?? input.outputCostRate ?? usage.output_cost_per_1m
    );
    const inputCost = toNonNegativeNumber(input.inputCost);
    const outputCost = toNonNegativeNumber(input.outputCost);
    const calculatedInputCost = inputCost || estimateCost(tokens.inputTokens, inputCostPer1M);
    const calculatedOutputCost = outputCost || estimateCost(tokens.outputTokens, outputCostPer1M);
    const totalTokens = toNonNegativeNumber(input.totalTokens ?? usage.total_tokens)
        || tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationInputTokens + tokens.cacheReadInputTokens;

    return {
        sessionId: input.sessionId || input.session_id || null,
        requestId: input.requestId || input.reqId || null,
        source: input.source || input.requestSource || 'unknown',
        requestType: input.requestType || null,
        model: input.model || input.responseModel || usage.model || 'unknown',
        provider: input.provider || input.clientType || usage.provider || 'unknown',
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheCreationInputTokens: tokens.cacheCreationInputTokens,
        cacheReadInputTokens: tokens.cacheReadInputTokens,
        totalTokens,
        inputCostPer1M,
        outputCostPer1M,
        inputCost: calculatedInputCost,
        outputCost: calculatedOutputCost,
        totalCost: toNonNegativeNumber(input.totalCost) || calculatedInputCost + calculatedOutputCost,
        createdAt: input.createdAt || new Date().toISOString(),
        metadata: input.metadata || {},
    };
}

function usageToOpenAiShape(record) {
    const usage = normalizeUsage(record);
    return {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
    };
}

function usageToAnthropicShape(record) {
    const usage = normalizeUsage(record);
    return {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
    };
}

module.exports = {
    normalizeUsage,
    extractUsageTokens,
    estimateCost,
    usageToOpenAiShape,
    usageToAnthropicShape,
};
