// ── Logger & Request Tracking ──
// Tracks activity, requests, token consumption, and request details for the debug UI.

const fs = require('fs');
const path = require('path');
const { getConfig, getProfile } = require('./config');
const { dataPath } = require('./data-paths');
const { normalizeUsage } = require('../services/usage/usage-normalizer');
const { recordUsage } = require('../services/usage/usage-recorder');

const REQUEST_LOG_FILE = dataPath('request-log.json');
const DEFAULT_REQUEST_LOG_LIMIT = 5000;
const DEFAULT_PENDING_TIMEOUT_MINUTES = 10;
const MAX_ACTIVITY_LOG = 200;
const MAX_DETAILS = 100;

let activityLog = [];
let requestLog = loadRequestLog(); // Load persisted log on startup
let pendingRequests = new Map();
let persistTimer = null;

function getRequestLogPath() {
    try {
        if (fs.existsSync(REQUEST_LOG_FILE)) {
            const stats = fs.statSync(REQUEST_LOG_FILE);
            if (stats.isDirectory()) {
                return path.join(REQUEST_LOG_FILE, 'log.json');
            }
            return REQUEST_LOG_FILE;
        }
    } catch (e) {
        console.warn('[Logger] Failed to inspect request log path:', e.message);
    }
    return REQUEST_LOG_FILE;
}

function parseLegacyTimeString(timeValue) {
    if (!timeValue || typeof timeValue !== 'string') return 0;
    const trimmed = timeValue.trim();
    const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (!match) return 0;

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = parseInt(match[3] || '0', 10);
    const meridiem = (match[4] || '').toUpperCase();

    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;

    const now = new Date();
    return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        hours,
        minutes,
        seconds,
        0
    ).getTime();
}

function getEntryTimestamp(entry) {
    if (entry && Number.isFinite(entry.timestamp) && entry.timestamp > 0) return entry.timestamp;
    if (entry?.date) {
        const parsed = Date.parse(entry.date);
        if (Number.isFinite(parsed)) return parsed;
    }
    return parseLegacyTimeString(entry?.time);
}

function normalizeRequestEntry(entry) {
    const normalized = { ...(entry || {}) };
    normalized.inputTokens = Number(normalized.inputTokens || 0);
    normalized.outputTokens = Number(normalized.outputTokens || 0);
    normalized.totalTokens = Number(
        normalized.totalTokens || (normalized.inputTokens + normalized.outputTokens)
    );
    normalized.inputCostRate = Number(normalized.inputCostRate || 0);
    normalized.outputCostRate = Number(normalized.outputCostRate || 0);
    normalized.inputCost = Number(normalized.inputCost || 0);
    normalized.outputCost = Number(normalized.outputCost || 0);
    normalized.totalCost = Number(normalized.totalCost || (normalized.inputCost + normalized.outputCost));
    normalized.timestamp = getEntryTimestamp(normalized);
    normalized.date = normalized.date || (normalized.timestamp ? new Date(normalized.timestamp).toISOString() : null);
    normalized.requestType = normalized.requestType || 'unknown';
    normalized.status = normalized.status || 'unknown';
    normalized.model = normalized.model || 'unknown';
    return normalized;
}

function getRequestLogLimit() {
    const configured = Number.parseInt(getConfig()?.requestLogLimit, 10);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REQUEST_LOG_LIMIT;
}

function getPendingRequestTimeoutMs() {
    const configuredMinutes = Number.parseInt(getConfig()?.pendingRequestTimeoutMinutes, 10);
    const minutes = Number.isFinite(configuredMinutes) && configuredMinutes > 0
        ? configuredMinutes
        : DEFAULT_PENDING_TIMEOUT_MINUTES;
    return minutes * 60 * 1000;
}

function trimRequestLog() {
    const limit = getRequestLogLimit();
    if (requestLog.length > limit) {
        requestLog = requestLog.slice(0, limit);
    }
}

