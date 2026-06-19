const { buildFriendlyRateLimitMessage, getRetryDelayMs, isRetryableStatus } = require('../lib/upstream');
const { estimateTokens, formatTokenCount } = require('../lib/tokens');
const { buildSystemBlocks, buildSystemPromptText, isMiniMaxModel } = require('../services/memory/context-builder');

const DEFAULT_MINIMAX_TEMPERATURE = 1;
const DEFAULT_MINIMAX_TOP_P = 0.95;
const DEFAULT_MINIMAX_TOP_K = 40;
const DEFAULT_MINIMAX_MAX_TOKENS = 64000;
const DEFAULT_MINIMAX_TOTAL_WINDOW = 204800;
const DEFAULT_MINIMAX_THINKING_RESERVE = 4096;
const DEFAULT_MINIMAX_SAFETY_BUFFER = 2000;
const MAX_MANAGED_TOOL_ROUNDS = 3;

class LlmAdapterBase {
    constructor({ profileName = 'unknown', logPrefix = 'Adapter' } = {}) {
        this.profileName = profileName;
        this.logPrefix = logPrefix;
    }

    isMiniMaxModel(model) {
        return isMiniMaxModel(model);
    }

    resolvePreferredTemperature(requestedTemperature, model) {
        if (requestedTemperature !== undefined) return requestedTemperature;
        return this.isMiniMaxModel(model) ? DEFAULT_MINIMAX_TEMPERATURE : undefined;
    }

    resolvePreferredTopP(requestedTopP, model) {
        if (requestedTopP !== undefined) return requestedTopP;
        return this.isMiniMaxModel(model) ? DEFAULT_MINIMAX_TOP_P : undefined;
    }

    resolvePreferredTopK(requestedTopK, model, isAnthropicPath) {
        if (isAnthropicPath && this.isMiniMaxModel(model)) return undefined;
        if (requestedTopK !== undefined) return requestedTopK;
        return this.isMiniMaxModel(model) ? DEFAULT_MINIMAX_TOP_K : undefined;
    }

    resolvePreferredMaxTokens(requestedMaxTokens, model) {
        if (requestedMaxTokens !== undefined) return requestedMaxTokens;
        return this.isMiniMaxModel(model) ? DEFAULT_MINIMAX_MAX_TOKENS : undefined;
    }

    applyGenerationDefaults(payload, source, { model, isAnthropicPath = false } = {}) {
        const next = payload;
        const maxTokens = this.resolvePreferredMaxTokens(source.max_tokens ?? source.max_output_tokens, model);
        const temperature = this.resolvePreferredTemperature(source.temperature, model);
        const topP = this.resolvePreferredTopP(source.top_p, model);
        const topK = this.resolvePreferredTopK(source.top_k, model, isAnthropicPath);

        if (maxTokens !== undefined) next.max_tokens = maxTokens;
        if (temperature !== undefined) next.temperature = temperature;
        if (topP !== undefined) next.top_p = topP;
        if (topK !== undefined) next.top_k = topK;
        if (!isAnthropicPath && this.isMiniMaxModel(model)) next.reasoning_split = true;
        return next;
    }

    getCompactionThreshold(contextWindow, { model, requestedMaxTokens } = {}) {
        if (!this.isMiniMaxModel(model)) {
            return Math.floor((contextWindow || 32768) * 0.88);
        }

        const totalWindow = Math.max(contextWindow || 0, DEFAULT_MINIMAX_TOTAL_WINDOW);
        const outputReserve = requestedMaxTokens || DEFAULT_MINIMAX_MAX_TOKENS;
        return totalWindow - outputReserve - DEFAULT_MINIMAX_THINKING_RESERVE - DEFAULT_MINIMAX_SAFETY_BUFFER;
    }

    compactMessagesToThreshold(messages, tools, threshold, {
        truncateRoles = ['tool'],
        maxMessageChars = 8000
    } = {}) {
        const systemMessages = messages.filter(m => m.role === 'system');
        const otherMessages = messages.filter(m => m.role !== 'system');
        let kept = otherMessages;

        while (kept.length > 1) {
            const testMessages = [...systemMessages, ...kept];
            if (estimateTokens(testMessages, tools) <= threshold) break;
            kept = kept.slice(1);
        }

        const compacted = [...systemMessages, ...kept];
        if (estimateTokens(compacted, tools) > threshold) {
            compacted.forEach(message => {
                if (!truncateRoles.includes(message.role)) return;
                if (typeof message.content === 'string' && message.content.length > maxMessageChars) {
                    message.content = message.content.substring(0, maxMessageChars) + '\n\n[TRUNCATED]';
                }
            });
        }

        return compacted;
    }

    buildProviderSystemPrompt(system, options = {}) {
        return buildSystemPromptText(system, options);
    }

    buildProviderSystemBlocks(system, options = {}) {
        return buildSystemBlocks(system, options);
    }

