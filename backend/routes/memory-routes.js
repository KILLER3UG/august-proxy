const { readJsonBody, sendError, sendJson } = require('../lib/http-utils');
const { getConfig, getProfile } = require('../lib/config');
const { DEFAULT_CONTEXT_MAX_CHARS, buildSystemPromptDetails } = require('../services/memory/context-builder');
const { listMemoryItems, searchMemory, updateMemoryItem } = require('../services/memory/memory-lifecycle');
const coreMemory = require('../services/memory/core-memory');
const { getLearningStatus } = require('../services/memory/auto-memory');
const {
    buildMemorySnapshot,
    buildModelMemoryPack,
    exportReadableSnapshot,
    searchBrain
} = require('../services/memory/memory-service');
const {
    commitBrainEdit,
    createBrainEditProposal,
    getBrainEditProposal,
    listBrainEditProposals
} = require('../services/memory/brain-edit-service');
const {
    applyRetentionDecision,
    generateRetentionPlan
} = require('../services/memory/retention-service');
const {
    listModelObservations,
    recordModelObservation
} = require('../services/memory/model-observation-service');
const sqliteStore = require('../services/memory/sqlite-memory-store');
const { listMemoryProviders, prefetchAll } = require('../services/memory/memory-providers');
const { searchGovernanceTargets } = require('../services/memory/memory-governance');
const { listLearnedGuidelines, setLearnedGuidelineStatus } = require('../services/memory/learned-guidelines');
const graphMemory = require('../services/memory/graph-memory');
const vectorDb = require('../services/memory/vector-db');

function jsonBody(req) {
    return readJsonBody(req, { limitBytes: 1024 * 1024 });
}

function route(req, res, method, path, handler) {
    if (req.method !== method) return false;
    if (req.url.pathname !== path) return false;
    handler(req, res).catch(error => sendError(res, error, error.statusCode || 500));
    return true;
}

function routeAny(req, res, path, handler) {
    if (req.url.pathname !== path) return false;
    handler(req, res).catch(error => sendError(res, error, error.statusCode || 500));
    return true;
}

function routeRegex(req, res, methods, regex, handler) {
    if (!methods.includes(req.method)) return false;
    const match = req.url.pathname.match(regex);
    if (!match) return false;
    handler(req, res, match).catch(error => sendError(res, error, error.statusCode || 500));
    return true;
}

