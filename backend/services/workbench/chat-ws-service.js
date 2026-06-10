const { Readable } = require('stream');
const openaiAdapter = require('../../adapters/openai');
const { getProviderConfig, getActiveProvider, saveProfile } = require('../../lib/config');
const { startRequest, endRequest } = require('../../lib/logger');

/* ── safeSend ───────────────────────────────────────────────────────────
 * Safely sends a JSON string payload to a WebSocket client. Wraps ws.send
 * in a try-catch to ignore closed sockets.                               */
function safeSend(ws, payload) {
    if (ws.readyState !== 1 /* OPEN */) return;
    try {
        ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    } catch (e) {
        // Socket closed or write failed mid-send - ignore
    }
}

/* ── WebSocketMockResponse ───────────────────────────────────────────────
 * Mimics the HTTP response interface (writeHead / write / end) so existing
 * adapter functions (openai.js, anthropic.js) can stream over a WebSocket
 * without any changes.  Every outgoing frame carries `requestId` so the
 * frontend can correlate events to the correct turn.                     */
class WebSocketMockResponse {
    constructor(ws, requestId, signal = null) {
        this.ws = ws;
        this.requestId = requestId;
        this.signal = signal;
        this.headersSent = false;
        this.statusCode = 200;
        this.isEventStream = false;
        this.buffer = '';
    }

    writeHead(statusCode, headers) {
        this.headersSent = true;
        this.statusCode = statusCode;
        if (headers) {
            const contentTypeKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-type');
            if (contentTypeKey) {
                this.isEventStream = headers[contentTypeKey].includes('text/event-stream');
            }
        }
    }

    write(chunk) {
        if (this.signal && this.signal.aborted) {
            throw new Error('Request aborted by client');
        }
        if (this.ws.readyState !== 1 /* OPEN */) return;

        if (this.statusCode >= 400 && !this.isEventStream) {
            this.buffer += chunk.toString();
            return;
        }

        this.buffer += chunk.toString();
        
        let newlineIdx;
        while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIdx).trim();
            this.buffer = this.buffer.slice(newlineIdx + 1);
            
            if (!line) continue;