// ── File-based persistence for request log ──
function loadRequestLog() {
    const logPath = getRequestLogPath();
    try {
        if (fs.existsSync(logPath)) {
            const data = JSON.parse(fs.readFileSync(logPath, 'utf8'));
            if (Array.isArray(data)) {
                console.log(`[Logger] Loaded ${data.length} persisted request entries from ${logPath}`);
                const loaded = data
                    .map(normalizeRequestEntry)
                    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                return loaded.slice(0, getRequestLogLimit());
            }
        }
    } catch (e) {
        console.warn('[Logger] Failed to load request log from primary path:', e.message);
    }

    try {
        if (logPath !== REQUEST_LOG_FILE && fs.existsSync(REQUEST_LOG_FILE)) {
            const fallbackData = JSON.parse(fs.readFileSync(REQUEST_LOG_FILE, 'utf8'));
            if (Array.isArray(fallbackData)) {
                console.log(`[Logger] Loaded ${fallbackData.length} persisted request entries from ${REQUEST_LOG_FILE}`);
                const loaded = fallbackData
                    .map(normalizeRequestEntry)
                    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                return loaded.slice(0, getRequestLogLimit());
            }
        }
    } catch (e) {
        console.warn('[Logger] Failed to load request log from fallback path:', e.message);
    }
    return [];
}

function persistRequestLog() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        const logPath = getRequestLogPath();
        trimRequestLog();
        fs.mkdir(path.dirname(logPath), { recursive: true }, (mkdirErr) => {
            if (mkdirErr) {
                console.warn('[Logger] Failed to prepare request log directory:', mkdirErr.message);
                return;
            }
            fs.writeFile(logPath, JSON.stringify(requestLog, null, 2), (err) => {
                if (err) {
                    console.warn('[Logger] Failed to persist request log:', err.message);
                }
            });
        });
    }, 250);
}

// ── Request/Response capture for debug inspector ──
const requestDetails = new Map(); // reqId -> { requestBody, responseBody, thinking, toolCalls, error, inputTokens, outputTokens }

// ── SSE client management ──
const sseClients = new Set();

function normalizePeriodContext(context = {}) {
    const tzOffsetMinutes = Number.parseInt(context?.tzOffsetMinutes, 10);
    const parsedWeekStartsOn = Number.parseInt(context?.weekStartsOn, 10);
    return {
        tzOffsetMinutes: Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : new Date().getTimezoneOffset(),
        weekStartsOn: Number.isFinite(parsedWeekStartsOn) ? ((parsedWeekStartsOn % 7) + 7) % 7 : 0
    };
}

function getPeriodCutoff(period, context = {}) {
    const { tzOffsetMinutes, weekStartsOn } = normalizePeriodContext(context);
    const now = Date.now();
    if (period === 'all') return 0;

    const shiftedNow = now - (tzOffsetMinutes * 60 * 1000);
    const shiftedDate = new Date(shiftedNow);
    const year = shiftedDate.getUTCFullYear();
    const month = shiftedDate.getUTCMonth();
    const date = shiftedDate.getUTCDate();

    let shiftedCutoff = 0;
    switch (period) {
        case 'day':
            shiftedCutoff = Date.UTC(year, month, date);
            break;
        case 'week': {
            const dayOfWeek = shiftedDate.getUTCDay();
            const deltaDays = (dayOfWeek - weekStartsOn + 7) % 7;
            shiftedCutoff = Date.UTC(year, month, date - deltaDays);
            break;
        }
        case 'month':
            shiftedCutoff = Date.UTC(year, month, 1);
            break;
        case 'year':
            shiftedCutoff = Date.UTC(year, 0, 1);
            break;
        default:
            return 0;
    }

    return shiftedCutoff + (tzOffsetMinutes * 60 * 1000);
}

function addSSEClient(res, period = 'all', context = {}) {
    const client = { res, period: period || 'all', context: normalizePeriodContext(context) };
    sseClients.add(client);
    console.log(`[SSE] Client connected (total: ${sseClients.size}, period: ${client.period})`);
    // Send a snapshot immediately so the browser doesn't wait for the next event
    _sendSSEToClient(client, _buildSSEPayload(client.period, client.context));
}

function removeSSEClient(res) {
    for (const client of [...sseClients]) {
        if (client.res === res) {
            sseClients.delete(client);
        }
    }
    console.log(`[SSE] Client disconnected (total: ${sseClients.size})`);
}

function _buildSSEPayload(period = 'all', context = {}) {
    return {
        activity:  activityLog.slice(0, 30),
        pending:   getPendingRequests(),
        completed: getFilteredRequests(period, context).slice(0, 50),
        stats:     getStats(period, context)
    };
}

