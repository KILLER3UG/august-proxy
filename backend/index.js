const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const { getConfig, saveConfig, getProfile, saveProfile, getBookmarks, saveBookmark, deleteBookmark } = require('./lib/config');
const { getActivityLog, startRequest, endRequest, getRequestLog, getPendingRequests, getFilteredRequests, getStats, getRequestDetails, getRequestDetail, getConversations, addSSEClient, removeSSEClient, emitLogEvent, getRecentLogEvents, addLogWSClient, removeLogWSClient } = require('./lib/logger');
const anthropicAdapter = require('./adapters/anthropic');
const openaiAdapter = require('./adapters/openai');
const { getMcpServerStatus, restartMcpServers, startMcpServers } = require('./services/tools/mcp-client');
const { deleteMcpServer, getMcpServersForUi, saveCustomMcpServer, setMcpServerEnabled } = require('./services/tools/mcp-registry');
const { deleteSkill, getSkills, getTeamSkills, saveSkill } = require('./services/tools/skills');
const { deletePlugin, getPlugins, setPluginEnabled } = require('./services/tools/plugins');
const { readJsonBody, sendError, sendJson } = require('./lib/http-utils');
const { redactForDisplay, maskSecretValue } = require('./lib/redact');
const { DEFAULT_CONTEXT_MAX_CHARS, buildSystemPromptDetails } = require('./services/memory/context-builder');
const { identifyClient } = require('./lib/client-identity');
const { executeManagedWebTool } = require('./services/tools/local-web');
const { createHostFilesFolder, getCompatibilityStatus } = require('./services/monitoring/compatibility');
const { importCapabilityLink } = require('./services/tools/link-importer');
const { importSkillFromLink } = require('./services/tools/skill-importer');
const { getCapabilityHealth } = require('./services/monitoring/health');
const { handleMemoryRoutes } = require('./routes/memory-routes');
const { answerWorkbenchBtw, approveWorkbenchPlan, consumePendingMutation, createWorkbenchSession, executeWorkbenchTool, getWorkbenchGoalStatus, getWorkbenchSession, listAgentRegistry, listProxyCapabilities, listWorkbenchSessions, normalizeGuardMode, resetWorkbenchSession, saveSessions, sendWorkbenchMessageStream, summarizeSession, updateWorkbenchGoal } = require('./services/workbench/workbench');
const agentRegistry = require('./services/tools/agent-registry');
const agentSessions = require('./services/tools/agent-sessions');
const terminalService = require('./services/workbench/terminal-service');
const automationJobs = require('./services/workbench/automation-jobs');
const hostAgent = require('./lib/host-agent');
const { listProviders, getProvider } = require('./providers/provider-registry');
const { registerBuiltinProviders } = require('./providers/builtin');
const { resolveProvider, resolveActiveProvider } = require('./providers/provider-resolver');
const { getActiveProvider, setActiveProvider, getProviderConfig, saveProviderConfig, getEnvVars, setEnvVar, deleteEnvVar, getProviderRequiredEnvVars } = require('./lib/config');

const activeGenerations = new Map();

const MCP_GLOBAL_ENV_KEYS = [
  { key: 'GOOGLE_OAUTH_CLIENT_ID', sensitive: false },
  { key: 'GOOGLE_OAUTH_CLIENT_SECRET', sensitive: true },
  { key: 'GOOGLE_OAUTH_REDIRECT_URI', sensitive: false }
];

function getMcpGlobalEnvForUi() {
  return MCP_GLOBAL_ENV_KEYS.map(({ key, sensitive }) => {
    const value = process.env[key] || '';
    return {
      key,
      value: sensitive && value ? maskSecretValue(value) : value,
      set: !!value,
      sensitive,
      masked: sensitive && !!value
    };
  });
}

function updateMcpGlobalEnvFromUi(entries = []) {
  const current = getMcpGlobalEnvForUi();
  for (const entry of entries) {
    const key = String(entry.key || '').trim();
    if (!key) continue;
    const value = String(entry.value ?? '');
    const existing = current.find(item => item.key === key);
    if (existing?.sensitive && existing.masked && value === existing.value) {
      continue;
    }
    setEnvVar(key, value);
  }
}

// ── New Module Imports: Storage, Tools, MCP OAuth, Cron ──
const sessionStore = require('./services/storage/session-store');
const toolRegistry = require('./services/tools/tool-registry');
const mcpOAuth = require('./services/tools/mcp-oauth');
const { readCronJobs, createCronJobHandler, removeCronJobHandler, runCronJobNowHandler, runDueCronJobs } = require('./services/tools/missing/cron-tools');
const scheduler = require('./services/scheduler');
const { registerMissingTools } = require('./services/tools/missing/index');
const { registerBrowserTools, cleanup: cleanupBrowserTools } = require('./services/tools/browser-tools');
const { registerVisionTools } = require('./services/tools/vision-tools');
const { registerDelegateTools } = require('./services/tools/delegate-tools');
const { registerExecuteTools } = require('./services/tools/execute-tools');
const { handleServiceConnectionRoutes } = require('./services/tools/service-connections');
const chatEventLog = require('./services/workbench/chat-event-log');

// ── New SPA (Vite/React/Tailwind v4) ──
// The React SPA in web-dist/ is the only user UI. All non-API GET requests serve it.
const WEB_DIST = path.join(__dirname, '..', 'web-dist');
const WEB_INDEX = path.join(WEB_DIST, 'index.html');
const LISTEN_PORT = Number(process.env.AUGUST_PROXY_PORT || process.env.PORT || 8080);
const MAX_CONTEXT_MAX_CHARS = 64000;

// Serve the new Vite/React SPA from web-dist/. Strips /v2 or /ui-v2
// from the path, or rewrites /v2-assets/* → /assets/*.
function serveSpa(req, res, url, isAsset) {
    let relPath = '';
    if (url.pathname.startsWith('/v2-assets/'))        relPath = url.pathname.slice('/v2-assets/'.length);
    else if (url.pathname.startsWith('/ui-v2-assets/'))  relPath = url.pathname.slice('/ui-v2-assets/'.length);
    else if (url.pathname.startsWith('/v2/'))           relPath = url.pathname.slice('/v2/'.length);
    else if (url.pathname.startsWith('/ui-v2/'))         relPath = url.pathname.slice('/ui-v2/'.length);
    else if (url.pathname === '/v2' || url.pathname === '/ui-v2') relPath = '';

    // Don't serve anything outside web-dist (path traversal guard)
    if (relPath.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Bad request');
    }

    // Map the root to index.html (SPA history routing)
    const filePath = relPath === '' || relPath === '/'
        ? WEB_INDEX
        : path.join(WEB_DIST, relPath);

    if (!fs.existsSync(filePath)) {
        // SPA fallback: unknown path → index.html (so React Router can handle it)
        if (!isAsset) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(fs.readFileSync(WEB_INDEX, 'utf8'));
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found: ' + relPath);
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = {
        '.html': 'text/html; charset=utf-8',
        '.js':   'application/javascript; charset=utf-8',
        '.mjs':  'application/javascript; charset=utf-8',
        '.css':  'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg':  'image/svg+xml',
        '.png':  'image/png',
        '.jpg':  'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif':  'image/gif',
        '.ico':  'image/x-icon',
        '.woff': 'font/woff',
        '.woff2':'font/woff2',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(filePath));
}

function summarizeRequestHeaders(headers) {
    const result = {};
    Object.entries(headers || {}).forEach(([key, value]) => {
        const lowered = String(key || '').toLowerCase();
        if (lowered.includes('auth') || lowered.includes('key') || lowered.includes('token') || lowered.includes('cookie')) return;
        result[key] = value;
    });
    return result;
}

function getPeriodContext(url) {
    return {
        tzOffsetMinutes: url.searchParams.get('tzOffsetMinutes'),
        weekStartsOn: url.searchParams.get('weekStartsOn')
    };
}

function stripKnownSuffixes(value) {
    return value
        .replace(/\/v1\/messages$/i, '')
        .replace(/\/messages$/i, '')
        .replace(/\/v1\/chat\/completions$/i, '')
        .replace(/\/chat\/completions$/i, '')
        .replace(/\/v1\/responses$/i, '')
        .replace(/\/responses$/i, '')
        .replace(/\/v1\/models$/i, '')
        .replace(/\/models$/i, '');
}

function normalizeOpenAIBaseUrl(baseUrl) {
    let normalized = stripKnownSuffixes((baseUrl || '').trim());
    if (!normalized) return '';
    if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    if (/^https:\/\/api\.minimax\.io\/anthropic$/i.test(normalized)) {
        return 'https://api.minimax.io/v1';
    }
    // Special case: Google AI Studio's OpenAI-compat base already ends in /openai
    // Adding /v1 would break all downstream URLs (chat/completions, models, etc.)
    if (/generativelanguage\.googleapis\.com/i.test(normalized) && /\/openai$/i.test(normalized)) {
        return normalized;
    }
    if (!/\/v\d+$/i.test(normalized) && !/\/api\/v\d+$/i.test(normalized)) normalized += '/v1';
    return normalized;
}

function normalizeAnthropicBaseUrl(baseUrl) {
    let normalized = stripKnownSuffixes((baseUrl || '').trim());
    if (!normalized) return '';
    if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    if (/^https:\/\/api\.minimax\.io\/v\d+$/i.test(normalized)) {
        return 'https://api.minimax.io/anthropic';
    }
    if (/^https:\/\/api\.anthropic\.com$/i.test(normalized)) {
        return 'https://api.anthropic.com';
    }
    if (/\/v\d+$/i.test(normalized)) {
        return normalized.replace(/\/v\d+$/i, '');
    }
    return normalized;
}

function buildTargetUrlForProfile(profile, baseUrl) {
    const lowerBase = (baseUrl || '').toLowerCase();
    // Detect if this is likely an OpenAI-compatible endpoint even if we're in the Claude profile
    const isOpenAIHint = lowerBase.includes('openai.com') ||
        lowerBase.includes('openrouter.ai') ||
        lowerBase.includes('groq.com') ||
        lowerBase.includes('completions') ||
        lowerBase.includes('localhost:11434'); // Ollama default

    if (profile === 'claude' && !isOpenAIHint) {
        const anthropicBase = normalizeAnthropicBaseUrl(baseUrl);
        if (!anthropicBase) return '';
        return `${anthropicBase}/v1/messages`;
    }

    const openaiBase = normalizeOpenAIBaseUrl(baseUrl);
    if (!openaiBase) return '';
    if (/^https:\/\/api\.minimax\.io\/v\d+$/i.test(openaiBase)) {
        return 'https://api.minimax.io/v1/text/chatcompletion_v2';
    }
    return `${openaiBase}/chat/completions`;
}

function buildModelsUrl(baseUrl) {
    const openaiBase = normalizeOpenAIBaseUrl(baseUrl);
    if (!openaiBase) return '';
    return `${openaiBase}/models`;
}

function buildTestPayload(profile, model) {
    if (profile === 'claude') {
        return {
            model,
            max_tokens: 1024,
            messages: [{ role: 'user', content: 'respond with only the word "WORKING"' }]
        };
    }

    return {
        model,
        messages: [{ role: 'user', content: 'respond with only the word "WORKING"' }]
    };
}

function buildAuthHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (!apiKey) return headers;
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
    return headers;
}

