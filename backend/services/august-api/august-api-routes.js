/**
 * HTTP routes for /ui/august/* — Task 4 self-management API surface.
 *
 * Mounted from backend/index.js. Each route is intentionally thin — it
 * delegates to backend/services/august-api/august-api.js for the actual
 * service-layer logic.
 */

function isMutatingAction(action) {
    return ['create', 'update', 'rename', 'delete', 'archive', 'restore', 'select', 'upsert', 'set'].includes(String(action || ''));
}

async function readJsonBody(req) {
    const { readJsonBody } = require('../../lib/http-utils');
    return readJsonBody(req);
}

async function handleAugustApiRoute(req, res, { url, method, sendJson, sendError }) {
    const api = require('./august-api');

    // GET /ui/august/snapshot
    if (url === '/ui/august/snapshot' && method === 'GET') {
        return sendJson(res, api.buildSnapshot());
    }

    // POST /ui/august/sessions/manage  { action, ... }
    if (url === '/ui/august/sessions/manage' && method === 'POST') {
        const body = await readJsonBody(req);
        const action = body.action;
        if (action === 'list') {
            return sendJson(res, { ok: true, sessions: await api.listSessions(body) });
        }
        if (action === 'create') {
            return sendJson(res, { ok: true, session: await api.createSession(body) });
        }
        if (action === 'update') {
            return sendJson(res, { ok: true, session: await api.updateSession(body.id, body.updates || {}) });
        }
        if (action === 'rename') {
            return sendJson(res, { ok: true, session: await api.renameSession(body.id, body.title) });
        }
        if (action === 'archive') {
            return sendJson(res, { ok: true, session: await api.archiveSession(body.id) });
        }
        if (action === 'restore') {
            return sendJson(res, { ok: true, session: await api.restoreSession(body.id) });
        }
        if (action === 'delete') {
            return sendJson(res, await api.deleteSession(body.id));
        }
        return sendError(res, new Error(`Unknown sessions action: ${action}`), 400);
    }

    // POST /ui/august/settings/update  { key_path, value }
    if (url === '/ui/august/settings/update' && method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, api.updateSetting(body.key_path, body.value));
    }

    // POST /ui/august/models/select  { model, provider }
    if (url === '/ui/august/models/select' && method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, api.selectModel(body.model, body.provider));
    }

    // POST /ui/august/providers/manage  { action, provider }
    if (url === '/ui/august/providers/manage' && method === 'POST') {
        const body = await readJsonBody(req);
        const action = body.action;
        if (action === 'upsert') return sendJson(res, api.upsertProvider(body.provider));
        if (action === 'delete') return sendJson(res, api.deleteProvider(body.id || body.provider?.id));
        return sendError(res, new Error(`Unknown providers action: ${action}`), 400);
    }

    // POST /ui/august/agents/manage  { action, agent }
    if (url === '/ui/august/agents/manage' && method === 'POST') {
        const body = await readJsonBody(req);
        const action = body.action;
        if (action === 'upsert') return sendJson(res, api.upsertAgent(body.agent));
        if (action === 'delete') return sendJson(res, api.deleteAgent(body.id || body.agent?.id));
        return sendError(res, new Error(`Unknown agents action: ${action}`), 400);
    }

    // POST /ui/august/memory/manage  { action, key, value, category, ttl_days }
    if (url === '/ui/august/memory/manage' && method === 'POST') {
        const body = await readJsonBody(req);
        const action = body.action;
        if (action === 'upsert' || action === 'set') {
            return sendJson(res, api.updateMemoryFact({ key: body.key, value: body.value, category: body.category, ttl_days: body.ttl_days }));
        }
        if (action === 'delete' || action === 'forget') {
            return sendJson(res, api.deleteMemoryFact(body.key));
        }
        return sendError(res, new Error(`Unknown memory action: ${action}`), 400);
    }

    // POST /ui/august/rollback/:id/undo
    if (url.startsWith('/ui/august/rollback/') && url.endsWith('/undo') && method === 'POST') {
        const id = url.split('/').slice(-2, -1)[0];
        try {
            const entry = await api.rollbackUndo(id);
            return sendJson(res, { ok: true, entry });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }

    if (url === '/ui/august/computer/app-policy' && method === 'POST') {
        const body = await readJsonBody(req);
        const { setAppPolicy, deleteAppPolicy, listAppPolicies, getAppPolicy } = require('../computer/app-allowlist');
        const action = body.action;
        if (action === 'set') {
            try {
                return sendJson(res, setAppPolicy(body.app, body.policy));
            } catch (e) {
                return sendError(res, e, 400);
            }
        }
        if (action === 'delete') {
            try {
                return sendJson(res, deleteAppPolicy(body.app));
            } catch (e) {
                return sendError(res, e, 400);
            }
        }
        if (action === 'list') {
            return sendJson(res, { ok: true, policies: listAppPolicies() });
        }
        if (action === 'get') {
            return sendJson(res, { ok: true, app: body.app, policy: getAppPolicy(body.app) });
        }
        return sendError(res, new Error(`Unknown app-policy action: ${action}`), 400);
    }

    // ----- Aliases management -----
    if (url === '/ui/august/aliases/manage' && method === 'POST') {
        const body = await readJsonBody(req);
        const action = body.action;
        if (action === 'list') return sendJson(res, api.listAliases());
        if (action === 'upsert') return sendJson(res, api.upsertAlias(body.alias, body.targetModel, body.targetProvider));
        if (action === 'delete') return sendJson(res, api.deleteAlias(body.alias));
        return sendError(res, new Error(`Unknown aliases action: ${action}`), 400);
    }

    // ----- Tool management (MCP + plugins) -----
    if (url === '/ui/august/tools/manage' && method === 'POST') {
        const body = await readJsonBody(req);
        const action = body.action;
        if (action === 'list') return sendJson(res, api.listTools());
        if (action === 'upsert') return sendJson(res, api.upsertTool(body.kind, body.name, body.config));
        if (action === 'delete') return sendJson(res, api.deleteTool(body.kind, body.name));
        return sendError(res, new Error(`Unknown tools action: ${action}`), 400);
    }

    // ----- Task 5: UI automation -----
    if (url === '/ui/august/ui-action' && method === 'POST') {
        const body = await readJsonBody(req);
        try {
            const { createUiEvent } = require('../ui/ui-automation');
            const event = createUiEvent({ action: body.action, target: body.target, payload: body.payload });
            return sendJson(res, { ok: true, event });
        } catch (e) {
            return sendError(res, e, 400);
        }
    }
    if (url === '/ui/august/ui-events' && method === 'GET') {
        try {
            const { listUiEvents } = require('../ui/ui-automation');
            const parsed = new URL(url, 'http://localhost');
            const since = parsed.searchParams.get('since');
            return sendJson(res, { ok: true, events: listUiEvents({ since }) });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    return null; // route not handled here
}

module.exports = { handleAugustApiRoute, isMutatingAction };
