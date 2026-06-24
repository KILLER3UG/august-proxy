/**
 * curator-routes.js — API routes for skill curator lifecycle management.
 * Provides endpoints for status, run, pause/unpause, and skill pinning.
 */

const { readJsonBody, sendError, sendJson } = require('../lib/http-utils');
const curator = require('../services/skills/curator');
const skillUsage = require('../services/skills/skill-usage');

function jsonBody(req) {
    return readJsonBody(req, { limitBytes: 1024 * 1024 });
}

function route(req, res, method, path, handler) {
    if (req.method !== method) return false;
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

async function handleCuratorRoutes(req, res, rawUrl) {
    const requestUrl = new URL(rawUrl, 'http://localhost');
    req.url = requestUrl;
    const path = requestUrl.pathname;

    if (!path.startsWith('/api/curator')) {
        req.url = rawUrl;
        return false;
    }

    // GET /api/curator/status
    if (route(req, res, 'GET', '/api/curator/status', async () => {
        sendJson(res, curator.getStatus());
    })) return true;

    // POST /api/curator/run
    if (route(req, res, 'POST', '/api/curator/run', async () => {
        const body = await jsonBody(req);
        const result = curator.runCuratorReview({
            dryRun: body.dry_run || false,
            consolidate: body.consolidate || false
        });
        sendJson(res, result);
    })) return true;

    // POST /api/curator/pause
    if (route(req, res, 'POST', '/api/curator/pause', async () => {
        curator.pause();
        sendJson(res, { success: true, paused: true });
    })) return true;

    // POST /api/curator/unpause
    if (route(req, res, 'POST', '/api/curator/unpause', async () => {
        curator.unpause();
        sendJson(res, { success: true, paused: false });
    })) return true;

    // GET /api/curator/skills
    if (route(req, res, 'GET', '/api/curator/skills', async () => {
        sendJson(res, skillUsage.usageReport());
    })) return true;

    // POST /api/curator/skills/:name/pin
    if (routeRegex(req, res, ['POST'], /^\/api\/curator\/skills\/([^/]+)\/pin$/, async (req, res, match) => {
        const skillName = decodeURIComponent(match[1]);
        const body = await jsonBody(req);
        const result = skillUsage.setPinned(skillName, body.pinned);
        sendJson(res, { success: result });
    })) return true;

    // POST /api/curator/skills/:name/archive
    if (routeRegex(req, res, ['POST'], /^\/api\/curator\/skills\/([^/]+)\/archive$/, async (req, res, match) => {
        const skillName = decodeURIComponent(match[1]);
        const result = skillUsage.archiveSkill(skillName);
        sendJson(res, { success: result });
    })) return true;

    // POST /api/curator/skills/:name/restore
    if (routeRegex(req, res, ['POST'], /^\/api\/curator\/skills\/([^/]+)\/restore$/, async (req, res, match) => {
        const skillName = decodeURIComponent(match[1]);
        const result = skillUsage.restoreSkill(skillName);
        sendJson(res, { success: result });
    })) return true;

    req.url = rawUrl;
    return false;
}

module.exports = { handleCuratorRoutes };