    logContextBudget({ model, contextWindow, estimatedTokens, threshold, requestedMaxTokens }) {
        if (this.isMiniMaxModel(model)) {
            const outputReserve = requestedMaxTokens || DEFAULT_MINIMAX_MAX_TOKENS;
            console.log(`[Proxy Context]: MiniMax combined-budget threshold: ${formatTokenCount(threshold)} (${formatTokenCount(Math.max(contextWindow || 0, DEFAULT_MINIMAX_TOTAL_WINDOW))} total - ${formatTokenCount(outputReserve)} output - ${formatTokenCount(DEFAULT_MINIMAX_THINKING_RESERVE)} thinking - ${formatTokenCount(DEFAULT_MINIMAX_SAFETY_BUFFER)} safety)`);
        }
        console.log(`[Proxy Context]: model=${model}, window=${formatTokenCount(contextWindow)}, estimated=${formatTokenCount(estimatedTokens)}, threshold=${formatTokenCount(threshold)}`);
    }

    async fetchWithRetries(url, fetchOptions, {
        maxAttempts = 3,
        retryLabel = this.logPrefix
    } = {}) {
        let response;
        let attempts = 0;
        while (attempts < maxAttempts) {
            attempts += 1;
            response = await fetch(url, fetchOptions);
            if (!isRetryableStatus(response.status) || attempts >= maxAttempts) {
                break;
            }
            const delayMs = getRetryDelayMs(response, attempts);
            console.warn(`[Proxy Retry]: ${retryLabel} upstream returned ${response.status}. Retrying in ${delayMs}ms (attempt ${attempts}/${maxAttempts})`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        return { response, attempts };
    }

    buildFriendlyRateLimitMessage(status, rawBody, attempts) {
        return buildFriendlyRateLimitMessage(status, rawBody, attempts);
    }

    parseOpenAIChatSSE(sseText) {
        return parseOpenAIChatSSE(sseText);
    }

    extractUsageTokens(usage, contextLabel) {
        return extractUsageTokens(usage, contextLabel);
    }
}

function parseOpenAIChatSSE(sseText) {
    const lines = String(sseText || '').split('\n');
    let fullContent = '';
    let fullReasoning = '';
    const toolCalls = [];
    let finishReason = 'stop';
    let model = '';
    let id = '';
    let usage = null;

    for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        try {
            const chunk = JSON.parse(jsonStr);
            if (chunk.id) id = chunk.id;
            if (chunk.model) model = chunk.model;
            if (chunk.usage) usage = chunk.usage;
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.content) fullContent += delta.content;
            if (delta.reasoning) fullReasoning += delta.reasoning;
            if (delta.reasoning_content) fullReasoning += delta.reasoning_content;
            if (delta.tool_calls) {
                delta.tool_calls.forEach(tc => {
                    const existing = toolCalls.find(t => t.index === tc.index);
                    if (existing) {
                        if (tc.id) existing.id = tc.id;
                        if (tc.function?.name) existing.function.name += tc.function.name;
                        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                    } else {
                        toolCalls.push({
                            ...tc,
                            function: {
                                name: tc.function?.name || '',
                                arguments: tc.function?.arguments || ''
                            }
                        });
                    }
                });
            }
            const fr = chunk.choices?.[0]?.finish_reason;
            if (fr !== null && fr !== undefined) finishReason = fr;
        } catch (e) {
            // Ignore malformed SSE fragments.
        }
    }

    const normalizedToolCalls = toolCalls.map(tc => ({
        id: tc.id || 'call_' + Math.random().toString(36).substr(2, 9),
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments }
    }));

    const message = { role: 'assistant', content: fullContent };
    if (fullReasoning) message.reasoning = fullReasoning;
    if (normalizedToolCalls.length > 0) message.tool_calls = normalizedToolCalls;

    const result = {
        id: id || 'chatcmpl-' + Math.random().toString(36).substr(2, 9),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'unknown',
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
    console.log(`[Proxy SSE Parse]: content_len=${fullContent.length}, reasoning_len=${fullReasoning.length}, tools=${normalizedToolCalls.length}, finish_reason=${finishReason}`);
    return result;
}

function extractUsageTokens(usage, contextLabel) {
    const inputTokens = usage?.prompt_tokens || usage?.input_tokens || 0;
    const outputTokens = usage?.completion_tokens || usage?.output_tokens || 0;
    if (!usage) {
        console.warn(`[Proxy Usage]: ${contextLabel} returned no usage data`);
    } else if (inputTokens === 0 && outputTokens === 0) {
        console.warn(`[Proxy Usage]: ${contextLabel} usage payload had zero tokens`);
    }
    return { inputTokens, outputTokens };
}

module.exports = {
    DEFAULT_MINIMAX_MAX_TOKENS,
    MAX_MANAGED_TOOL_ROUNDS,
    LlmAdapterBase,
    extractUsageTokens,
    parseOpenAIChatSSE
};
