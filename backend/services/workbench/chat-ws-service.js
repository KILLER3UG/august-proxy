const { Readable } = require('stream');
const openaiAdapter = require('../../adapters/openai');
const { getProviderConfig, getActiveProvider, saveProfile } = require('../../lib/config');
const { startRequest, endRequest } = require('../../lib/logger');

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
        this.buffer = '';
    }

    writeHead(statusCode, headers) {
        this.headersSent = true;
    }

    write(chunk) {
        if (this.signal && this.signal.aborted) {
            throw new Error('Request aborted by client');
        }
        if (this.ws.readyState !== 1 /* OPEN */) return;

        this.buffer += chunk.toString();
        
        let newlineIdx;
        while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIdx).trim();
            this.buffer = this.buffer.slice(newlineIdx + 1);
            
            if (!line) continue;

            if (line.startsWith('data:')) {
                const dataStr = line.slice(5).trim();
                if (dataStr === '[DONE]') {
                    this.ws.send(JSON.stringify({ type: 'done', requestId: this.requestId }));
                    continue;
                }
                try {
                    const parsed = JSON.parse(dataStr);
                    this.ws.send(JSON.stringify({ ...parsed, requestId: this.requestId }));
                } catch {
                    this.ws.send(JSON.stringify({ type: 'text', requestId: this.requestId, content: dataStr }));
                }
            }
        }
    }

    end(chunk) {
        if (chunk) this.write(chunk);
        
        const line = this.buffer.trim();
        if (line && line.startsWith('data:')) {
            const dataStr = line.slice(5).trim();
            if (dataStr !== '[DONE]') {
                try {
                    const parsed = JSON.parse(dataStr);
                    this.ws.send(JSON.stringify({ ...parsed, requestId: this.requestId }));
                } catch {
                    this.ws.send(JSON.stringify({ type: 'text', requestId: this.requestId, content: dataStr }));
                }
            }
        }

        if (this.ws.readyState === 1 /* OPEN */) {
            this.ws.send(JSON.stringify({ type: 'done', requestId: this.requestId }));
        }
    }
}

/* ── handleChatConnection ───────────────────────────────────────────────
 * Called by index.js after wss.handleUpgrade completes for /api/chat/ws.
 * Manages keepalive, message dispatch, and lifecycle for one WS client.  */
function handleChatConnection(ws) {
    let abortController = null;
    let currentRequestId = null;

    // ── Keepalive ping every 30s ──
    const pingInterval = setInterval(() => {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'ping' }));
        } else {
            clearInterval(pingInterval);
        }
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
                    ws.send(JSON.stringify({ type: 'error', requestId, message: 'requestId and payload required' }));
                    return;
                }

                currentRequestId = requestId;
                abortController = new AbortController();

                const { model, messages, provider, effort, workspacePath } = payload;

                if (!model) {
                    ws.send(JSON.stringify({ type: 'error', requestId, message: 'model is required' }));
                    return;
                }
                if (!messages || !Array.isArray(messages)) {
                    ws.send(JSON.stringify({ type: 'error', requestId, message: 'messages array is required' }));
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
                    ws.send(JSON.stringify({ type: 'error', requestId, message: `API Key for provider '${resolvedProvider.displayName}' is not configured.` }));
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
                if (effort && (model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o'))) {
                    openaiPayload.reasoning_effort = effort === 'max' ? 'high' : effort;
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
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({ type: 'error', requestId, message: e.message }));
                    }
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