function _sendSSEToClient(client, payload) {
    try {
        client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
        sseClients.delete(client);
    }
}

let _broadcastTimer = null;
function broadcastSSE() {
    if (sseClients.size === 0) return;
    // Debounce: coalesce rapid-fire state changes into a single push
    if (_broadcastTimer) return;
    _broadcastTimer = setTimeout(() => {
        _broadcastTimer = null;
        if (sseClients.size === 0) return;
        for (const client of [...sseClients]) {
            _sendSSEToClient(client, _buildSSEPayload(client.period, client.context));
        }
    }, 100);
}

function logActivity(type, detail) {
    activityLog.unshift({
        time: new Date().toLocaleTimeString(),
        type: type,
        detail: detail
    });
    if (activityLog.length > MAX_ACTIVITY_LOG) activityLog.pop();
    broadcastSSE();
}

function getActivityLog() {
    return activityLog;
}

function finalizeRequest(id, start, result) {
    if (!start) return;

    const details = requestDetails.get(id);
    let inputTokens = result.inputTokens || 0;
    let outputTokens = result.outputTokens || 0;
    if (details && (!inputTokens || !outputTokens)) {
        inputTokens = details.inputTokens || 0;
        outputTokens = details.outputTokens || 0;
    }

    const profile = start.clientType === 'claude' || start.clientType === 'codex'
        ? getProfile(start.clientType)
        : null;
    const usage = normalizeUsage({
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        model: result.model || start.model || details?.model || 'unknown',
        provider: details?.provider || start.clientType,
        source: details?.source || 'request-log',
        requestType: details?.requestType || 'unknown',
        sessionId: details?.sessionId,
        requestId: id,
        inputCostPer1M: details?.inputCostPer1M || profile?.inputCostPer1M || 0,
        outputCostPer1M: details?.outputCostPer1M || profile?.outputCostPer1M || 0,
    });
    const inputCostRate = usage.inputCostPer1M;
    const outputCostRate = usage.outputCostPer1M;
    const inputCost = usage.inputCost;
    const outputCost = usage.outputCost;
    const endedAt = Date.now();

    const entry = {
        time: new Date(endedAt).toLocaleTimeString(),
        date: new Date(endedAt).toISOString(),
        timestamp: endedAt,
        clientType: start.clientType,
        endpoint: start.endpoint,
        model: usage.model,
        status: result.status,
        durationMs: endedAt - start.startTime,
        error: result.error || null,
        reqId: id,
        inputTokens,
        outputTokens,
        totalTokens: (inputTokens || 0) + (outputTokens || 0),
        inputCostRate,
        outputCostRate,
        inputCost,
        outputCost,
        totalCost: usage.totalCost,
        requestType: usage.requestType || (details ? details.requestType : 'unknown')
    };
    requestLog.unshift(normalizeRequestEntry(entry));
    trimRequestLog();
    persistRequestLog();

    if (details) {
        details.status = result.status === 'error' ? 'error' : 'completed';
        details.durationMs = entry.durationMs;
        if (result.error) details.error = result.error;
        details.inputTokens = inputTokens;
        details.outputTokens = outputTokens;
    }
}

function cleanupStalePendingRequests() {
    if (pendingRequests.size === 0) return false;
    const timeoutMs = getPendingRequestTimeoutMs();
    const now = Date.now();
    let cleaned = false;

    for (const [id, start] of pendingRequests.entries()) {
        if (!start?.startTime) continue;
        if ((now - start.startTime) < timeoutMs) continue;

        pendingRequests.delete(id);
        finalizeRequest(id, start, {
            status: 'error',
            model: start.model || 'unknown',
            error: `Request stayed pending for more than ${Math.round(timeoutMs / 60000)} minute(s)`
        });
        const details = requestDetails.get(id);
        if (details) details.error = details.error || 'Request expired while pending';
        cleaned = true;
    }

    if (cleaned) broadcastSSE();
    return cleaned;
}

// ── Request tracking for multi-client monitoring ──
function startRequest(info) {
    cleanupStalePendingRequests();
    const id = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    pendingRequests.set(id, { ...info, startTime: Date.now() });
    broadcastSSE();
    return id;
}

