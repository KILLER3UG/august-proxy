/**
 * Observability routes — consolidates /ui/audit, /ui/rollback, /ui/observations,
 * /ui/host-agent/health, /ui/security, /ui/observability/overview.
 *
 * Mounted from backend/index.js via handleObservabilityRoute.
 */

const fs = require('fs');
const path = require('path');
const { dataPath } = require('../../lib/data-paths');

const OBSERVATIONS_DIR = dataPath('computer-observations');
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function readJsonBody(req) {
    const { readJsonBody } = require('../../lib/http-utils');
    return readJsonBody(req);
}

// ============================================================================
// /ui/audit  +  /ui/rollback
// ============================================================================

function handleAuditRoute(url, method, res, sendJson, sendError) {
    if (url.startsWith('/ui/audit') && method === 'GET') {
        try {
            const { readAuditEntries } = require('../audit/audit-log');
            const parsed = new URL(url, 'http://localhost');
            const limit  = Number(parsed.searchParams.get('limit') || 200);
            const category = parsed.searchParams.get('category') || undefined;
            const actor    = parsed.searchParams.get('actor')    || undefined;
            const action   = parsed.searchParams.get('action')   || undefined;
            const since    = parsed.searchParams.get('since')    || undefined;
            const until    = parsed.searchParams.get('until')    || undefined;
            const summary  = parsed.searchParams.get('summary')  === '1' || parsed.searchParams.get('summary') === 'true';

            if (summary) {
                sendJson(res, readAuditEntries({ summary: true }));
            } else {
                const entries = readAuditEntries({ limit, category, actor, action, since, until });
                sendJson(res, { entries, total: entries.length, at: new Date().toISOString() });
            }
            return true;
        } catch (e) {
            sendError(res, e, 500);
            return true;
        }
    }
    return null;
}

function handleRollbackRoute(url, method, res, sendJson, sendError) {
    if (url.startsWith('/ui/rollback') && (url === '/ui/rollback' || url.startsWith('/ui/rollback?')) && method === 'GET') {
        try {
            const { listRollbacks } = require('../rollback/rollback-store');
            const parsed = new URL(url, 'http://localhost');
            const limit  = Number(parsed.searchParams.get('limit') || 100);
            const status = parsed.searchParams.get('status') || undefined;
            const type   = parsed.searchParams.get('type')   || undefined;
            const summary = parsed.searchParams.get('summary') === '1' || parsed.searchParams.get('summary') === 'true';

            if (summary) sendJson(res, listRollbacks({ summary: true }));
            else {
                const items = listRollbacks({ limit, status, type });
                sendJson(res, { items, total: items.length, at: new Date().toISOString() });
            }
            return true;
        } catch (e) {
            sendError(res, e, 500);
            return true;
        }
    }
    return null;
}

// ============================================================================
// /ui/observations  +  /ui/observations/:id.png
// ============================================================================

function listObservationsSync({ limit = 60, since } = {}) {
    if (!fs.existsSync(OBSERVATIONS_DIR)) return [];
    const files = fs.readdirSync(OBSERVATIONS_DIR).filter(f => f.endsWith('.png'));
    if (files.length === 0) return [];

    const { readAuditEntries } = require('../audit/audit-log');
    const audits = readAuditEntries({ limit: 5000 });
    const byId = new Map();
    for (const a of audits) {
        const po = a.postObservation;
        if (po && po.screenshotPath) {
            const id = path.basename(po.screenshotPath, '.png');
            byId.set(id, { id, ...po, audit: a });
        }
    }

    const out = [];
    for (const f of files) {
        const id = f.replace(/\.png$/, '');
        const m = byId.get(id);
        if (m && (!since || m.capturedAt >= since)) out.push(m);
    }
    out.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
    return out.slice(0, Math.max(1, Number(limit) || 60));
}

function handleObservationRoute(url, method, req, res, sendJson, sendError) {
    // GET /ui/observations?limit=&since=
    if (url.startsWith('/ui/observations') && (url === '/ui/observations' || url.startsWith('/ui/observations?')) && method === 'GET') {
        try {
            const parsed = new URL(url, 'http://localhost');
            const limit = Number(parsed.searchParams.get('limit') || 60);
            const since = parsed.searchParams.get('since') || undefined;
            const items = listObservationsSync({ limit, since });
            sendJson(res, { items, total: items.length, at: new Date().toISOString() });
            return true;
        } catch (e) {
            sendError(res, e, 500);
            return true;
        }
    }
    // GET /ui/observations/:id.png  (or any /ui/observations/*.png URL)
    const pngMatch = url.match(/^\/ui\/observations\/([^?]+)\.png$/i);
    if (pngMatch && method === 'GET') {
        const id = pngMatch[1];
        if (!UUID_RE.test(id)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('bad id');
            return true;
        }
        const file = path.join(OBSERVATIONS_DIR, `${id}.png`);
        if (!file.startsWith(OBSERVATIONS_DIR)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('forbidden');
            return true;
        }
        if (!fs.existsSync(file)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return true;
        }
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'private, max-age=60',
            'Content-Length': String(fs.statSync(file).size)
        });
        fs.createReadStream(file).pipe(res);
        return true;
    }
    return null;
}