            if (line.startsWith('data:')) {
                const dataStr = line.slice(5).trim();
                if (dataStr === '[DONE]') {
                    safeSend(this.ws, { type: 'done', requestId: this.requestId });
                    continue;
                }
                try {
                    const parsed = JSON.parse(dataStr);
                    // ── Normalize to typed events ──
                    // Handle proxy-typed events (already normalized by adapter)
                    if (parsed.type === 'thinking' || parsed.type === 'text' || parsed.type === 'content' ||
                        parsed.type === 'tool_call' || parsed.type === 'tool_result' || parsed.type === 'tool_progress' ||
                        parsed.type === 'done' || parsed.type === 'error') {
                        safeSend(this.ws, { ...parsed, requestId: this.requestId });
                        continue;
                    }
                    // Handle OpenAI streaming chunks: { choices: [{ delta: { content, reasoning_content } }] }
                    const delta = parsed.choices?.[0]?.delta;
                    if (delta) {
                        if (delta.reasoning_content || delta.reasoning) {
                            safeSend(this.ws, { type: 'thinking', requestId: this.requestId, content: delta.reasoning_content || delta.reasoning });
                        }
                        if (delta.content) {
                            safeSend(this.ws, { type: 'text', requestId: this.requestId, content: delta.content });
                        }
                        // finish_reason chunk with no content — ignore (done event sent at end)
                        continue;
                    }
                    // Handle Anthropic native SSE events
                    const evType = parsed.type;
                    if (evType === 'content_block_delta') {
                        const d = parsed.delta;
                        if (d?.type === 'text_delta' && d.text) {
                            safeSend(this.ws, { type: 'text', requestId: this.requestId, content: d.text });
                        } else if (d?.type === 'thinking_delta' && d.thinking) {
                            safeSend(this.ws, { type: 'thinking', requestId: this.requestId, content: d.thinking });
                        } else if (d?.type === 'input_json_delta') {
                            // tool arg streaming — ignore for now
                        }
                        continue;
                    }
                    if (evType === 'content_block_start' || evType === 'content_block_stop' ||
                        evType === 'message_start' || evType === 'message_delta' || evType === 'message_stop' ||
                        evType === 'ping') {
                        // Lifecycle events — nothing to display
                        if (evType === 'message_stop') {
                            safeSend(this.ws, { type: 'done', requestId: this.requestId });
                        }
                        continue;
                    }
                    // Fallback: forward as-is with requestId
                    safeSend(this.ws, { ...parsed, requestId: this.requestId });
                } catch {
                    safeSend(this.ws, { type: 'text', requestId: this.requestId, content: dataStr });
                }
            }
        }
    }

    end(chunk) {
        if (chunk) {
            if (this.statusCode >= 400 && !this.isEventStream) {
                this.buffer += chunk.toString();
            } else {
                this.write(chunk);
            }
        }
        
        if (this.statusCode >= 400 && !this.isEventStream) {
            const body = this.buffer.trim();
            let errorMessage = body;
            if (body) {
                try {
                    const parsed = JSON.parse(body);
                    errorMessage = parsed.error?.message || parsed.message || parsed.error || body;
                } catch (e) {
                    // Keep raw body
                }
            } else {
                errorMessage = `Upstream Error: status code ${this.statusCode}`;
            }
            safeSend(this.ws, { type: 'error', requestId: this.requestId, message: errorMessage });
        } else {
            const line = this.buffer.trim();
            if (line && line.startsWith('data:')) {
                const dataStr = line.slice(5).trim();
                if (dataStr !== '[DONE]') {
                    try {
                        const parsed = JSON.parse(dataStr);
                        // Reuse same normalization as write()
                        const delta = parsed.choices?.[0]?.delta;
                        if (delta) {
                            if (delta.reasoning_content || delta.reasoning) {
                                safeSend(this.ws, { type: 'thinking', requestId: this.requestId, content: delta.reasoning_content || delta.reasoning });
                            }
                            if (delta.content) {
                                safeSend(this.ws, { type: 'text', requestId: this.requestId, content: delta.content });
                            }
                        } else if (parsed.type === 'content_block_delta') {
                            const d = parsed.delta;
                            if (d?.type === 'text_delta' && d.text) {
                                safeSend(this.ws, { type: 'text', requestId: this.requestId, content: d.text });
                            } else if (d?.type === 'thinking_delta' && d.thinking) {
                                safeSend(this.ws, { type: 'thinking', requestId: this.requestId, content: d.thinking });
                            }
                        } else if (parsed.type && !['content_block_start', 'content_block_stop', 'message_start', 'message_delta', 'message_stop', 'ping'].includes(parsed.type)) {
                            safeSend(this.ws, { ...parsed, requestId: this.requestId });
                        }
                    } catch {
                        safeSend(this.ws, { type: 'text', requestId: this.requestId, content: dataStr });
                    }
                }
            }

            safeSend(this.ws, { type: 'done', requestId: this.requestId });
        }
    }
}

/* ── handleChatConnection ───────────────────────────────────────────────
 * Called by index.js after wss.handleUpgrade completes for /api/chat/ws.
 * Manages keepalive, message dispatch, and lifecycle for one WS client.  */
