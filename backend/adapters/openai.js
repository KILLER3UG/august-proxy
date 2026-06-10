const { getProfile } = require('../lib/config');
const { logActivity, endRequest, captureRequest, captureResponse, captureTokens, captureError } = require('../lib/logger');
const { applySelfHealToMessages } = require('../services/workbench/selfheal');
const { getModelContextWindow, saveModelContextWindow, loadModelContextWindow } = require('../lib/models');
const { estimateTokens, formatTokenCount } = require('../lib/tokens');
const { buildFriendlyRateLimitMessage, getRetryDelayMs, isRetryableStatus } = require('../lib/upstream');
const { LlmAdapterBase } = require('./base');
const { buildSystemPromptText } = require('../services/memory/context-builder');
const {
    MANAGED_WEB_TOOL_NAMES,
    isManagedWebToolName,
    isProxyManagedLocalToolName,
    getToolDefinitionName,
    appendMissingOpenAiTools,
    getProxyOpenAiToolDefinitions,
    getCanonicalManagedOpenAiWebTools,
    formatManagedToolResult,
    executeManagedProxyTool,
    executeManagedOpenAiToolCalls
} = require('./proxy-tools');

const adapterBase = new LlmAdapterBase({ profileName: 'codex', logPrefix: 'OpenAI' });

// ── Parse SSE stream into a complete Chat Completions JSON object ──
function parseSSEToJSON(sseText) {
    return adapterBase.parseOpenAIChatSSE(sseText);
}

// ── Translate Responses API content parts to plain text ──
function translateResponsesContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return JSON.stringify(content);
    const texts = [];
    content.forEach(part => {
        if (part.type === 'input_text' || part.type === 'output_text') {
            texts.push(part.text);
        } else if (part.type === 'input_image' || part.type === 'input_file') {
            texts.push(`[${part.type}]`);
        } else if (part.text) {
            texts.push(part.text);
        }
    });
    return texts.join('\n');
}

// ── Translate Responses API input → Chat Completions messages ──
function translateResponsesInput(oReq) {
    if (oReq.messages && Array.isArray(oReq.messages)) return; // Already Chat Completions format
    if (!oReq.input) return;

    const messages = [];

    // Instructions = system prompt in Responses API
    if (oReq.instructions) {
        messages.push({ role: 'system', content: oReq.instructions });
    }

    const input = oReq.input;
    if (typeof input === 'string') {
        messages.push({ role: 'user', content: input });
    } else if (Array.isArray(input)) {
        // Responses API input items can be interleaved function_call / function_call_output
        // We need to group function_call items into assistant messages with tool_calls
        let pendingToolCalls = [];

        function flushToolCalls() {
            if (pendingToolCalls.length > 0) {
                messages.push({ role: 'assistant', content: '', tool_calls: pendingToolCalls });
                pendingToolCalls = [];
            }
        }

        input.forEach(item => {
            if (typeof item === 'string') {
                flushToolCalls();
                messages.push({ role: 'user', content: item });
            } else if (item.type === 'function_call') {
                pendingToolCalls.push({
                    id: item.call_id || item.id,
                    type: 'function',
                    function: {
                        name: item.name,
                        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
                    }
                });
            } else if (item.type === 'function_call_output') {
                flushToolCalls(); // MUST create assistant message with tool_calls BEFORE the tool result
                messages.push({
                    role: 'tool',
                    tool_call_id: item.call_id,
                    content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
                });
            } else if (item.role) {
                flushToolCalls();
                messages.push({
                    role: item.role,
                    content: translateResponsesContent(item.content)
                });
            }
        });

        flushToolCalls(); // Flush remaining at end
    }

    oReq.messages = messages;
}

function looksLikeProviderAlias(model) {
    const value = String(model || '').trim().toLowerCase();
    return value.startsWith('claude-') || value.startsWith('gpt-');
}

function toOpenAiCompatibleTargetUrl(targetUrl) {
    let target = String(targetUrl || '').trim();
    if (!target) return '';
    if (/\/chat\/completions$/i.test(target) || /\/text\/chatcompletion_v2$/i.test(target)) return target;
    if (target.includes('/anthropic/v1/messages')) {
        return target.replace('/anthropic/v1/messages', target.includes('minimax') ? '/v1/text/chatcompletion_v2' : '/v1/chat/completions');
    }
    if (target.includes('/anthropic')) {
        return target.replace('/anthropic', target.includes('minimax') ? '/v1/text/chatcompletion_v2' : '/v1/chat/completions');
    }
    target = target.replace(/\/+$/, '');
    if (/\/v\d+$/i.test(target)) return `${target}/chat/completions`;
    return `${target}/v1/chat/completions`;
}