function endRequest(id, result) {
    const start = pendingRequests.get(id);
    if (!start) return;
    pendingRequests.delete(id);
    finalizeRequest(id, start, result);
    broadcastSSE(); // push update to all connected UI clients
}

function getRequestLog() {
    cleanupStalePendingRequests();
    return requestLog;
}

function getPendingRequests() {
    cleanupStalePendingRequests();
    return Array.from(pendingRequests.entries()).map(([reqId, r]) => ({
        reqId,
        clientType: r.clientType,
        endpoint: r.endpoint,
        model: r.model || 'unknown',
        elapsedMs: Date.now() - r.startTime
    }));
}

// ── Time-based filtering ──
function getFilteredRequests(period, context = {}) {
    cleanupStalePendingRequests();
    const cutoff = getPeriodCutoff(period, context);
    if (!cutoff) return requestLog;
    return requestLog.filter(r => getEntryTimestamp(r) >= cutoff);
}

function getStats(period, context = {}) {
    cleanupStalePendingRequests();
    const filtered = getFilteredRequests(period, context);
    const completed = filtered.filter(r => r.status === 'success' || r.status === 'completed');
    const errors = filtered.filter(r => r.status === 'error');
    const profileRates = {
        claude: getProfile('claude'),
        codex: getProfile('codex')
    };

    function getEstimatedCosts(entry) {
        const activeProfile = entry?.clientType === 'claude' || entry?.clientType === 'codex'
            ? profileRates[entry.clientType]
            : null;
        const inputRate = Number(entry?.inputCostRate || activeProfile?.inputCostPer1M || 0);
        const outputRate = Number(entry?.outputCostRate || activeProfile?.outputCostPer1M || 0);
        const inputCost = entry?.inputCost || (inputRate > 0 ? ((entry?.inputTokens || 0) / 1000000) * inputRate : 0);
        const outputCost = entry?.outputCost || (outputRate > 0 ? ((entry?.outputTokens || 0) / 1000000) * outputRate : 0);
        return {
            inputCost,
            outputCost,
            totalCost: inputCost + outputCost
        };
    }

    // Calculate most used model
    const modelCounts = {};
    filtered.forEach(r => {
        const m = r.model || 'unknown';
        modelCounts[m] = (modelCounts[m] || 0) + 1;
    });
    let mostUsedModel = null;
    let mostUsedCount = 0;
    for (const [model, count] of Object.entries(modelCounts)) {
        if (count > mostUsedCount) {
            mostUsedModel = model;
            mostUsedCount = count;
        }
    }

    // Calculate tokens per model
    const modelTokenStats = {};
    filtered.forEach(r => {
        const m = r.model || 'unknown';
        if (!modelTokenStats[m]) modelTokenStats[m] = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        modelTokenStats[m].requests++;
        modelTokenStats[m].inputTokens += (r.inputTokens || 0);
        modelTokenStats[m].outputTokens += (r.outputTokens || 0);
        modelTokenStats[m].totalTokens += ((r.inputTokens || 0) + (r.outputTokens || 0));
    });

    // Per-profile breakdown
    const profileStats = {};
    ['claude', 'codex'].forEach(profile => {
        const profileReqs = filtered.filter(r => r.clientType === profile);
        const costs = profileReqs.map(getEstimatedCosts);
        profileStats[profile] = {
            inputTokens: profileReqs.reduce((sum, r) => sum + (r.inputTokens || 0), 0),
            outputTokens: profileReqs.reduce((sum, r) => sum + (r.outputTokens || 0), 0),
            inputCost: costs.reduce((sum, c) => sum + c.inputCost, 0),
            outputCost: costs.reduce((sum, c) => sum + c.outputCost, 0),
            totalCost: costs.reduce((sum, c) => sum + c.totalCost, 0)
        };
    });

    return {
        totalRequests: filtered.length,
        completedRequests: completed.length,
        errorRequests: errors.length,
        totalInputTokens: filtered.reduce((sum, r) => sum + (r.inputTokens || 0), 0),
        totalOutputTokens: filtered.reduce((sum, r) => sum + (r.outputTokens || 0), 0),
        totalTokens: filtered.reduce((sum, r) => sum + ((r.inputTokens || 0) + (r.outputTokens || 0)), 0),
        estimatedInputCost: filtered.reduce((sum, r) => sum + getEstimatedCosts(r).inputCost, 0),
        estimatedOutputCost: filtered.reduce((sum, r) => sum + getEstimatedCosts(r).outputCost, 0),
        estimatedTotalCost: filtered.reduce((sum, r) => sum + getEstimatedCosts(r).totalCost, 0),
        avgDurationMs: filtered.length > 0
            ? Math.round(filtered.reduce((sum, r) => sum + (r.durationMs || 0), 0) / filtered.length)
            : 0,
        pendingRequests: pendingRequests.size,
        mostUsedModel: mostUsedModel,
        mostUsedCount: mostUsedCount,
        modelBreakdown: modelTokenStats,
        profileStats
    };
}