// ============================================================================
// /ui/host-agent/health
// ============================================================================

async function getHostAgentHealth() {
    const { getStatus } = require('../../lib/host-agent');
    const { readAuditEntries } = require('../audit/audit-log');
    const audits = readAuditEntries({ limit: 5000 });
    const computerEntries = audits.filter(a => a.category === 'computer');
    const postObsEntries  = audits.filter(a => a.action === 'computer.post_observation');
    let status = 'disconnected';
    try { status = await getStatus(); } catch (_) { /* keep disconnected */ }
    return {
        status,
        lastComputerActionAt: computerEntries[0] ? computerEntries[0].at : null,
        lastComputerAction:   computerEntries[0] ? computerEntries[0].action : null,
        lastComputerTarget:   computerEntries[0] ? computerEntries[0].target : null,
        lastObservationAt:    postObsEntries[0] && postObsEntries[0].postObservation ? postObsEntries[0].postObservation.capturedAt : null,
        lastObservedApp:      postObsEntries[0] && postObsEntries[0].postObservation ? postObsEntries[0].postObservation.focusedApp : null,
        postObservationCount: postObsEntries.length,
        at: new Date().toISOString()
    };
}

async function handleHealthRoute(url, method, res, sendJson, sendError) {
    if (url === '/ui/host-agent/health' && method === 'GET') {
        try {
            sendJson(res, await getHostAgentHealth());
            return true;
        } catch (e) {
            sendError(res, e, 500);
            return true;
        }
    }
    return null;
}

// ============================================================================
// PUT /ui/security
// ============================================================================

function handleSecurityRoute(url, method, req, res, sendJson, sendError) {
    if (url === '/ui/security' && (method === 'PUT' || method === 'POST')) {
        return readJsonBody(req).then(body => {
            if (!body || typeof body !== 'object') {
                sendError(res, new Error('body must be a JSON object'), 400);
                return true;
            }
            const { saveComputerRoots } = require('../permissions/permission-profiles');
            const updated = saveComputerRoots({
                allowedRoots: Array.isArray(body.allowedRoots) ? body.allowedRoots : undefined,
                filesystemScope: typeof body.filesystemScope === 'string' ? body.filesystemScope : undefined,
                postObservationScreenshot: typeof body.postObservationScreenshot === 'boolean' ? body.postObservationScreenshot : undefined
            });
            sendJson(res, { ok: true, security: updated });
            return true;
        }).catch(e => {
            sendError(res, e, 400);
            return true;
        });
    }
    return null;
}

// ============================================================================
// GET /ui/observability/overview
// ============================================================================

async function getObservabilityOverview({ range = '30d' } = {}) {
    const { readAuditEntries } = require('../audit/audit-log');
    const { listRollbacks } = require('../rollback/rollback-store');
    const { listAppPolicies } = require('../computer/app-allowlist');
    const auditSummary = readAuditEntries({ summary: true });
    const rollbackSummary = listRollbacks({ summary: true });
    const policies = listAppPolicies();
    const policyCounts = { allow: 0, ask: 0, deny: 0 };
    for (const v of Object.values(policies || {})) {
        if (v in policyCounts) policyCounts[v] += 1;
    }
    const hostHealth = await getHostAgentHealth();
    return {
        range,
        audit: auditSummary,
        rollback: rollbackSummary,
        appPolicy: { policies, counts: policyCounts, defaultPolicy: 'ask' },
        hostAgent: hostHealth,
        at: new Date().toISOString()
    };
}

async function handleOverviewRoute(url, method, res, sendJson, sendError) {
    if (url.startsWith('/ui/observability/overview') && method === 'GET') {
        try {
            const parsed = new URL(url, 'http://localhost');
            const range = parsed.searchParams.get('range') || '30d';
            sendJson(res, await getObservabilityOverview({ range }));
            return true;
        } catch (e) {
            sendError(res, e, 500);
            return true;
        }
    }
    return null;
}

// ============================================================================
// Single dispatcher used by index.js
// ============================================================================

async function handleObservabilityRoute(req, res, { url, method, sendJson, sendError }) {
    // Audit
    const auditHandled = handleAuditRoute(url, method, res, sendJson, sendError);
    if (auditHandled !== null) return auditHandled;

    // Rollback
    const rbHandled = handleRollbackRoute(url, method, res, sendJson, sendError);
    if (rbHandled !== null) return rbHandled;

    // Observations
    const obsHandled = handleObservationRoute(url, method, req, res, sendJson, sendError);
    if (obsHandled !== null) return obsHandled;

    // Host-agent health
    const healthHandled = await handleHealthRoute(url, method, res, sendJson, sendError);
    if (healthHandled !== null) return healthHandled;

    // Security write-back
    const secHandled = await handleSecurityRoute(url, method, req, res, sendJson, sendError);
    if (secHandled !== null) return secHandled;

    // Overview
    const ovHandled = await handleOverviewRoute(url, method, res, sendJson, sendError);
    if (ovHandled !== null) return ovHandled;

    return null; // not handled
}

module.exports = {
    handleObservabilityRoute,
    // exported for tests
    _internals: {
        listObservationsSync,
        getHostAgentHealth,
        getObservabilityOverview
    }
};