function getOpenAiCompatibleProfile() {
    const codex = getProfile('codex') || {};
    const fallback = getProfile('claude') || {};
    const merged = codex.targetUrl
        ? { ...codex }
        : {
            ...fallback,
            ...codex,
            apiKey: codex.apiKey || fallback.apiKey,
            targetUrl: fallback.targetUrl,
            _upstreamModel: codex._upstreamModel || fallback._upstreamModel || fallback.currentModel,
            currentModel: codex.currentModel || fallback.currentModel
        };
    merged.targetUrl = toOpenAiCompatibleTargetUrl(merged.targetUrl);
    if (merged.targetUrl.includes('minimax') && looksLikeProviderAlias(merged._upstreamModel || merged.currentModel)) {
        merged._upstreamModel = merged.openAiCompatibleModel || merged.memoryExtractionModel || merged.memoryModel || merged._upstreamModel || merged.currentModel || 'auto';
    }
    return merged;
}

function extractUsageTokens(usage, contextLabel) {
    return adapterBase.extractUsageTokens(usage, contextLabel);
}

// ── Main handler for /v1/chat/completions and /v1/responses ──
async function handleChatCompletions(req, res, cleanPath, reqId) {
    return new Promise((resolve) => {
        const clientId = req.augustClientId || 'unknown';
        let body = '';
        let bodyComplete = false;

        const abortCtrl = new AbortController();
        const handleAbort = () => {
            abortCtrl.abort();
        };
        req.on('close', handleAbort);
        if (req.signal) {
            if (req.signal.aborted) {
                abortCtrl.abort();
            } else {
                req.signal.addEventListener('abort', handleAbort);
            }
        }

        const bodyTimeout = setTimeout(() => {
            if (bodyComplete) return;
            bodyComplete = true;
            captureError(reqId, 'Request body timed out before completion.');
            endRequest(reqId, { status: 'error', model: 'unknown', error: 'Request body timeout' });
            if (!res.headersSent) {
                res.writeHead(408, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Request body timeout' } }));
            }
            req.off('close', handleAbort);
            if (req.signal) req.signal.removeEventListener('abort', handleAbort);
            resolve();
        }, 30000);

        req.on('data', chunk => { body += chunk; });
        req.on('error', err => {
            if (bodyComplete) return;
            bodyComplete = true;
            clearTimeout(bodyTimeout);
            captureError(reqId, err);
            endRequest(reqId, { status: 'error', model: 'unknown', error: err.message });
            if (!res.headersSent) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
            req.off('close', handleAbort);
            if (req.signal) req.signal.removeEventListener('abort', handleAbort);
            resolve();
        });

        req.on('end', async () => {
            if (bodyComplete) return;
            bodyComplete = true;
            clearTimeout(bodyTimeout);

            // ── Per-request tracking — endRequest must fire exactly once ──
            let requestModel = 'unknown';
            let requestStatus = 'success';
            let requestError = null;
            let _endCalled = false;
            function finishRequest() {
                if (_endCalled) return;
                _endCalled = true;
                req.off('close', handleAbort);
                if (req.signal) req.signal.removeEventListener('abort', handleAbort);
                endRequest(reqId, {
                    status: requestStatus,
                    model: requestModel,
                    error: requestError
                });
                resolve();
            }

        try {
            console.log(`[Proxy Body]: ${cleanPath} (${body.length} bytes)`);

            const cfg = getOpenAiCompatibleProfile();
            let oReq = {};
            try {
                oReq = JSON.parse(body || '{}');
            } catch (e) {
                console.error('[Proxy Error]: Failed to parse request body:', e.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
            }

            // Capture request for debug UI
            captureRequest(reqId, { ...oReq, model: cfg.currentModel, endpoint: cleanPath });

            // Translate Responses API input format (if present) to Chat Completions messages
            translateResponsesInput(oReq);

            if (!oReq.messages || !Array.isArray(oReq.messages)) {
                oReq.messages = [{ role: 'user', content: 'hi' }];
            }

            const systemPromptOptions = {
                model: cfg._upstreamModel || cfg.currentModel,
                targetUrl: cfg.targetUrl,
                includeWindowsContext: true,
                clientId: clientId,
                workspacePath: req.workspacePath
            };
            const existingSystemIdx = oReq.messages.findIndex(m => m.role === 'system');
            if (existingSystemIdx >= 0) {
                const existing = oReq.messages[existingSystemIdx].content || '';
                const combined = buildSystemPromptText(existing, systemPromptOptions);
                if (combined.length > 8000) {
                    console.warn(`[Proxy System Prompt]: Codex system prompt is ${combined.length} chars — may be truncated by upstream model.`);
                } else {
                    console.log(`[Proxy System Prompt]: Codex system prompt length=${combined.length} chars`);
                }
                oReq.messages[existingSystemIdx].content = combined;
            } else {
                // Inject the shared Claude-shaped memory hierarchy plus provider instructions.
                const windowsSystemPrompt = buildSystemPromptText(null, systemPromptOptions);
                console.log(`[Proxy System Prompt]: Codex system prompt length=${windowsSystemPrompt.length} chars (injected)`);
                oReq.messages.unshift({ role: 'system', content: windowsSystemPrompt });
            }

            // ── Model Resolution (Alias Mapping) ──
            const requestedModel = oReq.model || 'gpt-5.4';
            requestModel = cfg._upstreamModel || cfg.currentModel || requestedModel;
            
            // Handle explicit aliases (just like in Claude profile)
            if (requestedModel === 'gpt-5.4' || requestedModel === 'gpt-4o' || requestedModel === 'gpt-4-turbo') {
                requestModel = cfg._upstreamModel || cfg.currentModel;
            }

            // Handle aliasTargets if defined
            if (cfg.aliasTargets && cfg.aliasTargets[requestedModel]) {
                const target = cfg.aliasTargets[requestedModel];
                requestModel = target.model || target.currentModel || requestModel;
                if (target.targetUrl || target.url) cfg.targetUrl = target.targetUrl || target.url;
                if (target.apiKey) cfg.apiKey = target.apiKey;
            }

            const authHeader = req.headers['authorization'] || '';
            if (authHeader.includes('Bearer model:')) {
                const extractedModel = authHeader.split('model:')[1].trim();
                if (extractedModel) {
                    requestModel = extractedModel;
                    console.log(`[Proxy Hijack]: Using model from CLI: ${requestModel}`);
                }
            }
            oReq.model = requestModel;

            // ── Smart context compaction (only when approaching model's limit) ──
            let contextWindow = loadModelContextWindow('codex', requestModel);
            if (!contextWindow) {
                const modelInfo = await getModelContextWindow(requestModel, cfg.targetUrl, cfg.apiKey);
                contextWindow = modelInfo.inputTokens;
                saveModelContextWindow('codex', requestModel, contextWindow);
            }
            const threshold = adapterBase.getCompactionThreshold(contextWindow, {
                model: requestModel,
                requestedMaxTokens: oReq.max_output_tokens ?? oReq.max_tokens
            });
            const estimatedTokens = estimateTokens(oReq.messages, oReq.tools);
            adapterBase.logContextBudget({
                model: requestModel,
                contextWindow,
                estimatedTokens,
                threshold,
                requestedMaxTokens: oReq.max_output_tokens ?? oReq.max_tokens
            });

            if (estimatedTokens > threshold) {
                console.log(`[Proxy Compaction]: ${formatTokenCount(estimatedTokens)} tokens exceeds ${formatTokenCount(threshold)} threshold. Compacting...`);
                const systemMsgs = oReq.messages.filter(m => m.role === 'system');
                const otherMsgs = oReq.messages.filter(m => m.role !== 'system');
                let kept = otherMsgs;
                // Drop oldest non-system messages until we're under threshold
                while (kept.length > 1) {
                    const testMessages = [...systemMsgs, ...kept];
                    const testTokens = estimateTokens(testMessages, oReq.tools);
                    if (testTokens <= threshold) break;
                    const first = kept[0];
                    let dropCount = 1;
                    if (first.role === 'assistant' && first.tool_calls?.length > 0) {
                        const callIds = new Set(first.tool_calls.map(tc => tc.id));
                        while (dropCount < kept.length
                            && kept[dropCount]?.role === 'tool'
                            && kept[dropCount]?.tool_call_id
                            && callIds.has(kept[dropCount].tool_call_id)) {
                            dropCount++;
                        }
                    }
                    kept = kept.slice(dropCount);
                }
                oReq.messages = [...systemMsgs, ...kept];
                const newEstimate = estimateTokens(oReq.messages, oReq.tools);
                console.log(`[Proxy Compaction]: Trimmed from ${otherMsgs.length} to ${kept.length} non-system messages. New estimate: ${formatTokenCount(newEstimate)}`);

                // If still over threshold, truncate individual long messages
                if (newEstimate > threshold) {
                    oReq.messages.forEach(m => {
                        if (typeof m.content === 'string' && m.content.length > 8000) {
                            m.content = m.content.substring(0, 8000) + '\n\n[TRUNCATED]';
                        }
                    });
                    const finalEstimate = estimateTokens(oReq.messages, oReq.tools);
                    console.log(`[Proxy Compaction]: Also truncated long messages. Final estimate: ${formatTokenCount(finalEstimate)}`);
                }
                logActivity('COMPACT', `Codex: ${formatTokenCount(estimatedTokens)} -> ${formatTokenCount(estimateTokens(oReq.messages, oReq.tools))} tokens (${formatTokenCount(contextWindow)} window)`);
            }

            // Self-healing: enhance error tool results so the model can fix them
            oReq.messages = applySelfHealToMessages(oReq.messages);

            // Run fallback recovery for any client tool executions that failed
            await fallbackClientFailedToolsOpenAi(oReq);

            logActivity('AGENT', `Request using ${oReq.model}`);
            console.log(`[Proxy Upstream]: Sending request to ${cfg.targetUrl} for model ${oReq.model}`);

            // Codex Responses API expects Responses-format SSE, but upstream speaks Chat Completions.
            // Force non-streaming upstream so we can translate JSON -> Responses SSE.
            const isResponsesEndpoint = cleanPath.includes('/v1/responses');
            const clientWantsStream = oReq.stream === true; // Default to non-streaming
            // Free-tier models default to tiny limits (~256 tokens). Ensure a reasonable minimum.
            // This applies to BOTH Responses API and Chat Completions paths.
            const clientMaxTokens = oReq.max_output_tokens !== undefined ? oReq.max_output_tokens : oReq.max_tokens;
            const preferredMaxTokens = adapterBase.resolvePreferredMaxTokens(clientMaxTokens, requestModel);
            const effectiveMaxTokens = Math.max(1024, Math.min(preferredMaxTokens || 2048, 64000));
            oReq.max_tokens = effectiveMaxTokens;
            delete oReq.max_output_tokens;
            adapterBase.applyGenerationDefaults(oReq, oReq, { model: requestModel, isAnthropicPath: false });

            const clientToolNames = new Set((oReq.tools || []).map(t => t.name || t.function?.name).filter(Boolean));
            // ── Inject August/MCP/Cowork/web proxy tool definitions ──
            const managedLocalToolNames = new Set();
            if (oReq.tools && Array.isArray(oReq.tools) && oReq.tools.length > 0) {
                // Smart client: augment their tools with proxy-managed ones
                const injected = appendMissingOpenAiTools(oReq.tools, getProxyOpenAiToolDefinitions());
                if (injected.length > 0) {
                    console.log('[Proxy Tools]: Injected OpenAI-compatible proxy tools:', injected);
                }
            } else {
                // Dumb client (no tools sent): inject all proxy tools so August tools are available
                oReq.tools = getProxyOpenAiToolDefinitions();
                console.log('[Proxy Tools]: Injected default proxy tools (MCP/August/Cowork/web)');
            }
            // Remember which tools are locally managed so we can intercept them (only if not client-provided)
            for (const tool of oReq.tools || []) {
                const name = getToolDefinitionName(tool);
                if (isProxyManagedLocalToolName(name) && !clientToolNames.has(name)) {
                    managedLocalToolNames.add(name);
                }
            }

            // ── Intercept and locally execute managed tool calls ──
            // Force non-streaming when we have managed tools so we can run the tool loop synchronously
            if (managedLocalToolNames.size > 0) {
                oReq.stream = false; // force non-streaming for tool interception
            }

            if (isResponsesEndpoint) {
                oReq.stream = false;
                // Clean up Responses-only fields that upstream won't understand
                delete oReq.previous_response_id;
                delete oReq.input;
                delete oReq.instructions;
                // Pass through standard params (temperature, top_p, stop, etc. are already compatible)
                console.log(`[Proxy Params]: max_tokens=${oReq.max_tokens}, temp=${oReq.temperature}, top_p=${oReq.top_p}`);
            }

            let response;
            let attempts = 0;
            const maxAttempts = 3;
            while (attempts < maxAttempts) {
                attempts++;
                const fetchSignal = typeof AbortSignal.any === 'function'
                    ? AbortSignal.any([abortCtrl.signal, AbortSignal.timeout(300000)])
                    : abortCtrl.signal;

                response = await fetch(cfg.targetUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${cfg.apiKey}`
                    },
                    body: JSON.stringify(oReq),
                    signal: fetchSignal
                });
                if (!isRetryableStatus(response.status) || attempts >= maxAttempts) {
                    break;
                }
                const delayMs = getRetryDelayMs(response, attempts);
                console.warn(`[Proxy Retry]: OpenAI upstream returned ${response.status}. Retrying in ${delayMs}ms (attempt ${attempts}/${maxAttempts})`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }

            console.log(`[Proxy Upstream]: Received status ${response.status}`);

            const upstreamIsStream = response.headers.get('content-type')?.includes('text/event-stream');

            // ── /v1/responses translation (OpenAI Responses API) ──
            if (isResponsesEndpoint) {
                const rawBody = await response.text();
                if (!response.ok) {
                    if (response.status === 429) {
                        requestStatus = 'error';
                        requestError = buildFriendlyRateLimitMessage(response.status, rawBody, attempts);
                    }
                    res.writeHead(response.status, { 'Content-Type': 'application/json' });
                    res.end(response.status === 429 ? JSON.stringify({
                        type: 'error',
                        error: {
                            type: 'rate_limit_error',
                            message: requestError
                        }
                    }) : rawBody);
                    finishRequest();
                    return;
                }
                try {
                    const standardData = upstreamIsStream ? parseSSEToJSON(rawBody) : JSON.parse(rawBody);
                    captureResponse(reqId, standardData);
                    const choice = standardData.choices?.[0];
                    const finishReason = choice?.finish_reason || 'N/A';
                    const contentLen = choice?.message?.content?.length || 0;
                    const toolCallCount = choice?.message?.tool_calls?.length || 0;
                    console.log(`[Proxy Upstream]: finish_reason="${finishReason}", content_len=${contentLen}, tool_calls=${toolCallCount}`);
                    // Warn if model stopped due to token limit — this is the #1 cause of incomplete responses
                    if (finishReason === 'length') {
                        console.warn(`[Proxy WARNING]: Upstream stopped due to max_tokens limit! Response was truncated. Consider using a model with larger output capacity.`);
                    }
                    const respId = 'resp_' + Math.random().toString(36).substr(2, 9);
                    const createdAt = Math.floor(Date.now() / 1000);
                    const chatUsage = standardData.usage || {};
                    const usage = {
                        input_tokens: chatUsage.prompt_tokens || 0,
                        output_tokens: chatUsage.completion_tokens || 0,
                        total_tokens: chatUsage.total_tokens || (chatUsage.prompt_tokens || 0) + (chatUsage.completion_tokens || 0)
                    };
                    // Record tokens in the log immediately (no global endRequest for this path)
                    captureTokens(reqId, usage.input_tokens, usage.output_tokens);

                    // Build output items
                    const outputItems = [];
                    let msgContent = '';
                    if (choice?.message) {
                        const msg = choice.message;
                        if (msg.reasoning) {
                            outputItems.push({
                                id: 'item_' + Math.random().toString(36).substr(2, 9),
                                type: 'reasoning',
                                status: 'completed',
                                content: msg.reasoning
                            });
                        }
                        if (msg.tool_calls) {
                            msg.tool_calls.forEach(tc => {
                                outputItems.push({
                                    id: tc.id,
                                    type: 'function_call',
                                    status: 'completed',
                                    name: tc.function.name,
                                    arguments: tc.function.arguments,
                                    call_id: tc.id
                                });
                            });
                        }
                        if (msg.content) {
                            msgContent = msg.content;
                            outputItems.push({
                                id: 'msg_' + Math.random().toString(36).substr(2, 9),
                                type: 'message',
                                status: 'completed',
                                role: 'assistant',
                                content: [{ type: 'output_text', text: msgContent }]
                            });
                        }
                    }

                    const baseResponse = {
                        id: respId,
                        object: 'response',
                        created_at: createdAt,
                        status: 'in_progress',
                        model: requestModel,
                        output: [],
                        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
                    };

                    const completedResponse = {
                        ...baseResponse,
                        status: 'completed',
                        output: outputItems,
                        usage: usage
                    };

                    // Simulate Responses API streaming event sequence
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });

                    // 1. response.created
                    res.write(`data: ${JSON.stringify({ type: 'response.created', response: baseResponse })}\n\n`);

                    // 2. response.in_progress
                    res.write(`data: ${JSON.stringify({ type: 'response.in_progress', response: baseResponse })}\n\n`);

                    // 3. Output items added/done + text deltas
                    outputItems.forEach((item, idx) => {
                        // output_item.added
                        res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: idx, item })}\n\n`);

                        if (item.type === 'message' && item.content?.[0]?.type === 'output_text') {
                            // content_part.added
                            res.write(`data: ${JSON.stringify({ type: 'response.content_part.added', item_id: item.id, content_index: 0, part: { type: 'output_text', text: '' } })}\n\n`);

                            // Stream text in ~20 char chunks
                            const text = item.content[0].text;
                            const chunkSize = 20;
                            for (let i = 0; i < text.length; i += chunkSize) {
                                const delta = text.substring(i, i + chunkSize);
                                res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: item.id, content_index: 0, delta })}\n\n`);
                            }

                            // content_part.done
                            res.write(`data: ${JSON.stringify({ type: 'response.content_part.done', item_id: item.id, content_index: 0, part: { type: 'output_text', text: text, annotations: [] } })}\n\n`);
                        } else if (item.type === 'function_call') {
                            // Function call arguments delta (Codex expects incremental delivery)
                            const args = item.arguments || '{}';
                            const argChunkSize = 20;
                            for (let i = 0; i < args.length; i += argChunkSize) {
                                const delta = args.substring(i, i + argChunkSize);
                                res.write(`data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: idx, delta })}\n\n`);
                            }
                        }

                        // output_item.done
                        res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: idx, item })}\n\n`);
                    });

                    // 4. response.completed
                    res.write(`data: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`);

                    // 5. [DONE]
                    res.write('data: [DONE]\n\n');
                    res.end();
                    finishRequest();
                    return;
                } catch (transErr) {
                    requestStatus = 'error';
                    requestError = transErr.message;
                    console.error('[Proxy Translation]: FAILED', transErr.message);
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ type: 'error', error: { message: transErr.message } })}\n\n`);
                    res.end();
                    finishRequest();
                    return;
                }
            }

            // ── Streaming handling ──

            if (upstreamIsStream && clientWantsStream) {
                // Forward SSE directly; accumulate body copy to extract usage when done.
                res.writeHead(response.status, { 'Content-Type': 'text/event-stream' });
                if (!response.body) {
                    res.end();
                    finishRequest();
                } else {
                    const reader = response.body.getReader();
                    let accumulatedText = '';
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            const chunk = Buffer.from(value);
                            accumulatedText += chunk.toString();
                            res.write(chunk);
                        }
                        // Stream ended — check for managed tool calls
                        try {
                            const parsed = parseSSEToJSON(accumulatedText);
                            captureResponse(reqId, parsed);
                            const inTok  = parsed.usage?.prompt_tokens     || parsed.usage?.input_tokens     || 0;
                            const outTok = parsed.usage?.completion_tokens || parsed.usage?.output_tokens || 0;
                            captureTokens(reqId, inTok, outTok);

                            const upstreamMsg = parsed.choices?.[0]?.message;
                            const hasManagedTools = upstreamMsg?.tool_calls?.length > 0 &&
                                managedLocalToolNames.size > 0 &&
                                upstreamMsg.tool_calls.some(tc => managedLocalToolNames.has(tc.function?.name));

                            if (hasManagedTools) {
                                // Already forwarded raw SSE — but some SSE may contain tool_calls.
                                // Resolve and re-stream the final answer.
                                const resolved = await resolveManagedOpenAiToolCalls(parsed, oReq, cfg, clientToolNames, req.workspacePath, (evt) => {
                                    try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch (e) {}
                                }, abortCtrl.signal);
                                const resolvedMsg = resolved.choices?.[0]?.message;
                                const resolvedDelta = {
                                    role: resolvedMsg?.role || 'assistant',
                                    content: resolvedMsg?.content || ''
                                };
                                if (resolvedMsg?.reasoning) resolvedDelta.reasoning = resolvedMsg.reasoning;
                                if (resolvedMsg?.reasoning_content) resolvedDelta.reasoning_content = resolvedMsg.reasoning_content;
                                const resolvedChunk = {
                                    id: resolved.id || parsed.id || 'chatcmpl-' + Math.random().toString(36).substr(2, 9),
                                    object: 'chat.completion.chunk',
                                    created: resolved.created || parsed.created || Math.floor(Date.now() / 1000),
                                    model: requestModel,
                                    choices: [{
                                        index: 0,
                                        delta: resolvedDelta,
                                        finish_reason: resolved.choices?.[0]?.finish_reason || 'stop'
                                    }]
                                };
                                res.write(`data: ${JSON.stringify(resolvedChunk)}\n\n`);
                            }
                        } catch (e) {
                            console.warn('[Proxy SSE Parse Warning]: Failed to reconstruct OpenAI response for capture:', e.message);
                        }
                        res.end();
                        finishRequest();
                    } catch (err) {
                        console.error('[Proxy Stream Error]:', err);
                        requestStatus = 'error';
                        requestError = err.message;
                        res.end();
                        finishRequest();
                    }
                }
            } else if (!upstreamIsStream && clientWantsStream) {
                // Provider returned JSON but client expects SSE (Codex)
                const rawBody = await response.text();
                if (!response.ok) {
                    requestStatus = 'error';
                    requestError = response.status === 429
                        ? buildFriendlyRateLimitMessage(response.status, rawBody, attempts)
                        : `Upstream Error (${response.status}): ${rawBody}`;
                    res.writeHead(response.status, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ type: 'error', error: { message: requestError } })}\n\n`);
                    res.end();
                    finishRequest();
                    return;
                }
                try {
                    const data = JSON.parse(rawBody);
                    captureResponse(reqId, data);
                    const inTok  = data.usage?.prompt_tokens     || data.usage?.input_tokens     || 0;
                    const outTok = data.usage?.completion_tokens || data.usage?.output_tokens || 0;
                    captureTokens(reqId, inTok, outTok);
                    const upstreamMsg = data.choices?.[0]?.message;

                    // ── Resolve managed tool calls before streaming to client ──
                    const hasManagedTools = upstreamMsg?.tool_calls?.length > 0 &&
                        managedLocalToolNames.size > 0 &&
                        upstreamMsg.tool_calls.some(tc => managedLocalToolNames.has(tc.function?.name));

                    if (hasManagedTools) {
                        const resolved = await resolveManagedOpenAiToolCalls(data, oReq, cfg, clientToolNames, req.workspacePath, (evt) => {
                            try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch (e) {}
                        }, abortCtrl.signal);
                        const resolvedMsg = resolved.choices?.[0]?.message;
                        const resolvedDelta = {
                            role: resolvedMsg?.role || 'assistant',
                            content: resolvedMsg?.content || ''
                        };
                        if (resolvedMsg?.reasoning) resolvedDelta.reasoning = resolvedMsg.reasoning;
                        if (resolvedMsg?.reasoning_content) resolvedDelta.reasoning_content = resolvedMsg.reasoning_content;
                        const resolvedChunk = {
                            id: resolved.id || data.id || 'chatcmpl-' + Math.random().toString(36).substr(2, 9),
                            object: 'chat.completion.chunk',
                            created: resolved.created || data.created || Math.floor(Date.now() / 1000),
                            model: requestModel,
                            choices: [{
                                index: 0,
                                delta: resolvedDelta,
                                finish_reason: resolved.choices?.[0]?.finish_reason || 'stop'
                            }]
                        };
                        res.writeHead(response.status, { 'Content-Type': 'text/event-stream' });
                        res.write(`data: ${JSON.stringify(resolvedChunk)}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } else {
                        // No managed tools — synthesize SSE for JSON passthrough
                        const delta = {
                            role: upstreamMsg?.role,
                            content: upstreamMsg?.content || ''
                        };
                        if (upstreamMsg?.reasoning) delta.reasoning = upstreamMsg.reasoning;
                        if (upstreamMsg?.reasoning_content) delta.reasoning_content = upstreamMsg.reasoning_content;
                        const chunk = {
                            id: data.id || 'chatcmpl-' + Math.random().toString(36).substr(2, 9),
                            object: 'chat.completion.chunk',
                            created: data.created || Math.floor(Date.now() / 1000),
                            model: requestModel,
                            choices: [{
                                index: 0,
                                delta: delta,
                                finish_reason: data.choices?.[0]?.finish_reason || null
                            }]
                        };
                        res.writeHead(response.status, { 'Content-Type': 'text/event-stream' });
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                } catch (e) {
                    requestStatus = 'error';
                    requestError = e.message;
                    res.writeHead(response.status, { 'Content-Type': 'application/json' });
                    res.end(rawBody);
                }
            } else if (upstreamIsStream && !clientWantsStream) {
                // Upstream returned SSE but client expects JSON — parse and aggregate
                const rawBody = await response.text();
                if (!response.ok) {
                    requestStatus = 'error';
                    requestError = response.status === 429
                        ? buildFriendlyRateLimitMessage(response.status, rawBody, attempts)
                        : `Upstream Error (${response.status}): ${rawBody}`;
                    res.writeHead(response.status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: requestError } }));
                    return;
                }
                try {
                    const parsed = parseSSEToJSON(rawBody);
                    captureResponse(reqId, parsed);
                    const { inputTokens: inTok, outputTokens: outTok } = extractUsageTokens(parsed.usage, 'SSE->JSON aggregation');
                    captureTokens(reqId, inTok, outTok);

                    // --- AUTO-MEMORY BACKGROUND EXTRACTION ---
                    const { extractAndSaveMemories } = require('../services/memory/auto-memory');
                    extractAndSaveMemories(oReq.messages, parsed, cfg, requestModel).catch(e => console.warn('[Auto-Memory] Extraction failed:', e.message));

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(parsed));
                } catch (e) {
                    console.error('[Proxy SSE Parse Error]:', e.message);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(rawBody);
                }
            } else {
                // Non-streaming passthrough
                let rawBody = await response.text();
                if (!response.ok) {
                    requestStatus = 'error';
                    requestError = response.status === 429
                        ? buildFriendlyRateLimitMessage(response.status, rawBody, attempts)
                        : `Upstream Error (${response.status}): ${rawBody}`;
                    res.writeHead(response.status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: requestError } }));
                    return;
                }
                try {
                    let parsed = JSON.parse(rawBody);
                    if (managedLocalToolNames.size > 0) {
                        parsed = await resolveManagedOpenAiToolCalls(parsed, oReq, cfg, clientToolNames, req.workspacePath, null, abortCtrl.signal);
                    }
                    captureResponse(reqId, parsed);
                    const { inputTokens: inTok, outputTokens: outTok } = extractUsageTokens(parsed.usage, 'JSON passthrough');
                    captureTokens(reqId, inTok, outTok);

                    // --- AUTO-MEMORY BACKGROUND EXTRACTION ---
                    const { extractAndSaveMemories } = require('../services/memory/auto-memory');
                    extractAndSaveMemories(oReq.messages, parsed, cfg, requestModel).catch(e => console.warn('[Auto-Memory] Extraction failed:', e.message));

                    if (clientWantsStream && managedLocalToolNames.size > 0) {
                        sendSimulatedOpenAiStream(res, parsed, requestModel);
                        finishRequest();
                        return;
                    }
                    rawBody = JSON.stringify(parsed);
                } catch (e) { /* ignore parse errors for passthrough */ }
                res.writeHead(response.status, { 'Content-Type': 'application/json' });
                res.end(rawBody);
            }
        } catch (e) {
            requestStatus = 'error';
            requestError = e.message;
            console.error('OpenAI Adapter Error:', e);
            captureError(reqId, e);
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Proxy Error: ' + e.message } }));
        } finally {
            finishRequest(); // no-op if already called by streaming path
        }
    });
  });
}

function isOpenAiToolResultError(content) {
    if (typeof content !== 'string') return false;
    const lower = content.toLowerCase();
    return lower.startsWith('error') || lower.includes('[validation error]') || lower.includes('failed to execute');
}

async function fallbackClientFailedToolsOpenAi(oReq) {
    if (!oReq || !Array.isArray(oReq.messages)) return;

    // Find all tool messages at the end of the messages array
    for (let i = oReq.messages.length - 1; i >= 0; i--) {
        const msg = oReq.messages[i];
        if (msg.role !== 'tool') break;

        if (isOpenAiToolResultError(msg.content)) {
            const toolCallId = msg.tool_call_id;
            if (!toolCallId) continue;

            // Search backward for the assistant message containing the tool call
            let toolName = null;
            let toolArgs = null;
            for (let j = i - 1; j >= 0; j--) {
                const prevMsg = oReq.messages[j];
                if (prevMsg.role === 'assistant' && Array.isArray(prevMsg.tool_calls)) {
                    const found = prevMsg.tool_calls.find(tc => tc.id === toolCallId);
                    if (found) {
                        toolName = found.function?.name;
                        toolArgs = found.function?.arguments;
                        break;
                    }
                }
            }

            if (toolName && isProxyManagedLocalToolName(toolName)) {
                console.log(`[Proxy Fallback]: OpenAI Client tool '${toolName}' (${toolCallId}) failed. Executing proxy fallback...`);
                let parsedArgs = {};
                try {
                    parsedArgs = JSON.parse(toolArgs || '{}');
                } catch {}

                try {
                    const localResult = await executeManagedProxyTool(toolName, parsedArgs);
                    msg.content = formatManagedToolResult(toolName, localResult);
                    console.log(`[Proxy Fallback]: Successfully recovered OpenAI tool '${toolName}' execution.`);
                } catch (err) {
                    console.warn(`[Proxy Fallback]: Proxy fallback for OpenAI '${toolName}' also failed:`, err.message);
                }
            }
        }
    }
}

// ── Helper to resolve managed tools recursively (up to 4 attempts) ──
async function resolveManagedOpenAiToolCalls(initialParsed, oReq, cfg, clientToolNames, workspacePath = null, onToolEvent = null, parentSignal = null) {
    let parsed = initialParsed;
    const requestPayload = {
        ...oReq,
        messages: Array.isArray(oReq.messages) ? [...oReq.messages] : []
    };

    for (let attempt = 0; attempt < 4; attempt++) {
        if (parentSignal && parentSignal.aborted) {
            throw new Error('Request aborted by client');
        }

        const choice = parsed.choices?.[0];
        const msg = choice?.message;
        const toolCalls = msg?.tool_calls || [];
        if (toolCalls.length === 0) return parsed;

        const managedToolCalls = toolCalls.filter(tc =>
            isProxyManagedLocalToolName(tc.function?.name) && !clientToolNames.has(tc.function?.name)
        );
        if (managedToolCalls.length === 0) return parsed;

        if (managedToolCalls.length !== toolCalls.length) {
            console.warn('[Proxy Tools]: Mixed managed and unmanaged OpenAI tool_calls detected. Returning raw tool_calls response to client.');
            return parsed;
        }

        requestPayload.messages.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: toolCalls
        });

        const toolResults = await executeManagedOpenAiToolCalls(managedToolCalls, requestPayload.tools, requestPayload.messages, workspacePath, onToolEvent);
        toolResults.forEach(res => requestPayload.messages.push(res));

        const fetchSignal = parentSignal
            ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([parentSignal, AbortSignal.timeout(300000)]) : parentSignal)
            : AbortSignal.timeout(300000);

        const response = await fetch(cfg.targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cfg.apiKey}`
            },
            body: JSON.stringify(requestPayload),
            signal: fetchSignal
        });

        const rawBody = await response.text();
        if (!response.ok) {
            throw new Error(`Upstream Error (${response.status}): ${rawBody}`);
        }

        parsed = JSON.parse(rawBody);
    }

    return parsed;
}

// ── Helper to simulate OpenAI chunked stream ──
function sendSimulatedOpenAiStream(res, parsed, requestModel) {
    const choice = parsed.choices?.[0];
    const msg = choice?.message || {};
    const delta = {
        role: msg.role || 'assistant',
        content: msg.content || ''
    };
    if (msg.reasoning) delta.reasoning = msg.reasoning;
    if (msg.reasoning_content) delta.reasoning_content = msg.reasoning_content;

    const chunk = {
        id: parsed.id || 'chatcmpl-' + Math.random().toString(36).substr(2, 9),
        object: 'chat.completion.chunk',
        created: parsed.created || Math.floor(Date.now() / 1000),
        model: requestModel,
        choices: [{
            index: 0,
            delta: delta,
            finish_reason: choice?.finish_reason || 'stop'
        }]
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
}

module.exports = { handleChatCompletions };