// ── Determine request type from parsed request body ──
function determineRequestType(body) {
    if (!body || typeof body !== 'object') return 'unknown';

    // Anthropic messages API
    if (Array.isArray(body.tools) && body.tools.length > 0) return 'Tool Use';
    if (Array.isArray(body.messages) && body.messages.some(m => m.role === 'tool')) return 'Tool Use';
    if (body.system) return 'System';

    // OpenAI chat completions
    if (Array.isArray(body.tools) && body.tools.length > 0) return 'Tool Use';
    const msgs = body.messages || [];
    if (msgs.some(m => m.role === 'tool')) return 'Tool Use';
    if (msgs.some(m => m.role === 'system')) return 'System';
    if (msgs.some(m => m.role === 'assistant' && (m.tool_calls || m.content))) return 'Multi-turn';

    return 'Chat';
}

function extractSessionId(requestBody) {
    if (!requestBody || typeof requestBody !== 'object') return '';
    return String(requestBody.sessionId || requestBody.session_id || requestBody.metadata?.sessionId || requestBody.metadata?.session_id || '');
}

// ── Capture request/response details for debug inspector ──
function captureRequest(reqId, requestBody, metadata = {}) {
    const requestType = determineRequestType(requestBody);
    requestDetails.set(reqId, {
        reqId,
        timestamp: new Date().toLocaleTimeString(),
        date: new Date().toISOString(),
        requestBody: sanitizeForDisplay(requestBody),
        requestType,
        responseBody: null,
        thinking: null,
        toolCalls: null,
        finishReason: null,
        error: null,
        status: 'pending',
        inputTokens: 0,
        outputTokens: 0,
        model: metadata.model || requestBody?.model || 'unknown',
        provider: metadata.provider || requestBody?.provider || '',
        source: metadata.source || 'adapter',
        sessionId: metadata.sessionId || extractSessionId(requestBody),
        inputCostPer1M: metadata.inputCostPer1M || 0,
        outputCostPer1M: metadata.outputCostPer1M || 0,
    });
    // Keep only last N
    if (requestDetails.size > MAX_DETAILS) {
        const firstKey = requestDetails.keys().next().value;
        requestDetails.delete(firstKey);
    }
}

function captureResponse(reqId, responseData) {
    const details = requestDetails.get(reqId);
    if (!details) return;
    details.responseBody = sanitizeForDisplay(responseData);
    details.status = 'completed';

    // Extract token usage — handles both OpenAI and Anthropic native shapes
    const usage = responseData?.usage;
    if (usage) {
        // OpenAI: prompt_tokens / completion_tokens
        // Anthropic: input_tokens / output_tokens
        const input  = usage.prompt_tokens  || usage.input_tokens  || 0;
        const output = usage.completion_tokens || usage.output_tokens || 0;
        if (input  > 0) details.inputTokens  = input;
        if (output > 0) details.outputTokens = output;
    }

    // Extract thinking/reasoning (OpenAI adapter path)
    const choice = responseData.choices?.[0];
    const msg = choice?.message;
    if (msg?.reasoning || msg?.reasoning_content) {
        details.thinking = msg.reasoning || msg.reasoning_content;
    } else if (Array.isArray(msg?.reasoning_details)) {
        const reasoningText = msg.reasoning_details
            .map(detail => detail?.text || detail?.thinking || '')
            .filter(Boolean)
            .join('\n\n');
        if (reasoningText) details.thinking = reasoningText;
    }
    if (msg?.tool_calls && msg.tool_calls.length > 0) {
        details.toolCalls = msg.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments
        }));
    }
    if (choice?.finish_reason) {
        details.finishReason = choice.finish_reason;
    }

    // Extract thinking/tool info from Anthropic native format
    if (Array.isArray(responseData.content)) {
        const thinkingBlocks = responseData.content
            .filter(b => b.type === 'thinking' && b.thinking)
            .map(b => b.thinking);
        if (thinkingBlocks.length > 0) details.thinking = thinkingBlocks.join('\n\n');

        const toolBlocks = responseData.content.filter(b => b.type === 'tool_use');
        if (toolBlocks.length > 0) {
            details.toolCalls = toolBlocks.map(b => ({
                id: b.id,
                name: b.name,
                arguments: JSON.stringify(b.input || {})
            }));
        }
        if (responseData.stop_reason) details.finishReason = responseData.stop_reason;
    }
}

