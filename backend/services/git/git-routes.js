/* ── git-routes ─ HTTP handlers for /api/git/* ────────────────────── */
/* Workspace resolution: sessionId → session.cwd (looked up in the         */
/* session store). Optionally, the client can pass `workspace` in the     */
/* query / body to override.                                              */

const { readJsonBody, sendError, sendJson } = require('../../lib/http-utils');
const git = require('./git-service');

function getSessionIdFromUrl(req) {
    try {
        const url = new URL(req.url, 'http://x');
        return url.searchParams.get('sessionId') || url.searchParams.get('session');
    } catch { return null; }
}

async function handleGitRoutes(req, res) {
    if (!req.url.startsWith('/api/git/')) return false;

    const sessionId = getSessionIdFromUrl(req);
    const ctx = { sessionId };

    try {
        if (req.url.startsWith('/api/git/status') && req.method === 'GET') {
            sendJson(res, await git.getStatus(ctx));
            return true;
        }
        if (req.url.startsWith('/api/git/branch') && req.method === 'GET') {
            sendJson(res, await git.getCurrentBranch(ctx));
            return true;
        }
        if (req.url.startsWith('/api/git/branches') && req.method === 'GET') {
            sendJson(res, await git.listBranches(ctx));
            return true;
        }
        if (req.url.startsWith('/api/git/commit') && req.method === 'POST') {
            const body = await readJsonBody(req);
            const message = (body && body.message) || '';
            sendJson(res, await git.commit({ ...ctx, message }));
            return true;
        }
        if (req.url.startsWith('/api/git/checkout') && req.method === 'POST') {
            const body = await readJsonBody(req);
            const branch = (body && body.branch) || '';
            sendJson(res, await git.checkout({ ...ctx, branch }));
            return true;
        }
    } catch (err) {
        sendError(res, err, 500);
        return true;
    }
    return false;
}

module.exports = { handleGitRoutes };