function handleChatConnection(ws) {
    let abortController = null;

    // ── Keepalive ping every 30s ──
    const pingInterval = setInterval(() => {
        safeSend(ws, { type: 'ping' });
    }, 30000);

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.type === 'chat.start') {
                /* Abort any in-flight turn before starting a new one */
                if (abortController) {
                    abortController.abort();
                    abortController = null;
                }

                const { requestId, payload } = msg;
                if (!requestId || !payload) {
                    safeSend(ws, { type: 'error', requestId, message: 'requestId and payload required' });
                    return;
                }

                abortController = new AbortController();

                const { model, messages, provider, effort, workspacePath } = payload;

                if (!model) {
                    safeSend(ws, { type: 'error', requestId, message: 'model is required' });
                    return;
                }
                if (!messages || !Array.isArray(messages)) {
                    safeSend(ws, { type: 'error', requestId, message: 'messages array is required' });
                    return;
                }

                /* ── Resolve provider (mirrors index.js /api/chat logic) ── */
                const { listProviders } = require('../../providers/provider-registry');
                const providers = listProviders();
                let resolvedProvider = null;

                if (provider) {
                    resolvedProvider = providers.find(p => p.name === provider);
                }

                if (!resolvedProvider) {
                    const lowerModel = model.toLowerCase();
                    for (const p of providers) {
                        if (p._modelProfiles && p._modelProfiles[model]) {
                            resolvedProvider = p;
                            break;
                        }
                    }
                    if (!resolvedProvider) {
                        for (const p of providers) {
                            if (lowerModel.startsWith(p.name.toLowerCase()) || p.aliases.some(alias => lowerModel.startsWith(alias.toLowerCase()))) {
                                resolvedProvider = p;
                                break;
                            }
                        }
                    }
                    if (!resolvedProvider) {
                        if (lowerModel.startsWith('claude-')) resolvedProvider = providers.find(p => p.name === 'anthropic');
                        else if (lowerModel.startsWith('gpt-') || lowerModel.startsWith('o1') || lowerModel.startsWith('o3')) resolvedProvider = providers.find(p => p.name === 'openai-api');
                        else if (lowerModel.startsWith('gemini-')) resolvedProvider = providers.find(p => p.name === 'gemini');
                        else if (lowerModel.startsWith('deepseek-')) resolvedProvider = providers.find(p => p.name === 'deepseek');
                    }
                }

                if (!resolvedProvider) {
                    const active = getActiveProvider() || 'openai-api';
                    resolvedProvider = providers.find(p => p.name === active) || providers[0];
                }

                const pConfig = getProviderConfig(resolvedProvider.name) || {};
                const apiKey = pConfig.apiKey || resolvedProvider.resolveApiKey();
                const baseUrl = pConfig.baseUrl || resolvedProvider.resolveBaseUrl();

                if (!apiKey) {
                    safeSend(ws, { type: 'error', requestId, message: `API Key for provider '${resolvedProvider.displayName}' is not configured.` });
                    return;
                }

                /* Sync codex profile */
                saveProfile('codex', {
                    targetUrl: baseUrl,
                    apiKey,
                    currentModel: model,
                    _upstreamModel: model,
                });

                /* Build OpenAI-compatible payload */
                const openaiPayload = {
                    model,
                    messages,
                    stream: true,
                };
                
                const { resolveModelProfile } = require('../../lib/model-profiles');
                const globalProfile = resolveModelProfile(model);
                const provProfile = resolvedProvider ? resolvedProvider.getModelProfile(model) : null;
                const supportsThinking = !!(provProfile?.supportsThinking || globalProfile?.supportsThinking);
                const supportsReasoning = !!(provProfile?.supportsReasoning || provProfile?.supportsThinking || globalProfile?.supportsReasoning || globalProfile?.supportsThinking);

                if (effort) {
                    if (supportsThinking) {
                        // Claude 3.7 / Thinking Budget models
                        const budgetMap = { low: 1024, medium: 2048, high: 4096, max: 8192 };
                        openaiPayload.thinking = { type: 'enabled', budget_tokens: budgetMap[effort] || 2048 };
                        openaiPayload.temperature = 1;
                    } else if (supportsReasoning) {
                        // OpenAI o1/o3 reasoning effort models
                        openaiPayload.reasoning_effort = effort === 'max' ? 'high' : effort;
                    }
                }

                const fakeReq = Readable.from([JSON.stringify(openaiPayload)]);
                fakeReq.headers = { 'content-type': 'application/json' };
                fakeReq.augustClientId = 'web-ui';
                fakeReq.workspacePath = workspacePath;
                fakeReq.signal = abortController.signal;

                const mockRes = new WebSocketMockResponse(ws, requestId, abortController.signal);
                const reqId = startRequest({ clientType: 'codex', endpoint: '/api/chat/ws', model });

                try {
                    await openaiAdapter.handleChatCompletions(fakeReq, mockRes, '/v1/chat/completions', reqId);
                } catch (e) {
                    if (e.name === 'AbortError') return; // intentional cancellation
                    console.error('[ChatWS] Error:', e.message);
                    safeSend(ws, { type: 'error', requestId, message: e.message });
                } finally {
                    endRequest(reqId);
                }
            } else if (msg.type === 'chat.abort') {
                if (abortController) {
                    abortController.abort();
                    abortController = null;
                }
            } else if (msg.type === 'pong') {
                /* acknowledge (no action needed) */
            }
        } catch (e) {
            console.error('[ChatWS] Invalid message:', e.message);
        }
    });

    ws.on('close', () => {
        clearInterval(pingInterval);
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
    });

    ws.on('error', () => {
        clearInterval(pingInterval);
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
    });
}

module.exports = { handleChatConnection, WebSocketMockResponse };