// Allows adapters to push token counts into an existing detail entry after the fact
function captureTokens(reqId, inputTokens, outputTokens) {
    const details = requestDetails.get(reqId);
    if (!details) return;
    if (inputTokens  > 0) details.inputTokens  = inputTokens;
    if (outputTokens > 0) details.outputTokens = outputTokens;

    const totalTokens = (inputTokens || 0) + (outputTokens || 0);
    if (totalTokens <= 0) return;
    recordUsage({
        sessionId: details.sessionId,
        requestId: reqId,
        source: details.source || 'adapter',
        requestType: details.requestType,
        model: details.model || 'unknown',
        provider: details.provider || 'unknown',
        inputTokens,
        outputTokens,
        totalTokens,
        inputCostPer1M: details.inputCostPer1M || 0,
        outputCostPer1M: details.outputCostPer1M || 0,
        metadata: { logger: true },
    });
}

function captureError(reqId, error) {
    const details = requestDetails.get(reqId);
    if (!details) return;
    details.error = error.message || String(error);
    details.status = 'error';
}

function getRequestDetails(period, context = {}) {
    let details = Array.from(requestDetails.values()).reverse();
    if (!period || period === 'all') return details;
    const cutoff = getPeriodCutoff(period, context);
    return details.filter(d => new Date(d.date).getTime() >= cutoff);
}

function getRequestDetail(reqId) {
    return requestDetails.get(reqId) || null;
}

// Sanitize sensitive data before storing/displaying
function sanitizeForDisplay(data) {
    if (!data) return data;
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    // Redact API keys
    return str.replace(/"(api[_-]?key|authorization|token)"\s*:\s*"[^"]*"/gi, '"$1": "***"');
}

// ── Conversation grouping ──
function getConversations(period, context = {}) {
    cleanupStalePendingRequests();
    const logs = getFilteredRequests(period, context);
    const grouped = {};
    for (const entry of logs) {
        const client = entry.clientType || 'unknown';
        if (!grouped[client]) grouped[client] = [];
        const details = requestDetails.get(entry.reqId);
        let messages = null;
        let response = null;
        if (details) {
            try {
                const reqBody = typeof details.requestBody === 'string' ? JSON.parse(details.requestBody) : details.requestBody;
                if (reqBody?.messages) messages = reqBody.messages;
                else if (reqBody?.system) messages = [{ role: 'system', content: typeof reqBody.system === 'string' ? reqBody.system : JSON.stringify(reqBody.system) }];

                const resBody = typeof details.responseBody === 'string' ? JSON.parse(details.responseBody) : details.responseBody;
                if (resBody) response = resBody;
            } catch {}
        }
        grouped[client].push({
            ...entry,
            details: details ? {
                messages,
                response,
                thinking: details.thinking,
                toolCalls: details.toolCalls,
                finishReason: details.finishReason,
                error: details.error
            } : null
        });
    }
    return grouped;
}

module.exports = {
    logActivity, getActivityLog,
    startRequest, endRequest, getRequestLog, getPendingRequests,
    getFilteredRequests, getStats,
    captureRequest, captureResponse, captureTokens, captureError, getRequestDetails, getRequestDetail,
    getConversations,
    addSSEClient, removeSSEClient
};