async function handleMemoryRoutes(req, res, rawUrl) {
    const requestUrl = new URL(rawUrl, 'http://localhost');
    req.url = requestUrl;
    const path = requestUrl.pathname;
    if (!path.startsWith('/ui/memory') && !path.startsWith('/ui/brain')) return false;

    if (routeAny(req, res, '/ui/memory/items', async () => {
        if (req.method === 'GET') {
            sendJson(res, { items: listMemoryItems() });
            return;
        }
        if (req.method === 'PATCH') {
            sendJson(res, updateMemoryItem(await jsonBody(req)));
        }
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/store/status', async () => {
        sendJson(res, sqliteStore.getMemoryStoreStatus());
    })) return true;

    if (route(req, res, 'POST', '/ui/memory/store/rebuild', async () => {
        const { readVectorEntries, syncSqliteMemoryStore } = require('../services/memory/vector-db');
        const result = syncSqliteMemoryStore();
        sendJson(res, { ...result, vectorEntries: readVectorEntries().length, status: sqliteStore.getMemoryStoreStatus() });
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/providers', async () => {
        const query = requestUrl.searchParams.get('q') || '';
        sendJson(res, {
            providers: listMemoryProviders(),
            recalled: query ? prefetchAll(query) : []
        });
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/provider-events', async () => {
        sendJson(res, { events: sqliteStore.listProviderEvents({ limit: Number(requestUrl.searchParams.get('limit') || 50) }) });
    })) return true;

    if (routeAny(req, res, '/ui/memory/governance', async () => {
        if (req.method === 'GET') {
            sendJson(res, searchGovernanceTargets(requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query') || ''));
            return;
        }
        if (req.method === 'POST') {
            const { applyMemoryGovernance } = require('../services/memory/memory-governance');
            sendJson(res, applyMemoryGovernance(await jsonBody(req)));
        }
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/learning-status', async () => {
        sendJson(res, getLearningStatus());
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/preview', async () => {
        const profileName = requestUrl.searchParams.get('profile') || 'claude';
        const profile = getProfile(profileName);
        const model = profileName === 'claude'
            ? (profile?._upstreamModel || profile?.currentModel)
            : profile?.currentModel;
        const contextMaxChars = Number(requestUrl.searchParams.get('maxChars') || getConfig().memoryContextMaxChars || DEFAULT_CONTEXT_MAX_CHARS);
        const details = buildSystemPromptDetails(null, {
            model,
            targetUrl: profile?.targetUrl,
            includeWindowsContext: profileName !== 'claude',
            contextMaxChars
        });
        sendJson(res, {
            profile: profileName,
            model,
            targetUrl: profile?.targetUrl,
            length: details.length,
            prompt: details.prompt
        });
    })) return true;

    if (route(req, res, 'GET', '/ui/memory', async () => {
        sendJson(res, coreMemory.readAugustCoreMemory());
    })) return true;

    if (route(req, res, 'POST', '/ui/memory', async () => {
        const data = await jsonBody(req);
        const memory = coreMemory.readAugustCoreMemory();
        if (data.global_context !== undefined) memory.global_context = data.global_context;
        if (data.user_profile !== undefined) memory.user_profile = data.user_profile;
        coreMemory.writeAugustCoreMemory(memory);
        sendJson(res, { status: 'ok', memory: coreMemory.readAugustCoreMemory() });
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/snapshot', async () => {
        sendJson(res, exportReadableSnapshot({ includeRaw: requestUrl.searchParams.get('raw') === '1' }));
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/scan', async () => {
        sendJson(res, buildMemorySnapshot({ query: requestUrl.searchParams.get('q') || '' }));
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/search', async () => {
        sendJson(res, searchBrain(requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query') || '', {
            limit: Number(requestUrl.searchParams.get('limit') || 8)
        }));
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/model-pack', async () => {
        sendJson(res, buildModelMemoryPack({
            modelId: requestUrl.searchParams.get('modelId') || requestUrl.searchParams.get('model_id') || '',
            provider: requestUrl.searchParams.get('provider') || '',
            query: requestUrl.searchParams.get('q') || ''
        }));
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/schema', async () => {
        sendJson(res, {
            schema: sqliteStore.listSchemaMeta(),
            status: sqliteStore.getMemoryStoreStatus()
        });
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/providers', async () => {
        sendJson(res, { providers: listMemoryProviders() });
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/provider-events', async () => {
        sendJson(res, { events: sqliteStore.listProviderEvents({ limit: Number(requestUrl.searchParams.get('limit') || 50) }) });
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/governance', async () => {
        sendJson(res, searchGovernanceTargets(requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query') || ''));
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/vector', async () => {
        sendJson(res, { entries: vectorDb.readVectorEntries().slice(0, Number(requestUrl.searchParams.get('limit') || 50)) });
    })) return true;

    if (routeAny(req, res, '/ui/memory/proposals', async () => {
        if (req.method === 'GET') {
            sendJson(res, { proposals: listBrainEditProposals({ status: requestUrl.searchParams.get('status') || 'pending', limit: Number(requestUrl.searchParams.get('limit') || 100) }) });
            return;
        }
        if (req.method === 'POST') {
            const proposal = createBrainEditProposal(await jsonBody(req));
            sendJson(res, { proposal }, 201);
        }
    })) return true;

    if (routeRegex(req, res, ['GET', 'POST'], /^\/ui\/memory\/proposals\/([^/]+)(?:\/commit)?$/, async (_req, _res, match) => {
        const proposal = getBrainEditProposal(match[1]);
        if (!proposal) {
            sendError(res, new Error(`Proposal not found: ${match[1]}`), 404);
            return;
        }
        if (req.method === 'POST') {
            const body = await jsonBody(req);
            const committed = commitBrainEdit(match[1], { ...body, actor: body.actor });
            sendJson(res, committed);
            return;
        }
        sendJson(res, { proposal });
    })) return true;

    if (route(req, res, 'GET', '/ui/memory/retention', async () => {
        sendJson(res, generateRetentionPlan({
            query: requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query') || '',
            limit: Number(requestUrl.searchParams.get('limit') || 80)
        }));
    })) return true;

    if (route(req, res, 'POST', '/ui/memory/retention/apply', async () => {
        sendJson(res, applyRetentionDecision(await jsonBody(req)));
    })) return true;

    if (routeAny(req, res, '/ui/memory/model-observations', async () => {
        if (req.method === 'GET') {
            sendJson(res, { observations: listModelObservations({ limit: Number(requestUrl.searchParams.get('limit') || 50), modelId: requestUrl.searchParams.get('modelId') || requestUrl.searchParams.get('model_id') || '' }) });
            return;
        }
        if (req.method === 'POST') {
            sendJson(res, recordModelObservation(await jsonBody(req)), 201);
        }
    })) return true;

    if (routeAny(req, res, '/ui/brain/diagnostics', async () => {
        const snapshot = buildMemorySnapshot({
            coreItems: 0,
            semanticFacts: 0,
            sqliteFacts: 0,
            memories: 0,
            vectorEntries: 0,
            guidelines: 0,
            modelObservations: 0
        });
        sendJson(res, {
            generatedAt: snapshot.generatedAt,
            counts: snapshot.counts,
            sqlite: snapshot.sqlite.status,
            providers: snapshot.providers,
            schema: sqliteStore.listSchemaMeta()
        });
    })) return true;

    if (route(req, res, 'GET', '/ui/brain/failures', async () => {
        const snapshot = buildMemorySnapshot({ modelObservations: 50 });
        const failures = snapshot.modelObservations.items.filter(item => item.observationType === 'tool_failure' || item.observationType === 'failure');
        sendJson(res, { failures });
    })) return true;

    if (route(req, res, 'GET', '/ui/brain/guidelines', async () => {
        sendJson(res, { guidelines: listLearnedGuidelines({ status: requestUrl.searchParams.get('status') || 'all' }) });
    })) return true;

    if (route(req, res, 'POST', '/ui/brain/guidelines/status', async () => {
        const body = await jsonBody(req);
        const item = setLearnedGuidelineStatus(body.id || body.text, body.status, { reason: body.reason || '', actor: body.actor || 'system' });
        if (!item) sendError(res, new Error('Guideline not found'), 404);
        else sendJson(res, { guideline: item });
    })) return true;

    if (route(req, res, 'POST', '/ui/brain/graph/index', async () => {
        const body = await jsonBody(req);
        sendJson(res, body?.text ? graphMemory.indexTextToGraph(body.text, body.options || {}) : graphMemory.indexCoreMemory());
    })) return true;

    if (routeAny(req, res, '/ui/brain/graph', async () => {
        if (req.method === 'GET') {
            const query = requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query') || '';
            sendJson(res, {
                stats: graphMemory.graphStats(),
                search: query ? graphMemory.searchGraph(query, { limit: Number(requestUrl.searchParams.get('limit') || 20) }) : []
            });
            return;
        }
        if (req.method === 'POST') {
            const body = await jsonBody(req);
            if (body.text) sendJson(res, graphMemory.indexTextToGraph(body.text, body.options || {}));
            else sendJson(res, graphMemory.indexCoreMemory());
        }
    })) return true;

    sendError(res, new Error('Unknown memory route'), 404);
    return true;
}

module.exports = {
    handleMemoryRoutes
};