function buildTestHeaders(profile, apiKey) {
    const headers = buildAuthHeaders(apiKey);
    if (profile === 'claude') {
        headers['anthropic-version'] = '2023-06-01';
    }
    return headers;
}

const requestHandler = async (req, res) => {
    // ── URL normalization ──
    const originalUrl = req.url;
    let cleanPath = originalUrl
        .replace(/^\/v1\/v1\//, '/v1/')
        .replace(/^\/v1\/messages/, '/v1/messages');

    if (originalUrl.includes('/v1/')) {
        console.log(`[Proxy Incoming]: ${req.method} ${originalUrl} -> Normalized: ${cleanPath}`);
        try { emitLogEvent({ category: 'proxy_incoming', level: 'info', message: `${req.method} ${originalUrl} → ${cleanPath}`, metadata: { method: req.method, url: originalUrl, normalized: cleanPath } }); } catch (_) {}
    }
    if ((req.headers['user-agent'] || '').toLowerCase().includes('claude')) {
        console.log('[Proxy Debug Bridge Claude Headers]:', JSON.stringify({
            method: req.method,
            url: originalUrl,
            normalized: cleanPath,
            headers: summarizeRequestHeaders(req.headers)
        }));
    }

    // ── UI endpoints ──
    // Parse URL once so we can match on pathname (ignoring query string).
    // req.url includes ?query, so `req.url === '/'` is false for any URL with
    // a query string. Use `url.pathname` to match routes regardless of ?foo=bar.
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // ── SPA (Vite/React) ──────────────────────────────────────────
    // The React SPA handles its own routing client-side. We serve it for
    // every non-API GET request.
    if (req.method === 'GET' && fs.existsSync(WEB_INDEX)) {
        const isApiRoute = url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/ui/');
        if (!isApiRoute) {
            const isAsset = url.pathname.startsWith('/v2-assets/') || url.pathname.startsWith('/ui-v2-assets/') || url.pathname.includes('/assets/');
            return serveSpa(req, res, url, isAsset);
        }
    }

    if (req.url === '/favicon.ico' && req.method === 'GET') {
        res.writeHead(204);
        return res.end();
    }

    // ── Brain config (must come BEFORE the memory-routes catch-all which would 404 /ui/brain/*) ──
    if (req.url === '/ui/brain/config' || req.url.startsWith('/ui/brain/config?')) {
        if (req.method === 'GET') {
            try {
                const { getBrainConfigForSettings, listWorkbenchSessions } = require('./services/memory/brain-orchestrator');
                const { getWorkbenchSession } = require('./services/workbench/workbench');
                let sessionId = null;
                try {
                    const recent = (listWorkbenchSessions() || [])[0];
                    if (recent && recent.id) sessionId = recent.id;
                } catch (_) { /* no sessions yet */ }
                const payload = getBrainConfigForSettings({ sessionId });
                const sessionPayload = sessionId ? getWorkbenchSession(sessionId) : null;
                return sendJson(res, { ...payload, sessionId, session: sessionPayload ? { id: sessionPayload.id, task: sessionPayload.task || sessionPayload.lastGoal || null } : null });
            } catch (e) { return sendError(res, e, 500); }
        }
        if (req.method === 'PUT') {
            try {
                const body = await readJsonBody(req);
                const { saveBrainConfig, DEFAULT_FEATURES } = require('./services/memory/brain-orchestrator');
                const merged = saveBrainConfig(body || {});
                try {
                    const audit = require('./services/audit/audit-log');
                    audit.appendAuditEntry({
                        actor: 'user', action: 'brain_config_update', category: 'config',
                        target: 'cfg.brainOrchestrator', args: { before: body || {}, after: merged }, result: 'ok'
                    });
                } catch (_) {}
                return sendJson(res, { ok: true, config: merged, defaults: DEFAULT_FEATURES });
            } catch (e) {
                if (e && e.code === 'EBRAIN_UNKNOWN_KEY') return sendError(res, e, 400);
                return sendError(res, e, 400);
            }
        }
    }
    if ((req.url === '/ui/brain/config/reset' || req.url.startsWith('/ui/brain/config/reset?')) && req.method === 'POST') {
        try {
            const { resetBrainConfig, DEFAULT_FEATURES } = require('./services/memory/brain-orchestrator');
            const next = resetBrainConfig();
            try {
                const audit = require('./services/audit/audit-log');
                audit.appendAuditEntry({
                    actor: 'user', action: 'brain_config_update', category: 'config',
                    target: 'cfg.brainOrchestrator', args: { action: 'reset', after: next }, result: 'ok'
                });
            } catch (_) {}
            return sendJson(res, { ok: true, config: next, defaults: DEFAULT_FEATURES });
        } catch (e) { return sendError(res, e, 500); }
    }
    if (req.url.startsWith('/ui/brain/config/from-session') && req.method === 'GET') {
        try {
            const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const sessionId = parsed.searchParams.get('sessionId');
            if (!sessionId) return sendJson(res, { error: 'sessionId query param is required' }, 400);
            const { getBrainConfigForSettings } = require('./services/memory/brain-orchestrator');
            return sendJson(res, getBrainConfigForSettings({ sessionId }));
        } catch (e) { return sendError(res, e, 500); }
    }

    if (await handleMemoryRoutes(req, res, req.url)) return;

    // ── Agents tree API ───────────────────────────────────────────────
    if (req.url.startsWith('/ui/agents/')) {
        const { handleAgentsRoutes } = require('./routes/agents-routes');
        const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const handled = handleAgentsRoutes(req, res, parsed.pathname, parsed);
        if (handled !== false) return;
    }

    if (req.url === '/ui/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getConfig()));
    }

    if (req.url === '/ui/config/safe' && req.method === 'GET') {
        return sendJson(res, redactForDisplay(getConfig()));
    }

    
    // ── Provider management API ──
    if (req.url === '/api/config/activeProvider' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const providerName = String(body.provider || '').trim();
        if (!providerName) return sendError(res, new Error('provider name required'), 400);
        setActiveProvider(providerName);
        return sendJson(res, { status: 'ok', activeProvider: providerName });
    }

    if (req.url === '/api/providers/health' && req.method === 'GET') {
        const { probeAllProviders } = require('./lib/provider-health');
        const force = (() => {
            try { return new URL(req.url, 'http://x').searchParams.get('force') === '1'; } catch { return false; }
        })();
        probeAllProviders({ force })
            .then((results) => sendJson(res, { results, at: Date.now() }))
            .catch((err) => sendError(res, err, 500));
        return;
    }

    if (req.url.startsWith('/api/usage/')) {
        try {
            const { handleUsageRoutes } = require('./services/usage/usage-routes');
            if (handleUsageRoutes(req, res)) return;
        } catch (err) {
            return sendError(res, err, 500);
        }
    }

    if (req.url.startsWith('/api/providers')) {
        try {
            const { handleProvidersRoutes } = require('./services/providers/providers-routes');
            const handled = await Promise.resolve(handleProvidersRoutes(req, res));
            if (handled) return;
        } catch (err) {
            return sendError(res, err, 500);
        }
    }

    if (req.url.startsWith('/api/git/')) {
        try {
            const { handleGitRoutes } = require('./services/git/git-routes');
            const handled = await Promise.resolve(handleGitRoutes(req, res));
            if (handled) return;
        } catch (err) {
            return sendError(res, err, 500);
        }
    }

    if (req.url.startsWith('/api/providers/quota') && req.method === 'GET') {
        const { getAllQuotas, getDailyQuota } = require('./services/providers/quota-store');
        const url = new URL(req.url, 'http://x');
        const provider = url.searchParams.get('provider');
        try {
            if (provider) {
                const model = url.searchParams.get('model');
                if (model) {
                    sendJson(res, await getDailyQuota(provider, model));
                } else {
                    sendJson(res, { results: await getAllQuotas(provider) });
                }
            } else {
                // All providers
                const { listProviders } = require('./providers/provider-registry');
                const all = await Promise.all(listProviders().map(async (p) => ({
                    provider: p.name,
                    quotas: await getAllQuotas(p.name),
                })));
                sendJson(res, { results: all });
            }
            return;
        } catch (err) {
            return sendError(res, err, 500);
        }
    }

    if (req.url === '/api/config/activeProvider' && req.method === 'GET') {
        const { getProviderConfig } = require('./lib/config');
        return sendJson(res, { 
            activeProvider: getActiveProvider(), 
            providers: listProviders().map(p => {
                const cfg = getProviderConfig(p.name) || {};
                const key = cfg.apiKey || '';
                const hasKey = !!(p.isAvailable() || key);
                const redacted = key ? key.slice(0, 3) + '••••••••' + key.slice(-4) : null;
                return { 
                    id: p.name, 
                    name: p.displayName, 
                    apiMode: p.apiMode, 
                    isAvailable: hasKey,
                    redactedKey: redacted
                };
            })
        });
    }

    if (req.url.startsWith('/api/config/provider-details') && req.method === 'GET') {
        const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
        const providerName = url.searchParams.get('provider') || getActiveProvider();
        const profile = getProvider(providerName);
        if (!profile) return sendError(res, new Error("Provider '" + providerName + "' not found"), 404);
        const providerCfg = getProviderConfig(providerName) || {};
        const resolved = resolveProvider(providerName, providerCfg);
        return sendJson(res, {
            id: profile.name,
            name: profile.displayName,
            description: profile.description,
            baseUrl: resolved ? resolved.baseUrl : profile.resolveBaseUrl(),
            apiMode: profile.apiMode,
            authType: profile.authType,
            envVars: profile.envVars,
            envStatus: profile.envVars.reduce((acc, v) => { acc[v] = !!process.env[v]; return acc; }, {}),
            isAvailable: profile.isAvailable(),
            defaultModel: profile.defaultModel,
            signupUrl: profile.signupUrl,
            supportsHealthCheck: profile.supportsHealthCheck,
            isActive: providerName === getActiveProvider(),
            configOverrides: providerCfg,
            modelProfiles: profile._modelProfiles ? Object.keys(profile._modelProfiles).filter(k => k !== '*') : [],
        });
    }

    if (req.url.startsWith('/api/config/provider-details') && req.method === 'POST') {
        const body = await readJsonBody(req);
        const providerName = String(body.provider || '').trim();
        if (!providerName) return sendError(res, new Error('provider name required'), 400);
        const profile = getProvider(providerName);
        if (!profile) return sendError(res, new Error("Provider '" + providerName + "' not found"), 404);
        const existing = getProviderConfig(providerName) || {};
        const updated = { ...existing, ...body.config };
        if (body.config?.targetUrl) updated.targetUrl = body.config.targetUrl;
        if (body.config?._upstreamModel) updated._upstreamModel = body.config._upstreamModel;
        if (body.setActive) setActiveProvider(providerName);
        saveProviderConfig(providerName, updated);
        return sendJson(res, { status: 'ok', provider: providerName, config: updated });
    }

    // ── User-defined model aliases ──
    if (req.url === '/api/config/model-aliases' && req.method === 'GET') {
        const cfg = getConfig();
        const rawAliases = cfg.modelAliases || [];
        // Also expose the prettified display alias (the one shown in the
        // chat dropdown, e.g. "Opus 4.7-Alias") so the frontend can map
        // the prettified name recorded in usage events back to the backend
        // model. Without this, the observability page only sees the
        // canonical id (e.g. "claude-opus-4.7") while usage events record
        // the prettified name — the two never match.
        let displayAliasFor = null;
        try {
            const { getModelDisplayAlias } = require('./providers/model-list');
            displayAliasFor = getModelDisplayAlias;
        } catch (_) { /* optional */ }
        const aliases = rawAliases.map(a => {
            const displayAlias = displayAliasFor && a.alias
                ? displayAliasFor({ id: a.alias, provider: 'Alias' })
                : '';
            return {
                alias: a.alias,
                targetModel: a.targetModel,
                targetProvider: a.targetProvider,
                displayAlias: displayAlias || a.alias,
            };
        });
        return sendJson(res, { aliases });
    }

    if (req.url === '/api/config/model-aliases' && req.method === 'PUT') {
        try {
            const body = await readJsonBody(req);
            const cfg = getConfig();
            cfg.modelAliases = Array.isArray(body.aliases) ? body.aliases : [];
            saveConfig(cfg);
            return sendJson(res, { ok: true, aliases: cfg.modelAliases });
        } catch (e) { return sendError(res, e, 500); }
    }

    // ── Sub-agent fallback settings ──
    if (req.url === '/api/config/subagent-fallback' && req.method === 'GET') {
        const cfg = getConfig();
        return sendJson(res, { config: cfg.subAgentFallback || {} });
    }

    if (req.url === '/api/config/subagent-fallback' && req.method === 'PUT') {
        try {
            const body = await readJsonBody(req);
            const cfg = getConfig();
            cfg.subAgentFallback = body.config && typeof body.config === 'object' ? body.config : {};
            saveConfig(cfg);
            return sendJson(res, { ok: true, config: cfg.subAgentFallback });
        } catch (e) { return sendError(res, e, 500); }
    }

    // ── Env var management ──
    if (req.url === '/api/env' && req.method === 'GET') {
        return sendJson(res, { env: getEnvVars(), providers: getProviderRequiredEnvVars() });
    }

    if (req.url === '/api/env' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            if (!body.key) return sendError(res, new Error('key is required'), 400);
            setEnvVar(body.key, body.value);
            return sendJson(res, { status: 'ok', key: body.key, set: true });
        } catch (e) { return sendError(res, e, 500); }
    }

    if (req.url === '/api/mcp-env' && req.method === 'GET') {
        return sendJson(res, { env: getMcpGlobalEnvForUi() });
    }

    if (req.url === '/api/mcp-env' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            updateMcpGlobalEnvFromUi(body.env || []);
            return sendJson(res, { status: 'ok', env: getMcpGlobalEnvForUi() });
        } catch (e) { return sendError(res, e, 500); }
    }

    if (req.url.startsWith('/api/env/') && req.method === 'DELETE') {
        const key = decodeURIComponent(req.url.split('/').pop());
        deleteEnvVar(key);
        return sendJson(res, { status: 'ok', key, deleted: true });
    }

    // ── Health detailed route for the new UI ──
    if (req.url === '/api/health/detailed' && req.method === 'GET') {
        const claudeProfile = getProfile('claude');
        const codexProfile = getProfile('codex');
        const mem = process.memoryUsage();

        // Derive the proxy's own origin from the request host (so it works
        // behind LAN/Tailscale hostnames), falling back to 127.0.0.1:port.
        // When the dev server proxies here, the Host header carries
        // `localhost:8085` — we surface 127.0.0.1 instead so the URL the
        // user copies from System Health is stable and works on the same
        // machine. LAN / Tailscale hostnames are preserved as-is.
        const rawHost = req.headers.host || `127.0.0.1:${LISTEN_PORT}`;
        const host = rawHost.replace(/^localhost(?=[:/]|$)/, '127.0.0.1');
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const origin = `${proto}://${host}`;

        // Active upstream provider baseUrl (key redacted) for reference.
        let activeUpstream = null;
        try {
            const activeName = getActiveProvider();
            if (activeName) {
                const pcfg = getProviderConfig(activeName) || {};
                const { getProvider } = require('./providers/provider-registry');
                const profile = getProvider(activeName);
                const baseUrl = pcfg.baseUrl || pcfg.targetUrl || profile?.resolveBaseUrl() || '';
                activeUpstream = { provider: activeName, baseUrl };
            }
        } catch { /* ignore */ }

        return sendJson(res, {
            claude: { status: claudeProfile?.apiKey ? 'ok' : 'missing key' },
            codex: { status: codexProfile?.apiKey ? 'ok' : 'missing key' },
            uptime: Math.floor(process.uptime()),
            memory: {
                used: Math.round(mem.heapUsed / 1024 / 1024),
                total: Math.round(mem.heapTotal / 1024 / 1024)
            },
            origin,
            port: LISTEN_PORT,
            // OpenAI/Anthropic-compatible entrypoints this proxy exposes.
            endpoints: {
                anthropic: { url: `${origin}/v1/messages`, label: 'Anthropic Messages (Claude Code)', client: 'claude' },
                openai: { url: `${origin}/v1/chat/completions`, label: 'OpenAI Chat Completions', client: 'codex' },
                models: { url: `${origin}/v1/models`, label: 'OpenAI-compatible model list', client: 'any' }
            },
            activeUpstream
        });
    }

    // ── Backend restart (graceful exit, dev supervisor restarts) ──
    if (req.url === '/api/system/restart' && req.method === 'POST') {
        console.log('[System] Restart requested via API — exiting.');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Restarting…' }));
        setImmediate(() => process.exit(0));
        return;
    }

    // ── Workspace Files list route for explorer ──
    if (req.url.startsWith('/api/workspace/files') && req.method === 'GET') {
        try {
            const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
            const dirPath = url.searchParams.get('path');
            if (!dirPath) {
                return sendJson(res, { files: [] });
            }
            const resolvedPath = path.resolve(dirPath);
            if (!fs.existsSync(resolvedPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Directory does not exist' }));
            }
            const stat = fs.statSync(resolvedPath);
            if (!stat.isDirectory()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Path is not a directory' }));
            }

            const items = fs.readdirSync(resolvedPath, { withFileTypes: true });
            const files = [];
            for (const item of items) {
                if (item.name === '.git' || item.name === 'node_modules' || item.name === '.gemini') continue;
                const fullPath = path.join(resolvedPath, item.name);
                try {
                    const s = fs.statSync(fullPath);
                    files.push({
                        name: item.name,
                        path: fullPath.replace(/\\/g, '/'),
                        isDir: item.isDirectory(),
                        sizeBytes: s.size
                    });
                } catch (e) {
                    // Ignore files that fail stat (e.g. permission issues)
                }
            }
            files.sort((a, b) => {
                if (a.isDir && !b.isDir) return -1;
                if (!a.isDir && b.isDir) return 1;
                return a.name.localeCompare(b.name);
            });
            return sendJson(res, { files });
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    if (await handleServiceConnectionRoutes(req, res, req.url)) return;

    // ── Services endpoint ──
    if (req.url === '/api/services' && req.method === 'GET') {
        try {
            const { getServiceConnectionsArray } = require('./services/tools/service-connections');
            return sendJson(res, { services: getServiceConnectionsArray() });
        } catch (e) {
            return sendJson(res, { services: [] });
        }
    }

    // ── Overview stats route for the new UI ──
    if (req.url.startsWith('/api/overview') && req.method === 'GET') {
        const { listProviders } = require('./providers/provider-registry');
        const activeProviders = listProviders().filter(p => p.isAvailable()).length;
        const stats = getStats('day', {});
        const config = getConfig();
        const activeProvider = config.activeProvider || 'openai';
        return sendJson(res, {
            requests: stats.totalRequests,
            activity: stats.avgDurationMs,
            inspector: stats.pendingRequests,
            errors: stats.errorRequests,
            cost: {
                input: stats.totalInputTokens,
                output: stats.totalOutputTokens,
                total: stats.estimatedTotalCost
            },
            activeConfig: config[activeProvider] || {}
        });
    }

    // ── Aggregate models from all active providers ──
    if ((req.url === '/api/models' || req.url.startsWith('/api/models?')) && req.method === 'GET') {
        try {
            const { getModelList } = require('./providers/model-list');
            const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const skeleton = parsed.searchParams.get('skeleton') === 'true';
            const refresh = parsed.searchParams.get('refresh') === 'true';
            const limit = Math.max(0, parseInt(parsed.searchParams.get('limit') || '0', 10) || 0);
            const offset = Math.max(0, parseInt(parsed.searchParams.get('offset') || '0', 10) || 0);
            const result = await getModelList({ skeleton, refresh, limit, offset });
            if (skeleton) {
                const { modelListCache: cache } = require('./providers/model-list');
                res.setHeader('X-August-Models-Cache', cache ? 'warm' : 'pending');
            }
            if (Array.isArray(result)) {
                return sendJson(res, { models: result, hasMore: false, total: result.length });
            }
            return sendJson(res, result);
        } catch (e) {
            console.error('[Proxy /api/models] error:', e.message);
            return sendJson(res, { models: [], hasMore: false, total: 0 });
        }
    }

    if (req.url === '/ui/compatibility' && req.method === 'GET') {
        return sendJson(res, getCompatibilityStatus());
    }

    if (req.url === '/ui/health' && req.method === 'GET') {
        return sendJson(res, getCapabilityHealth());
    }

    if (req.url === '/ui/brain/policy' && req.method === 'GET') {
        const { getBrainConfig, planBrainTurn } = require('./services/memory/brain-orchestrator');
        const { graphStats } = require('./services/memory/graph-memory');
        const { readFailureMemory } = require('./services/memory/tool-failure-memory');
        const { listLearnedGuidelines } = require('./services/memory/learned-guidelines');
        const { listAgentJobs } = require('./services/tools/agent-jobs');
        const claude = getProfile('claude') || {};
        return sendJson(res, {
            generatedAt: new Date().toISOString(),
            config: getBrainConfig(),
            samplePolicy: planBrainTurn({
                messages: [],
                provider: 'claude',
                model: claude._upstreamModel || claude.currentModel || '',
                requestKind: 'ui'
            }),
            counts: {
                graph: graphStats().counts,
                failures: readFailureMemory().length,
                pendingGuidelines: listLearnedGuidelines({ status: 'pending' }).length,
                activeGuidelines: listLearnedGuidelines({ status: 'active' }).length,
                agentJobs: listAgentJobs({ status: 'all', limit: 1 }).count
            }
        });
    }

    // GET /ui/brain/config — { config, defaults, source }
    if (req.url === '/ui/brain/config' && req.method === 'GET') {
        try {
            const { getBrainConfigForSettings, listWorkbenchSessions } = require('./services/memory/brain-orchestrator');
            const { getWorkbenchSession } = require('./services/workbench/workbench');
            let sessionId = null;
            try {
                const recent = (listWorkbenchSessions() || [])[0];
                if (recent && recent.id) sessionId = recent.id;
            } catch (_) { /* no sessions yet */ }
            const payload = getBrainConfigForSettings({ sessionId });
            const sessionPayload = sessionId ? getWorkbenchSession(sessionId) : null;
            return sendJson(res, { ...payload, sessionId, session: sessionPayload ? { id: sessionPayload.id, task: sessionPayload.task || sessionPayload.lastGoal || null } : null });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    // PUT /ui/brain/config — body: partial DEFAULT_FEATURES
    if (req.url === '/ui/brain/config' && req.method === 'PUT') {
        try {
            const body = await readJsonBody(req);
            const { saveBrainConfig, DEFAULT_FEATURES } = require('./services/memory/brain-orchestrator');
            const merged = saveBrainConfig(body || {});
            try {
                const audit = require('./services/audit/audit-log');
                audit.appendAuditEntry({
                    actor: 'user',
                    action: 'brain_config_update',
                    category: 'config',
                    target: 'cfg.brainOrchestrator',
                    args: { before: body || {}, after: merged },
                    result: 'ok'
                });
            } catch (_) { /* audit is best-effort */ }
            return sendJson(res, { ok: true, config: merged, defaults: DEFAULT_FEATURES });
        } catch (e) {
            if (e && e.code === 'EBRAIN_UNKNOWN_KEY') return sendError(res, e, 400);
            return sendError(res, e, 400);
        }
    }

    // POST /ui/brain/config/reset — clear persisted config
    if (req.url === '/ui/brain/config/reset' && req.method === 'POST') {
        try {
            const { resetBrainConfig, DEFAULT_FEATURES } = require('./services/memory/brain-orchestrator');
            const next = resetBrainConfig();
            try {
                const audit = require('./services/audit/audit-log');
                audit.appendAuditEntry({
                    actor: 'user',
                    action: 'brain_config_update',
                    category: 'config',
                    target: 'cfg.brainOrchestrator',
                    args: { action: 'reset', after: next },
                    result: 'ok'
                });
            } catch (_) {}
            return sendJson(res, { ok: true, config: next, defaults: DEFAULT_FEATURES });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    // GET /ui/brain/config/from-session?sessionId=<id>
    if (req.url.startsWith('/ui/brain/config/from-session') && req.method === 'GET') {
        try {
            const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const sessionId = parsed.searchParams.get('sessionId');
            if (!sessionId) return sendJson(res, { error: 'sessionId query param is required' }, 400);
            const { getBrainConfigForSettings } = require('./services/memory/brain-orchestrator');
            const payload = getBrainConfigForSettings({ sessionId });
            return sendJson(res, payload);
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (req.url === '/ui/workbench/session' && req.method === 'POST') {
        try {
            return sendJson(res, createWorkbenchSession(await readJsonBody(req)));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/workbench/sessions' && req.method === 'GET') {
        try {
            return sendJson(res, listWorkbenchSessions());
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (req.url.startsWith('/ui/workbench/session') && req.method === 'GET') {
        try {
            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const sessionId = url.searchParams.get('sessionId');
            if (!sessionId) throw new Error('Session ID is required');
            return sendJson(res, getWorkbenchSession(sessionId));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/workbench/capabilities' && req.method === 'GET') {
        return sendJson(res, listProxyCapabilities());
    }

    if (req.url.startsWith('/ui/workbench/agents') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        return sendJson(res, listAgentRegistry(url.searchParams.get('active') || 'build'));
    }

    if (req.url.startsWith('/ui/workbench/goal') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        return sendJson(res, getWorkbenchGoalStatus(url.searchParams.get('sessionId')));
    }

    if (req.url === '/ui/workbench/goal' && req.method === 'POST') {
        try {
            return sendJson(res, updateWorkbenchGoal(await readJsonBody(req)));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/workbench/btw' && req.method === 'POST') {
        try {
            return sendJson(res, await answerWorkbenchBtw(await readJsonBody(req)));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/workbench/guard-mode' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            const session = getWorkbenchSession(data.sessionId);
            if (!session) return sendError(res, new Error('Session not found'), 400);
            session.guardMode = normalizeGuardMode(data.guardMode);
            saveSessions();
            return sendJson(res, summarizeSession(session));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/workbench/chat' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req, { limitBytes: 2 * 1024 * 1024 });
            const sessionId = data.sessionId;
            if (!sessionId) {
                return sendJson(res, { error: 'sessionId is required' }, 400);
            }

            // Abort any existing generation for this session ID first
            let gen = activeGenerations.get(sessionId);
            if (gen && gen.status === 'streaming') {
                if (gen.abortController) {
                    gen.abortController.abort();
                }
                gen.status = 'aborted';
                chatEventLog.append(sessionId, 'aborted', {});
            }

            // Initialize new generation state
            const generationAbortCtrl = new AbortController();
            gen = {
                events: [],
                status: 'streaming',
                abortController: generationAbortCtrl,
                listeners: new Set()
            };
            activeGenerations.set(sessionId, gen);

            // Emit a single 'started' event on the chat event log so a fresh
            // subscriber (or one catching up after a tab switch) sees the
            // turn boundary. The seq counter is the cursor the client uses
            // to reconnect via `sinceSeq`.
            const startEntry = chatEventLog.append(sessionId, 'started', {
                sinceSeq: chatEventLog.currentSeq(sessionId)
            });
            const sinceSeq = startEntry ? startEntry.seq : 0;

            // Start generation in background. Each event from the workbench
            // stream is appended to the persistent chat event log; SSE
            // subscribers attached via `chatEventLog.subscribe` get the same
            // events through fan-out, so tabs/connections never block each
            // other and a reconnect replays missed events automatically.
            sendWorkbenchMessageStream(data, (type, payload) => {
                chatEventLog.append(sessionId, type, payload || {});
            }, { signal: generationAbortCtrl.signal })
            .then(() => {
                if (gen.status === 'streaming') {
                    gen.status = 'done';
                    chatEventLog.append(sessionId, 'done', {});
                }
            })
            .catch((err) => {
                const isAbort = err?.name === 'AbortError' || generationAbortCtrl.signal.aborted;
                if (gen.status === 'streaming') {
                    gen.status = isAbort ? 'aborted' : 'error';
                    chatEventLog.append(sessionId, isAbort ? 'aborted' : 'error', {
                        message: err?.message || 'Unknown error'
                    });
                }
            });

            // Return immediately so the POST never holds the request open —
            // subscribers pull events through GET /ui/workbench/chat/stream.
            // `sinceSeq` is the cursor the client should pass on reconnect to
            // skip events it already saw.
            return sendJson(res, { status: 'started', sessionId, sinceSeq });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/workbench/chat/stream') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
            return sendJson(res, { error: 'sessionId is required' }, 400);
        }
        const sinceSeqRaw = url.searchParams.get('sinceSeq');
        const sinceSeq = sinceSeqRaw == null ? null : Number(sinceSeqRaw);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        const writer = {
            write: (entry) => {
                try {
                    res.write(`event: ${entry.type}\ndata: ${JSON.stringify(entry.payload || {})}\nid: ${entry.seq}\n\n`);
                } catch (_) {
                    // The response is already closed (e.g. client navigated
                    // away). Returning false tells the subscriber loop to
                    // drop us so we stop being invoked.
                    return false;
                }
                if (entry.type === 'done' || entry.type === 'error' || entry.type === 'aborted') {
                    try { res.end(); } catch (_) {}
                    return false;
                }
                return true;
            },
            onError: () => {
                try { res.end(); } catch (_) {}
            },
        };

        const sub = chatEventLog.subscribe(sessionId, writer, { sinceSeq: Number.isFinite(sinceSeq) ? sinceSeq : undefined });
        const gen = activeGenerations.get(sessionId);
        const isLive = gen && gen.status === 'streaming';
        if (!isLive && sub.replayed === 0) {
            // No replay and no live generation — close immediately so the
            // client doesn't wait for an event that never comes.
            try { res.write('event: done\ndata: {}\n\n'); res.end(); } catch (_) {}
        }
        req.on('close', () => {
            sub.unsubscribe();
        });
        return;
    }

    if (req.url === '/ui/workbench/chat/stop' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            const sessionId = data.sessionId;
            if (!sessionId) {
                return sendJson(res, { error: 'sessionId is required' }, 400);
            }
            const gen = activeGenerations.get(sessionId);
            if (gen && gen.status === 'streaming') {
                if (gen.abortController) {
                    gen.abortController.abort();
                }
                gen.status = 'aborted';
                const event = { type: 'aborted', payload: {}, timestamp: Date.now() };
                gen.events.push(event);
                for (const listener of gen.listeners) {
                    try { listener(event); } catch (_) {}
                }
            }
            return sendJson(res, { status: 'ok' });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/workbench/chat/active' && req.method === 'GET') {
        const active = {};
        for (const [sessionId, gen] of activeGenerations.entries()) {
            if (gen.status === 'streaming') {
                active[sessionId] = gen.status;
            }
        }
        return sendJson(res, active);
    }


    if (req.url === '/ui/workbench/confirm-mutation' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            const consumed = consumePendingMutation(data.token, { reject: !!data.reject });
            if (consumed.status === 'rejected') {
                return sendJson(res, { status: 'rejected', message: 'User denied the pending mutation.' });
            }
            if (consumed.status !== 'ok') return sendJson(res, consumed);
            const session = getWorkbenchSession(consumed.pending.sessionId);
            if (!session) return sendError(res, new Error('Session not found'), 400);
            const result = await executeWorkbenchTool(session, {
                name: consumed.pending.toolName,
                id: data.token,
                input: consumed.pending.args
            }, { approvedMutation: true });
            return sendJson(res, result || { status: 'ok' });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    // GET /ui/workbench/session/:id/status → lightweight approval state
    if (req.url.startsWith('/ui/workbench/session/') && req.url.endsWith('/status') && req.method === 'GET') {
        try {
            const sessionId = decodeURIComponent(req.url.split('/')[4] || '');
            if (!sessionId) return sendJson(res, { error: 'session id is required' }, 400);
            const { getWorkbenchSessionStatus } = require('./services/workbench/workbench');
            const status = getWorkbenchSessionStatus(sessionId);
            if (!status) return sendJson(res, { error: 'Session not found', sessionId }, 404);
            return sendJson(res, status);
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (req.url === '/ui/workbench/approve' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            return sendJson(res, approveWorkbenchPlan(data.sessionId));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/workbench/reject' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            return sendJson(res, rejectWorkbenchPlan(data.sessionId));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/workbench/reset' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            return sendJson(res, resetWorkbenchSession(data.sessionId, data.provider, data.agentId));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/host-agent/status' && req.method === 'GET') {
        hostAgent.getStatus().then(status => sendJson(res, { status })).catch(() => sendJson(res, { status: 'disconnected' }));
        return;
    }

    // ----- Observability routes (Task 2 + 3) -----
    //   GET   /ui/audit                — filtered audit log
    //   GET   /ui/audit?summary=1      — aggregate counts
    //   GET   /ui/rollback             — filtered rollback list
    //   GET   /ui/rollback?summary=1   — aggregate counts
    //   POST  /ui/rollback/:id/undo    — perform rollback
    //   GET   /ui/observations         — list post-observation PNGs
    //   GET   /ui/observations/:id.png — serve single PNG
    //   GET   /ui/host-agent/health    — status + last-action timestamps
    //   PUT   /ui/security             — write back security config
    //   GET   /ui/observability/overview — combined payload
    if (
        req.url.startsWith('/ui/audit') ||
        req.url === '/ui/rollback' ||
        req.url.startsWith('/ui/rollback/') ||
        req.url.startsWith('/ui/observations') ||
        req.url === '/ui/host-agent/health' ||
        req.url === '/ui/security' ||
        req.url.startsWith('/ui/observability/')
    ) {
        try {
            const { handleObservabilityRoute } = require('./services/observability/observability-routes');
            const handled = await handleObservabilityRoute(req, res, {
                url: req.url,
                method: req.method,
                sendJson,
                sendError
            });
            if (handled) return handled;
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    // ----- August self-management API (Task 4) -----
    if (req.url.startsWith('/ui/august/')) {
        try {
            const { handleAugustApiRoute } = require('./services/august-api/august-api-routes');
            const handled = await handleAugustApiRoute(req, res, {
                url: req.url,
                method: req.method,
                sendJson,
                sendError
            });
            if (handled) return handled;
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (req.url === '/ui/host-files/folder' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            return sendJson(res, {
                folder: createHostFilesFolder(data.name),
                compatibility: getCompatibilityStatus()
            });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/plugins' && req.method === 'GET') {
        return sendJson(res, { plugins: getPlugins() });
    }

    if (req.url.startsWith('/ui/plugins/') && req.method === 'DELETE') {
        try {
            const name = decodeURIComponent(req.url.split('/').pop());
            return sendJson(res, { ...deletePlugin(name), plugins: getPlugins() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/plugins/') && req.method === 'PATCH') {
        try {
            const name = decodeURIComponent(req.url.split('/').pop());
            const data = await readJsonBody(req);
            const plugin = setPluginEnabled(name, data.enabled !== false);
            return sendJson(res, { plugin, plugins: getPlugins() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/plugins/') && req.url.endsWith('/refresh') && req.method === 'POST') {
        try {
            const parts = req.url.split('/');
            const name = decodeURIComponent(parts[3]);
            const plugin = getPlugins().find(item => item.name === name);
            if (!plugin?.sourceUrl) throw new Error('Plugin has no source URL to refresh.');
            const imported = await importCapabilityLink({ url: plugin.sourceUrl, enableMcp: false });
            return sendJson(res, { imported, plugins: getPlugins() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/import-link' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            const imported = await importSkillFromLink({
                url: data.url,
                enableMcp: data.enableMcp === true,
                restartMcp: true
            });
            const status = imported.mcpStatus || getMcpServerStatus();
            return sendJson(res, { imported, status, plugins: getPlugins() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/mcp' && req.method === 'GET') {
        return sendJson(res, {
            servers: getMcpServersForUi(),
            status: getMcpServerStatus()
        });
    }

    if (req.url === '/ui/mcp' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            const saved = saveCustomMcpServer(data);
            const status = await restartMcpServers(getProfile('claude')?.apiKey || '');
            return sendJson(res, { saved, status });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/mcp/') && req.method === 'PATCH') {
        try {
            const name = decodeURIComponent(req.url.split('/').pop());
            const data = await readJsonBody(req);
            const saved = setMcpServerEnabled(name, data.enabled !== false);
            const status = await restartMcpServers(getProfile('claude')?.apiKey || '');
            return sendJson(res, { saved, status, servers: getMcpServersForUi() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/mcp/restart' && req.method === 'POST') {
        try {
            const status = await restartMcpServers(getProfile('claude')?.apiKey || '');
            return sendJson(res, { status });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (req.url.startsWith('/ui/mcp/') && req.method === 'DELETE') {
        try {
            const name = decodeURIComponent(req.url.split('/').pop());
            const result = deleteMcpServer(name);
            const status = await restartMcpServers(getProfile('claude')?.apiKey || '');
            return sendJson(res, { ...result, status });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/skills' && req.method === 'GET') {
        return sendJson(res, { skills: getSkills() });
    }

    if (req.url === '/ui/skills' && req.method === 'POST') {
        try {
            const saved = saveSkill(await readJsonBody(req));
            return sendJson(res, { saved, skills: getSkills() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/skills/') && req.method === 'DELETE') {
        try {
            const name = decodeURIComponent(req.url.split('/').pop());
            return sendJson(res, { ...deleteSkill(name), skills: getSkills() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/team-skills' && req.method === 'GET') {
        return sendJson(res, { skills: getTeamSkills(), count: getTeamSkills().length });
    }

    if (req.url.startsWith('/ui/team-skills/') && req.method === 'GET') {
        try {
            const agentId = decodeURIComponent(req.url.split('/').pop());
            return sendJson(res, { agentId, skills: getTeamSkills(agentId), count: getTeamSkills(agentId).length });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/agents' && req.method === 'GET') {
        return sendJson(res, { agents: agentRegistry.getAgents() });
    }

    if (req.url === '/ui/agents' && req.method === 'POST') {
        try {
            return sendJson(res, { agent: agentRegistry.saveAgent(await readJsonBody(req)), agents: agentRegistry.getAgents() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/agents/permissions' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            return sendJson(res, {
                permissions: agentRegistry.deriveChildAgentPermissions(body.parentAgent || 'build', body.childAgent || 'general')
            });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/agent-jobs') && req.method === 'GET') {
        try {
            const jobs = require('./services/tools/agent-jobs');
            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const parts = url.pathname.split('/').map(part => decodeURIComponent(part));
            const id = parts[3] || '';
            if (id) {
                const job = jobs.getAgentJob(id);
                if (!job) return sendError(res, new Error('Agent job not found'), 404);
                return sendJson(res, { job });
            }
            return sendJson(res, jobs.listAgentJobs({
                status: url.searchParams.get('status') || 'all',
                sessionId: url.searchParams.get('sessionId') || '',
                scope: url.searchParams.get('scope') || '',
                limit: url.searchParams.get('limit') || 50
            }));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/agent-sessions' && req.method === 'GET') {
        return sendJson(res, agentSessions.listAgentSessions());
    }

    if (req.url === '/ui/agent-sessions' && req.method === 'POST') {
        try {
            return sendJson(res, { session: agentSessions.createAgentSession(await readJsonBody(req)), ...agentSessions.listAgentSessions() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/agent-sessions/') && !req.url.startsWith('/ui/agent-sessions/.')) {
        try {
            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const parts = url.pathname.split('/').map(part => decodeURIComponent(part));
            const sessionId = parts[3];
            const action = parts[4] || '';
            const requestId = parts[5] || '';
            if (!sessionId) throw new Error('Agent session id is required');
            if (!action && req.method === 'GET') {
                return sendJson(res, agentSessions.getAgentSession(sessionId));
            }
            if (!action && req.method === 'PATCH') {
                return sendJson(res, { session: agentSessions.updateAgentSession(sessionId, await readJsonBody(req)) });
            }
            if (!action && req.method === 'DELETE') {
                return sendJson(res, agentSessions.deleteAgentSession(sessionId, { includeChildren: url.searchParams.get('includeChildren') === 'true' }));
            }
            if (action === 'todos' && req.method === 'POST') {
                const body = await readJsonBody(req);
                return sendJson(res, agentSessions.writeTodos(sessionId, body.todos || [], { merge: body.merge === true }));
            }
            if (action === 'permissions' && !requestId && req.method === 'POST') {
                return sendJson(res, agentSessions.addPermissionRequest(sessionId, await readJsonBody(req)));
            }
            if (action === 'permissions' && requestId && req.method === 'POST') {
                const body = await readJsonBody(req);
                return sendJson(res, agentSessions.respondPermission(sessionId, requestId, body.response || (body.approve === false ? 'reject' : 'once')));
            }
            if (action === 'questions' && !requestId && req.method === 'POST') {
                return sendJson(res, agentSessions.addQuestionRequest(sessionId, await readJsonBody(req)));
            }
            if (action === 'questions' && requestId && req.method === 'POST') {
                const body = await readJsonBody(req);
                return sendJson(res, agentSessions.respondQuestion(sessionId, requestId, body.answer));
            }
            if (action === 'tree-request' && req.method === 'GET') {
                return sendJson(res, { request: agentSessions.findTreeRequest(sessionId, url.searchParams.get('type') || 'permission') });
            }
            if (action === 'run' && req.method === 'POST') {
                return sendJson(res, await agentSessions.startSessionRun(sessionId, await readJsonBody(req)));
            }
            if (action === 'cancel' && req.method === 'POST') {
                const body = await readJsonBody(req);
                return sendJson(res, { session: agentSessions.cancelAgentSession(sessionId, body.reason || 'cancelled from dashboard') });
            }
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/preview/sessions' && req.method === 'GET') {
        const previewService = require('./services/workbench/preview-service');
        return sendJson(res, previewService.listPreviewSessions());
    }

    if (req.url === '/ui/preview/sessions' && req.method === 'POST') {
        try {
            const previewService = require('./services/workbench/preview-service');
            return sendJson(res, previewService.createPreviewSession(await readJsonBody(req)));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/preview/session/') && req.method === 'GET') {
        try {
            const previewService = require('./services/workbench/preview-service');
            return sendJson(res, await previewService.getPreviewSession(decodeURIComponent(req.url.split('/').pop())));
        } catch (e) {
            return sendError(res, e, 404);
        }
    }

    if (req.url.startsWith('/ui/preview/session/') && req.method === 'DELETE') {
        const previewService = require('./services/workbench/preview-service');
        return sendJson(res, { deleted: previewService.stopPreviewSession(decodeURIComponent(req.url.split('/').pop())) });
    }

    if (req.url === '/ui/preview/approve' && req.method === 'POST') {
        try {
            const previewService = require('./services/workbench/preview-service');
            const body = await readJsonBody(req);
            return sendJson(res, await previewService.approvePreviewRequest(body.requestId, { approve: body.approve !== false }));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/terminal/sessions' && req.method === 'GET') {
        return sendJson(res, { sessions: terminalService.listTerminalSessions(), approvals: terminalService.listTerminalApprovals() });
    }

    if (req.url === '/ui/terminal/sessions' && req.method === 'POST') {
        try {
            return sendJson(res, terminalService.createTerminalSession(await readJsonBody(req)));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/terminal/buffer') && req.method === 'GET') {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            return sendJson(res, terminalService.readTerminalBuffer(url.searchParams.get('id')));
        } catch (e) {
            return sendError(res, e, 404);
        }
    }

    if (req.url === '/ui/terminal/input' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            return sendJson(res, terminalService.writeTerminalInput(body.id, body.input, { approved: body.approved }));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/terminal/resize' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            return sendJson(res, terminalService.resizeTerminalSession(body.sessionId, body.cols, body.rows));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/terminal/command' && req.method === 'POST') {
        try {
            return sendJson(res, await terminalService.submitTerminalCommand(await readJsonBody(req)));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/terminal/approve' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            return sendJson(res, await terminalService.approveTerminalRequest(body.requestId, { approve: body.approve !== false }));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/terminal/sessions/') && req.method === 'DELETE') {
        const id = decodeURIComponent(req.url.split('/').pop());
        return sendJson(res, { deleted: terminalService.closeTerminalSession(id) });
    }

    if (req.url === '/ui/automations' && req.method === 'GET') {
        return sendJson(res, automationJobs.listAutomationJobs());
    }

    if (req.url === '/ui/automations' && req.method === 'POST') {
        try {
            return sendJson(res, { job: automationJobs.saveAutomationJob(await readJsonBody(req)), ...automationJobs.listAutomationJobs() });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url === '/ui/automations/run' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            return sendJson(res, await automationJobs.runAutomationJob(body.id, { approved: body.approved }));
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (req.url.startsWith('/ui/automations/') && req.method === 'DELETE') {
        const id = decodeURIComponent(req.url.split('/').pop());
        return sendJson(res, { deleted: automationJobs.deleteAutomationJob(id) });
    }

    // ── Real-time SSE stream ──
    if (req.url.startsWith('/ui/stream') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const period = url.searchParams.get('period') || 'all';
        const periodContext = getPeriodContext(url);
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'  // disable nginx/proxy buffering
        });
        res.write(':connected\n\n'); // initial SSE comment to flush headers
        addSSEClient(res, period, periodContext);
        req.on('close', () => removeSSEClient(res));
        return;
    }

    if (req.url === '/ui/activity' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getActivityLog()));
    }

    if (req.url.startsWith('/ui/requests') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const period = url.searchParams.get('period') || 'all';
        const periodContext = getPeriodContext(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            pending: getPendingRequests(),
            completed: getFilteredRequests(period, periodContext)
        }));
    }

    if (req.url.startsWith('/ui/stats') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const period = url.searchParams.get('period') || 'all';
        const periodContext = getPeriodContext(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getStats(period, periodContext)));
    }

    if (req.url.startsWith('/ui/conversations') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const period = url.searchParams.get('period') || 'all';
        const periodContext = getPeriodContext(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getConversations(period, periodContext)));
    }

    if (req.url.startsWith('/api/logs/recent') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const limit = Number(url.searchParams.get('limit')) || 200;
        return sendJson(res, { events: getRecentLogEvents(limit), count: getRecentLogEvents(limit).length });
    }

    if (req.url === '/ui/save' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const data = JSON.parse(body);
            if (data.profile) {
                const profileData = {
                    currentModel: data.currentModel,
                    targetUrl: data.targetUrl,
                    apiKey: data.apiKey
                };
                if (data._upstreamModel !== undefined) profileData._upstreamModel = data._upstreamModel;
                if (data.contextWindow) profileData.contextWindow = parseInt(data.contextWindow, 10);
                if (data.inputCostPer1M !== undefined) profileData.inputCostPer1M = Number(data.inputCostPer1M) || 0;
                if (data.outputCostPer1M !== undefined) profileData.outputCostPer1M = Number(data.outputCostPer1M) || 0;
                saveProfile(data.profile, profileData);
                // Also save customProvider to config root if present
                if (data.customProvider) {
                    const config = getConfig();
                    config.customProvider = data.customProvider;
                    saveConfig(config);
                }
            } else {
                // Backward compatibility: save to root
                const config = getConfig();
                Object.assign(config, data);
                if (data.requestLogLimit !== undefined) {
                    config.requestLogLimit = Math.max(100, parseInt(data.requestLogLimit, 10) || 5000);
                }
                if (data.pendingRequestTimeoutMinutes !== undefined) {
                    config.pendingRequestTimeoutMinutes = Math.max(1, parseInt(data.pendingRequestTimeoutMinutes, 10) || 10);
                }
                if (data.memoryContextMaxChars !== undefined) {
                    const parsedLimit = parseInt(data.memoryContextMaxChars, 10);
                    config.memoryContextMaxChars = Math.max(8000, Math.min(MAX_CONTEXT_MAX_CHARS, Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_CONTEXT_MAX_CHARS));
                }
                saveConfig(config);
            }
            res.writeHead(200);
            res.end('OK');
        });
        return;
    }

    if (req.url.startsWith('/ui/context') && req.method === 'GET') {
        const { inferFromModelId } = require('./lib/models');
        const url = new URL(req.url, `http://${req.headers.host}`);
        const modelId = url.searchParams.get('model');
        const inferred = inferFromModelId(modelId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(inferred || { inputTokens: 32768, outputTokens: 4096 }));
    }

    if (req.url.startsWith('/ui/details') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const period = url.searchParams.get('period') || 'all';
        const periodContext = getPeriodContext(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getRequestDetails(period, periodContext)));
    }

    if (req.url.startsWith('/ui/detail/') && req.method === 'GET') {
        const reqId = req.url.split('/').pop();
        const detail = getRequestDetail(reqId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(detail || { error: 'Not found' }));
    }

    if (req.url === '/ui/models' && req.method === 'GET') {
        const providers = [
            { name: 'Kilocode', url: 'https://api.kilo.ai/api/gateway', base: 'https://api.kilo.ai/api/gateway', key: process.env.KILOCODE_API_KEY },
            { name: 'Opencode', url: 'https://opencode.ai/zen/v1', base: 'https://opencode.ai/zen/v1', key: process.env.OPENCODE_API_KEY },
            { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', base: 'https://openrouter.ai/api/v1', key: process.env.OPENROUTER_API_KEY },
            { name: 'Cline AI', url: 'https://api.cline.bot/api/v1', base: 'https://api.cline.bot/api/v1', key: process.env.CLINE_API_KEY || '' }
        ];

        Promise.all(providers.map(async p => {
            try {
                if (!p.key || p.key === 'undefined') return [];
                if (!p.key && p.name === 'OpenRouter') return [];

                const fetchUrl = p.name === 'Cline AI'
                    ? 'https://openrouter.ai/api/v1/models'
                    : `${p.url}/models`;

                const fetchRes = await fetch(fetchUrl, {
                    headers: p.key ? { 'Authorization': `Bearer ${p.key}` } : {},
                    signal: AbortSignal.timeout(10000)
                });

                if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
                const data = await fetchRes.json();

                return (data.data || []).map(m => ({
                    id: m.id,
                    name: `[${p.name}] ${m.id}`,
                    provider: p.name,
                    url: `${p.url}/chat/completions`,
                    base: p.base,
                    key: p.key
                })).filter(m => {
                    const id = m.id.toLowerCase();
                    return id.includes(':free') || id.includes('-free') || id.includes('auto');
                });
            } catch (e) {
                console.error(`Failed to fetch models from ${p.name}:`, e.message);
                if (p.name === 'Cline AI') {
                    return [
                        { id: 'minimax/minimax-m2.5:free', name: `[${p.name}] minimax/minimax-m2.5:free`, provider: p.name, url: `${p.url}/chat/completions`, base: p.base, key: p.key },
                        { id: 'google/gemini-2.0-flash-exp:free', name: `[${p.name}] gemini-2.0-flash-exp:free`, provider: p.name, url: `${p.url}/chat/completions`, base: p.base, key: p.key },
                        { id: 'tencent/hy3-preview:free', name: `[${p.name}] tencent/hy3-preview:free`, provider: p.name, url: `${p.url}/chat/completions`, base: p.base, key: p.key }
                    ];
                }
                if (p.name !== 'OpenRouter') {
                    return [
                        { id: 'hy3-preview-free', name: `[${p.name}] hy3-preview-free`, provider: p.name, url: `${p.url}/chat/completions`, base: p.base, key: p.key },
                        { id: 'ling-2.6-flash-free', name: `[${p.name}] ling-2.6-flash-free`, provider: p.name, url: `${p.url}/chat/completions`, base: p.base, key: p.key },
                        { id: 'minimax-m2.5-free', name: `[${p.name}] minimax-m2.5-free`, provider: p.name, url: `${p.url}/chat/completions`, base: p.base, key: p.key }
                    ];
                }
                return [];
            }
        })).then(results => {
            const allModels = results.flat();
            const uniqueModels = Array.from(new Map(allModels.map(m => [m.id, m])).values());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(uniqueModels));
        }).catch(err => {
            console.error('[UI /ui/models] Unexpected error:', err.message);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([])); // always respond so the UI never hangs
        });
        return;
    }

    if (req.url === '/ui/semantic-memory' && req.method === 'GET') {
        const { getAllFacts, factCount } = require('./services/memory/semantic-memory');
        return sendJson(res, { facts: getAllFacts(), count: factCount() });
    }

    if (req.url === '/ui/supermemory/test' && req.method === 'POST') {
        try {
            const { getSupermemorySettings, searchSupermemory, summarizeSupermemoryResult } = require('./services/memory/supermemory');
            const body = await readJsonBody(req);
            const query = String(body.query || '').trim();
            if (!query) return sendError(res, new Error('query is required'), 400);
            const settings = getSupermemorySettings();
            if (!settings.configured) {
                return sendJson(res, {
                    configured: false,
                    baseUrl: settings.baseUrl,
                    results: [],
                    error: 'Supermemory is not configured. Set SUPERMEMORY_API_KEY in .env or save a key in the August Brain tab.'
                });
            }
            const data = await searchSupermemory({ query, limit: 5 });
            const results = (data.results || data.data || []).slice(0, 5).map(item => ({
                id: item.id,
                text: summarizeSupermemoryResult(item),
                similarity: item.similarity,
                updatedAt: item.updatedAt,
                metadata: item.metadata || null
            }));
            return sendJson(res, {
                configured: true,
                baseUrl: settings.baseUrl,
                count: results.length,
                results,
                rawTotal: data.total
            });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (req.url === '/ui/semantic-memory' && req.method === 'DELETE') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const { deleteFact } = require('./services/memory/semantic-memory');
            const { key } = JSON.parse(body);
            if (!key) return sendError(res, new Error('key is required'), 400);
            const deleted = deleteFact(key);
            return sendJson(res, { deleted });
        });
        return;
    }

    if (req.url === '/ui/test' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            const testData = JSON.parse(body);
            const profile = testData.profile === 'claude' ? 'claude' : 'codex';
            const reqId = startRequest({ clientType: profile, endpoint: '/ui/test', model: testData.model || 'unknown' });
            try {
                const response = await fetch(testData.targetUrl, {
                    method: 'POST',
                    headers: buildTestHeaders(profile, testData.apiKey),
                    body: JSON.stringify(buildTestPayload(profile, testData.model)),
                    signal: AbortSignal.timeout(30000)
                });
                const text = await response.text();
                if (!response.ok) throw new Error(`HTTP ${response.status} at ${testData.targetUrl}: ${text}`);
                let data = JSON.parse(text);
                if (data.data && data.data.choices) data = data.data;
                const usage = data.usage || {};
                const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
                const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
                const choice = data.choices?.[0];
                const contentBlock = Array.isArray(data.content) ? data.content.find(part => part.type === 'text') : null;
                const content = contentBlock?.text || choice?.message?.content || choice?.message?.reasoning || 'No content returned';
                endRequest(reqId, { status: 'success', model: testData.model, inputTokens, outputTokens });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, content }));
            } catch (e) {
                endRequest(reqId, { status: 'error', model: testData.model, error: e.message });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/ui/custom-models' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { baseUrl, apiKey } = JSON.parse(body);
                if (!baseUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Base URL is required' }));
                }
                const fetchUrl = buildModelsUrl(baseUrl);
                console.log(`[Custom Provider]: Fetching models from ${fetchUrl}`);
                const fetchRes = await fetch(fetchUrl, {
                    headers: buildAuthHeaders(apiKey),
                    signal: AbortSignal.timeout(15000)
                });
                const raw = await fetchRes.text();
                if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status} at ${fetchUrl}: ${raw}`);
                const data = JSON.parse(raw);
                const models = (data.data || []).map(m => ({
                    id: m.id,
                    name: `[Custom] ${m.id}`,
                    provider: 'Custom',
                    url: fetchUrl,
                    base: normalizeOpenAIBaseUrl(baseUrl)
                }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(models));
            } catch (e) {
                console.error('[Custom Provider]: Fetch failed:', e.message);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/ui/custom-test' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            const parsed = JSON.parse(body);
            const resolvedProfile = parsed.profile === 'claude' ? 'claude' : 'codex';
            const reqId = startRequest({ clientType: resolvedProfile, endpoint: '/ui/custom-test', model: parsed.model || 'unknown' });
            try {
                const targetUrl = buildTargetUrlForProfile(resolvedProfile, parsed.baseUrl);
                if (!targetUrl) throw new Error('Base URL is required');
                if (!parsed.model) throw new Error('Select a model first or click Fetch Models before testing');

                const response = await fetch(targetUrl, {
                    method: 'POST',
                    headers: buildTestHeaders(resolvedProfile, parsed.apiKey),
                    body: JSON.stringify(buildTestPayload(resolvedProfile, parsed.model)),
                    signal: AbortSignal.timeout(30000)
                });
                const text = await response.text();
                if (!response.ok) throw new Error(`HTTP ${response.status} at ${targetUrl}: ${text}`);
                let data = JSON.parse(text);
                if (data.data && data.data.choices) data = data.data;
                const usage = data.usage || {};
                const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
                const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
                const choice = data.choices?.[0];
                const contentBlock = Array.isArray(data.content) ? data.content.find(part => part.type === 'text') : null;
                const content = contentBlock?.text || choice?.message?.content || choice?.message?.reasoning || 'No content returned';
                endRequest(reqId, { status: 'success', model: parsed.model, inputTokens, outputTokens });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, content }));
            } catch (e) {
                endRequest(reqId, { status: 'error', model: parsed.model, error: e.message });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // ── Bookmarked Custom Providers ──
    if (req.url === '/ui/bookmarks' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getBookmarks()));
    }

    if (req.url === '/ui/bookmarks' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { name, baseUrl, apiKey, inputCostPer1M, outputCostPer1M } = JSON.parse(body);
                if (!name || !baseUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Name and baseUrl are required' }));
                }
                saveBookmark(name, baseUrl, apiKey || '', inputCostPer1M, outputCostPer1M);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, bookmarks: getBookmarks() }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url.startsWith('/ui/bookmarks/') && req.method === 'DELETE') {
        const name = decodeURIComponent(req.url.split('/').pop());
        const removed = deleteBookmark(name);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: removed, bookmarks: getBookmarks() }));
    }

    // ── Model Profiles ──
    if (req.url === '/ui/model-profiles' && req.method === 'GET') {
        const { listKnownProfiles } = require('./lib/model-profiles');
        const config = getConfig();
        const userProfiles = config.modelProfiles || {};
        return sendJson(res, {
            builtin: listKnownProfiles(),
            userOverrides: userProfiles
        });
    }

    if (req.url === '/ui/model-profiles' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const config = getConfig();
                config.modelProfiles = data.modelProfiles || {};
                saveConfig(config);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── Web Search (DuckDuckGo) ──
    if (req.url.startsWith('/search') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const query = url.searchParams.get('q');
        if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing q parameter' }));
        }
        try {
            // Delegate to the same robust HTML scraper used by the managed tool loop.
            // Previously used api.duckduckgo.com which only returns Instant Answers,
            // not real web-page search results.
            const searchResult = await executeManagedWebTool('web_search', { query, max_results: 10 });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(searchResult));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    // ── Web Fetch (generic URL) ──
    if (req.url.startsWith('/fetch') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing url parameter' }));
        }
        try {
            const parsed = new URL(targetUrl);
            // Block internal addresses
            const blocked = [
                /^http:\/\/localhost/i, /^https?:\/\/127\./i,
                /^https?:\/\/10\./i, /^https?:\/\/192\.168\./i,
                /^https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./i,
                /^https?:\/\/0\./i, /^https?:\/\/\//i
            ];
            if (blocked.some(p => p.test(targetUrl))) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Access to internal/network addresses is not permitted' }));
            }
            const protocol = parsed.protocol === 'https:' ? https : http;
            let fetchDone = false; // guard: exactly one of end/error/timeout may respond

            const proxyReq = protocol.get(targetUrl, {
                headers: { 'User-Agent': 'AugustProxy/1.0', 'Accept': '*/*' }
            }, function (proxyRes) {
                let data = '';
                proxyRes.on('data', function (chunk) { data += chunk; });
                proxyRes.on('end', function () {
                    if (fetchDone) return;
                    fetchDone = true;
                    if (data.length > 500000) data = data.substring(0, 500000) + '\n\n[Output truncated]';
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: proxyRes.statusCode,
                        headers: proxyRes.headers,
                        contentType: proxyRes.headers['content-type'] || '',
                        body: data
                    }));
                });
            });
            proxyReq.on('error', function (e) {
                if (fetchDone) return; // timeout already replied
                fetchDone = true;
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            });
            proxyReq.setTimeout(15000, function () {
                if (fetchDone) return;
                fetchDone = true;
                proxyReq.destroy(); // safe — error handler is now guarded
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request timed out after 15s' }));
            });
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid URL: ' + e.message }));
        }
        return;
    }

    // ── OpenAI-compatible model list (aggregated from all configured providers) ──
    if (cleanPath.includes('/v1/models') && req.method === 'GET') {
        try {
            const { getModelListOpenAI } = require('./providers/model-list');
            const parsedV1 = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const limit = Math.max(0, parseInt(parsedV1.searchParams.get('limit') || '0', 10) || 0);
            const offset = Math.max(0, parseInt(parsedV1.searchParams.get('offset') || '0', 10) || 0);
            const skeleton = parsedV1.searchParams.get('skeleton') === 'true';
            if (skeleton) {
                const { modelListCache: cache } = require('./providers/model-list');
                res.setHeader('X-August-Models-Cache', cache ? 'warm' : 'pending');
            }
            const payload = await getModelListOpenAI({
                includeClientAliases: true,
                filterRoutable: true,
                limit,
                offset,
                skeleton
            });
            return sendJson(res, payload);
        } catch (e) {
            console.error('[Proxy /v1/models] error:', e.message);
            return sendJson(res, { object: 'list', data: [] });
        }
    }

    // ── August Core Security Gateway ──
    if (cleanPath.startsWith('/v1/')) {
        // Start request logging immediately so it shows up in the UI even if blocked
        let clientType = 'unknown';
        if (cleanPath.includes('/chat/completions') || cleanPath.includes('/responses')) clientType = 'codex';
        else if (cleanPath.includes('/messages')) clientType = 'claude';

        const reqId = startRequest({ clientType, endpoint: cleanPath });

        const config = getConfig();
        const expectedKey = config.august_secret_key || 'august-core-key';

        const authHeader = req.headers['authorization'] || '';
        const xApiKey = req.headers['x-api-key'] || '';
        const xAugustKey = req.headers['x-august-key'] || '';

        const providedKey = (xAugustKey) || (xApiKey) || (authHeader.replace('Bearer ', '').trim());

        // Auto-bypass for Docker local networks (172.x) and localhost (127.x, ::1)
        const ip = req.socket.remoteAddress || '';
        const isLocal = ip.includes('127.0.0.1') || ip === '::1' || ip.startsWith('172.') || ip.startsWith('::ffff:172.') || ip.startsWith('192.168.');

        if (providedKey !== expectedKey && !isLocal) {
            console.warn(`[Security Alert]: Blocked unauthorized access attempt to ${cleanPath} from IP ${ip}`);
            try { emitLogEvent({ category: 'security', level: 'error', message: `Blocked unauthorized access to ${cleanPath} from ${ip}`, metadata: { ip, path: cleanPath, method: req.method } }); } catch (_) {}
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Unauthorized: Invalid August Core Security Key' } }));
            return endRequest(reqId, { status: 'error', error: 'Blocked by Security Gateway (Invalid Key)' });
        }

        // Attach client identity to request for downstream use
        const clientId = identifyClient(req);
        req.augustClientId = clientId;

        // If passed, route to the correct handler
        if (cleanPath.includes('/v1/messages/count_tokens')) {
            return anthropicAdapter.handleCountTokens(req, res, cleanPath, reqId);
        }
        if (clientType === 'codex') {
            return openaiAdapter.handleChatCompletions(req, res, cleanPath, reqId);
        }
        if (clientType === 'claude') {
            return anthropicAdapter.handleMessages(req, res, cleanPath, reqId);
        }
    }

    // ── Session Store API (SQLite-backed, replaces JSON) ──
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const reqPath = parsedUrl.pathname;

    // ── Session Store API ──
    if (reqPath === '/ui/sessions' && req.method === 'GET') {
        const status = parsedUrl.searchParams.get('status') || undefined;
        const agent_type = parsedUrl.searchParams.get('agent_type') || undefined;
        const limit = parseInt(parsedUrl.searchParams.get('limit') || '20');
        const order = parsedUrl.searchParams.get('order') || 'newest';
        try {
            const sessions = sessionStore.listSessions({ status, agent_type, limit, order });
            return sendJson(res, { sessions });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (reqPath === '/ui/sessions/search' && req.method === 'GET') {
        const query = parsedUrl.searchParams.get('q');
        const limit = parseInt(parsedUrl.searchParams.get('limit') || '10');
        if (!query) return sendJson(res, { error: 'Missing query (q) parameter' }, 400);
        try {
            const results = sessionStore.searchSessions(query, { limit });
            return sendJson(res, { results, count: results.length });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (reqPath.startsWith('/ui/sessions/') && req.method === 'GET') {
        const parts = reqPath.split('/');
        const sessionId = decodeURIComponent(parts[3]);
        const sub = parts[4]; // 'messages' or undefined
        try {
            if (sub === 'messages') {
                const limit = parseInt(parsedUrl.searchParams.get('limit') || '50');
                const include_inactive = parsedUrl.searchParams.get('include_inactive') === 'true';
                const messages = sessionStore.getMessages(sessionId, { limit, include_inactive });
                return sendJson(res, { session_id: sessionId, messages, count: messages.length });
            }
            const session = sessionStore.getSession(sessionId);
            if (!session) return sendJson(res, { error: 'Session not found' }, 404);
            return sendJson(res, session);
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    // ── Tool Registry API ──
    if (reqPath === '/ui/tools' && req.method === 'GET') {
        try {
            const tools = toolRegistry.list();
            return sendJson(res, {
                tools: tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    toolset: t.toolset,
                    available: t.isAvailable,
                    permissions: t.permissions,
                    requiresEnv: t.requiresEnv,
                    emoji: t.emoji
                })),
                toolsets: toolRegistry.getToolsets(),
                generation: toolRegistry.getGeneration()
            });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (reqPath === '/ui/tools/definitions' && req.method === 'GET') {
        try {
            const format = parsedUrl.searchParams.get('format') || 'openai';
            const defs = toolRegistry.getDefinitions(format);
            return sendJson(res, { definitions: defs, count: defs.length });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (reqPath === '/ui/tools/dispatch' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { name, args, ctx } = JSON.parse(body);
                const result = await toolRegistry.dispatch(name, args || {}, ctx || {});
                return sendJson(res, result);
            } catch (e) {
                return sendError(res, e, 500);
            }
        });
        return;
    }

    // ── MCP OAuth ──
    if (reqPath === '/ui/mcp-oauth/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { serverName, authUrl, options } = JSON.parse(body);
                const result = await mcpOAuth.startOAuthFlow(serverName, authUrl, options);
                return sendJson(res, result);
            } catch (e) {
                return sendError(res, e, 500);
            }
        });
        return;
    }

    if (reqPath === '/ui/mcp-oauth/status' && req.method === 'GET') {
        const serverName = parsedUrl.searchParams.get('server');
        if (!serverName) return sendJson(res, { error: 'server parameter required' }, 400);
        try {
            const headers = mcpOAuth.getAuthHeaders(serverName);
            const hasAuth = headers && headers.Authorization;
            return sendJson(res, { server: serverName, authenticated: !!hasAuth });
        } catch (e) {
            return sendJson(res, { server: serverName, authenticated: false, error: e.message });
        }
    }

    if (reqPath === '/ui/mcp-oauth/clear' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { serverName } = JSON.parse(body);
                mcpOAuth.clearAuth(serverName);
                return sendJson(res, { success: true });
            } catch (e) {
                return sendError(res, e, 500);
            }
        });
        return;
    }

    // ── MCP OAuth callback receiver (handles redirect from provider) ──
    if (reqPath.startsWith('/ui/mcp-oauth/callback') && req.method === 'GET') {
        try {
            return mcpOAuth.handleAuthCallback(req, res);
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    // ── Cron Job Management ──
    if (reqPath === '/ui/cron' && req.method === 'GET') {
        try {
            const jobs = readCronJobs();
            return sendJson(res, { jobs, count: jobs.length });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (reqPath === '/ui/cron' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const jobData = JSON.parse(body);
                const result = await createCronJobHandler(jobData);
                return sendJson(res, result);
            } catch (e) {
                return sendError(res, e, 500);
            }
        });
        return;
    }

    if (reqPath === '/ui/cron/run' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { name } = JSON.parse(body);
                const result = await runCronJobNowHandler({ name });
                return sendJson(res, { result });
            } catch (e) {
                return sendError(res, e, 500);
            }
        });
        return;
    }

    if (reqPath.startsWith('/ui/cron/') && req.method === 'DELETE') {
        const name = decodeURIComponent(reqPath.split('/').pop());
        try {
            const result = await removeCronJobHandler({ name });
            return sendJson(res, result);
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    // ── Skills V2 (Standardized Skill Management) ──
    if (reqPath === '/ui/skills-v2' && req.method === 'GET') {
        let skills = [];
        try { skills = require('./services/tools/skills').getSkills(); } catch (e) {}
        return sendJson(res, { skills, count: skills.length });
    }

    if (reqPath === '/ui/skills-v2/install' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { url, name, instructions } = JSON.parse(body);
                if (url) {
                    const result = await require('./services/tools/skill-importer').importSkillFromLink(url);
                    return sendJson(res, result);
                }
                if (name && instructions) {
                    require('./services/tools/skills').saveSkill({ name, body: instructions, enabled: true });
                    return sendJson(res, { success: true, name });
                }
                return sendJson(res, { error: 'Provide either url or name+instructions' }, 400);
            } catch (e) {
                return sendError(res, e, 500);
            }
        });
        return;
    }

    // ── Model Catalog API ──
    if (reqPath === '/ui/models/catalog' && req.method === 'GET') {
        try {
            const catalog = require('./services/catalog/model-catalog');
            const provider = parsedUrl.searchParams.get('provider') || undefined;
            const capability = parsedUrl.searchParams.get('capability') || undefined;
            const query = parsedUrl.searchParams.get('q') || undefined;

            let results;
            if (query) results = catalog.search(query);
            else results = catalog.list({ provider, capability, deprecated: false });

            return sendJson(res, { models: results.map(m => m.toJSON()), count: results.length });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (reqPath === '/ui/models/capabilities' && req.method === 'GET') {
        try {
            const catalog = require('./services/catalog/model-catalog');
            return sendJson(res, { capabilities: catalog.getCapabilities() });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    if (reqPath === '/ui/models/estimate-cost' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { modelId, inputTokens, outputTokens } = JSON.parse(body);
                const catalog = require('./services/catalog/model-catalog');
                const model = catalog.get(modelId);
                if (!model) return sendJson(res, { error: 'Unknown model' }, 404);
                const cost = model.estimateCost(inputTokens || 0, outputTokens || 0);
                return sendJson(res, { model: model.id, cost });
            } catch (e) {
                return sendError(res, e, 500);
            }
        });
        return;
    }

    // ── Model aliases endpoint ──
    if (reqPath === '/ui/models/aliases' && req.method === 'GET') {
        try {
            const catalog = require('./services/catalog/model-catalog');
            const models = catalog.getAll();
            const modelAliases = models.filter(m => m.aliases && m.aliases.length > 0)
                .flatMap(m => m.aliases.map(a => ({ alias: a, resolvesTo: m.id, provider: m.provider })));
            return sendJson(res, { aliases: modelAliases });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    // ── Provider options (for dashboard dropdowns) ──
    if (reqPath === '/ui/providers/options' && req.method === 'GET') {
        try {
            const providers = listProviders();
            return sendJson(res, { providers, count: providers.length });
        } catch (e) {
            return sendJson(res, { providers: [], count: 0, error: e.message });
        }
    }

    // ── Fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
};

const server = http.createServer(requestHandler);
module.exports = requestHandler;

registerBuiltinProviders();

console.log(`--- AI Adapter Active on Port ${LISTEN_PORT} ---`);

// ── WebSocket server (noServer mode — upgrades are routed manually) ──
const wss = new WebSocketServer({ noServer: true });

function startServer() {
    server.listen(LISTEN_PORT, '0.0.0.0', () => {
        console.log('[bridge] Server is listening...');
        // Pre-warm the model list cache so the first /api/models call after
        // boot is instant. Fire-and-forget; logs the duration either way.
        try {
            const { prewarmModelList } = require('./providers/model-list');
            prewarmModelList().catch(() => {});
        } catch (_) { /* prewarm is best-effort */ }
    });

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
        if (url.pathname === '/ui/terminal/connect') {
            const terminalId = url.searchParams.get('id');
            wss.handleUpgrade(req, socket, head, (ws) => {
                terminalService.handleTerminalConnection(ws, terminalId);
            });
            return;
        }
        if (url.pathname === '/ui/logs/stream') {
            wss.handleUpgrade(req, socket, head, (ws) => {
                addLogWSClient(ws);
                ws.on('close', () => removeLogWSClient(ws));
                ws.on('error', () => removeLogWSClient(ws));
                // Heartbeat: keep proxies (LAN/Tailscale) from killing idle sockets
                const ping = setInterval(() => {
                    try {
                        if (ws.readyState === 1) ws.ping();
                        else clearInterval(ping);
                    } catch (_) {
                        clearInterval(ping);
                    }
                }, 25000);
                ws.on('close', () => clearInterval(ping));
            });
            return;
        }
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
    });


    // Initialize MCP servers after the HTTP listener is available so the dashboard
    // remains reachable while uvx/npx tools warm their package caches.
    const claudeProfile = getProfile('claude');
    startMcpServers(claudeProfile?.apiKey || '').catch(e => {
        console.error('[bridge] Failed to start MCP servers:', e);
    });
}

const autoUpdateEnabled = process.env.AUGUST_AUTO_UPDATE === '1'
    || (process.env.AUGUST_AUTO_UPDATE !== '0' && process.env.AUGUST_PROXY_DESKTOP === '1');

if (autoUpdateEnabled) {
    require('./services/desktop/asset-updater').checkForUpdates()
        .then(result => {
            if (result.applied) {
                console.log(`[bridge] asset update applied (${result.version}); exiting so the desktop supervisor can restart with new code.`);
                process.exit(0);
            }
            startServer();
        })
        .catch(error => {
            console.warn('[bridge] asset update check failed; starting server anyway:', error.message);
            startServer();
        });
} else {
    startServer();
}

// ── Initialize Session Store (SQLite) ──
(async () => {
    try {
        await sessionStore.init();
        await sessionStore.migrateFromJson();
        console.log('[SessionStore] Ready —', sessionStore.pruneSessions(60), 'old sessions pruned');
    } catch (e) {
        console.error('[SessionStore] Init failed (non-fatal):', e.message);
    }
})();

// ── Register missing tools in the tool registry ──
try {
    registerMissingTools(toolRegistry);
    const registered = toolRegistry.list();
    console.log(`[ToolRegistry] Registered ${registered.length} tools across ${toolRegistry.getToolsets().length} toolsets`);
} catch (e) {
    console.error('[ToolRegistry] Failed to register missing tools:', e.message);
}

// ── Register browser tools ──
try {
    registerBrowserTools(toolRegistry);
    console.log('[BrowserTools] Registered browser tools (browser_navigate, browser_snapshot, browser_click, browser_type, browser_scroll, browser_back, browser_press, browser_console, browser_get_images, browser_vision)');
} catch (e) {
    console.error('[BrowserTools] Failed to register browser tools:', e.message);
}

// ── Register vision tools ──
try {
    registerVisionTools(toolRegistry);
    console.log('[VisionTools] Registered vision tools (august__vision_analyze)');
} catch (e) {
    console.error('[VisionTools] Failed to register vision tools:', e.message);
}

// ── Register delegate tools ──
try {
    registerDelegateTools(toolRegistry);
    console.log('[DelegateTools] Registered delegate tools (august__delegate_task)');
} catch (e) {
    console.error('[DelegateTools] Failed to register delegate tools:', e.message);
}

// ── Register execute tools ──
try {
    registerExecuteTools(toolRegistry);
    console.log('[ExecuteTools] Registered execute tools (august__execute_code)');
} catch (e) {
    console.error('[ExecuteTools] Failed to register execute tools:', e.message);
}

// ── Cleanup browser sessions on exit ──
process.on('exit', () => {
    cleanupBrowserTools().catch(() => {});
});
process.on('SIGINT', () => {
    cleanupBrowserTools().catch(() => {}).finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
    cleanupBrowserTools().catch(() => {}).finally(() => process.exit(0));
});

// ── Initialize Model Catalog ──
try {
    const catalog = require('./services/catalog/model-catalog');
    catalog.init();
    const count = catalog.saveToJson();
    console.log(`[ModelCatalog] Initialized with ${count} models`);
} catch (e) {
    console.warn('[ModelCatalog] Init skipped:', e.message);
}

// ── Start Unified Scheduler ──
// One tick every 30 seconds drives both the LLM-facing cron-jobs runner and
// the UI-facing automation-jobs runner. Replaces the previous dual setInterval
// (cron-tools 30s + automation-jobs 60s) so there is exactly one tick log per
// cycle and the boot path is a single clearInterval call.
try {
    scheduler.start([
        scheduler.runner('cron-jobs', runDueCronJobs, { type: 'I/O', priority: 'low' }),
        scheduler.runner('automation-jobs', automationJobs.runDueAutomations, { type: 'I/O', priority: 'low' }),
    ]);
    console.log('[Scheduler] Started (cron-jobs + automation-jobs)');
} catch (e) {
    console.warn('[Scheduler] start skipped:', e.message);
}



