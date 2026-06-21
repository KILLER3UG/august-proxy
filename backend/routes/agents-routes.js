/**
 * agents-routes.js — sub-agent tree API surface.
 *
 * Routes:
 *   GET  /ui/agents/tree?root=<id>&maxDepth=<n>
 *   GET  /ui/agents/roots?status=<s>&limit=<n>&sessionId=<id>
 *   GET  /ui/agents/job/:id
 *
 * Returns plain JSON; the UI builds the tree from `getTree(rootId)`.
 */

const { sendJson, sendError } = require('../lib/http-utils');
const agentTree = require('../services/tools/agent-tree');

function handleAgentsRoutes(req, res, reqPath, parsedUrl) {
    if (req.method !== 'GET') return false;

    // GET /ui/agents/tree?root=<id>&maxDepth=<n>
    if (reqPath === '/ui/agents/tree' || reqPath === '/ui/agents/tree/') {
        try {
            const rootId = parsedUrl.searchParams.get('root');
            const maxDepth = Math.max(1, Math.min(8, parseInt(parsedUrl.searchParams.get('maxDepth') || '4', 10) || 4));
            if (!rootId) return sendJson(res, { error: 'Missing root query parameter' }, 400);
            const tree = agentTree.getTree(rootId, { maxDepth });
            if (!tree) return sendJson(res, { error: 'Root not found', rootId }, 404);
            return sendJson(res, { tree, rootId, maxDepth });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    // GET /ui/agents/roots?status=&limit=&sessionId=
    if (reqPath === '/ui/agents/roots' || reqPath === '/ui/agents/roots/') {
        try {
            const status = parsedUrl.searchParams.get('status') || null;
            const limit = Math.max(1, Math.min(500, parseInt(parsedUrl.searchParams.get('limit') || '50', 10) || 50));
            const sessionId = parsedUrl.searchParams.get('sessionId') || null;
            const roots = agentTree.listRoots({ status, limit, sessionId });
            return sendJson(res, { roots, count: roots.length });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    // GET /ui/agents/job/:id
    const jobMatch = reqPath.match(/^\/ui\/agents\/job\/([^/]+)\/?$/);
    if (jobMatch) {
        try {
            const id = decodeURIComponent(jobMatch[1]);
            const node = agentTree.getById(id);
            if (!node) return sendJson(res, { error: 'Job not found', id }, 404);
            const children = agentTree.listChildren(id, { maxDepth: 4 });
            return sendJson(res, { job: node, children });
        } catch (e) {
            return sendError(res, e, 500);
        }
    }

    return false;
}

module.exports = {
    handleAgentsRoutes
};