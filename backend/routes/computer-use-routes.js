/**
 * computer-use-routes.js — API routes for computer use.
 * Provides endpoints for health checks, config, and tool execution.
 */

const { readJsonBody, sendError, sendJson } = require('../lib/http-utils');
const { runHealthChecks, formatHealthReport } = require('../services/computer-use/doctor');
const { getBackend } = require('../services/computer-use/tool');

function jsonBody(req) {
    return readJsonBody(req, { limitBytes: 1024 * 1024 });
}

function route(req, res, method, path, handler) {
    if (req.method !== method) return false;
    if (req.url.pathname !== path) return false;
    handler(req, res).catch(error => sendError(res, error, error.statusCode || 500));
    return true;
}

async function handleComputerUseRoutes(req, res, rawUrl) {
    const requestUrl = new URL(rawUrl, 'http://localhost');
    req.url = requestUrl;
    const path = requestUrl.pathname;

    if (!path.startsWith('/api/computer-use')) {
        req.url = rawUrl;
        return false;
    }

    // GET /api/computer-use/health — Run health checks
    if (route(req, res, 'GET', '/api/computer-use/health', async () => {
        const report = runHealthChecks();
        sendJson(res, report);
    })) return true;

    // GET /api/computer-use/health/report — Get formatted health report
    if (route(req, res, 'GET', '/api/computer-use/health/report', async () => {
        const report = runHealthChecks();
        const formatted = formatHealthReport(report);
        res.setHeader('Content-Type', 'text/markdown');
        res.end(formatted);
    })) return true;

    // GET /api/computer-use/config — Get computer use configuration
    if (route(req, res, 'GET', '/api/computer-use/config', async () => {
        try {
            const { getConfig } = require('../lib/config');
            const config = getConfig();
            sendJson(res, config.computer_use || {
                enabled: false,
                backend: 'cua',
                auto_approve: ['capture'],
                blocklist_keys: ['Cmd+Shift+Backspace', 'Win+L'],
                blocklist_patterns: ['curl|bash', 'rm -rf /']
            });
        } catch (error) {
            sendJson(res, {
                enabled: false,
                backend: 'cua',
                auto_approve: ['capture'],
                blocklist_keys: ['Cmd+Shift+Backspace', 'Win+L'],
                blocklist_patterns: ['curl|bash', 'rm -rf /']
            });
        }
    })) return true;

    // POST /api/computer-use/capture — Capture screen
    if (route(req, res, 'POST', '/api/computer-use/capture', async () => {
        try {
            const backend = await getBackend();
            const result = await backend.capture();
            sendJson(res, {
                elements: result.elements.map(el => ({
                    index: el.index,
                    label: el.label,
                    role: el.role,
                    bounds: {
                        x: el.bounds.x,
                        y: el.bounds.y,
                        width: el.bounds.width,
                        height: el.bounds.height
                    },
                    interactive: el.interactive
                })),
                width: result.width,
                height: result.height,
                timestamp: result.timestamp
            });
        } catch (error) {
            sendError(res, error, 500);
        }
    })) return true;

    // POST /api/computer-use/click — Click on element
    if (route(req, res, 'POST', '/api/computer-use/click', async () => {
        const body = await jsonBody(req);
        const { element_index } = body;

        if (element_index === undefined) {
            sendError(res, new Error('element_index is required'), 400);
            return;
        }

        try {
            const backend = await getBackend();
            const result = await backend.click(element_index);
            sendJson(res, {
                success: result.success,
                message: result.message,
                elements: result.elements?.map(el => ({
                    index: el.index,
                    label: el.label,
                    role: el.role
                }))
            });
        } catch (error) {
            sendError(res, error, 500);
        }
    })) return true;

    // POST /api/computer-use/type — Type text
    if (route(req, res, 'POST', '/api/computer-use/type', async () => {
        const body = await jsonBody(req);
        const { text } = body;

        if (!text) {
            sendError(res, new Error('text is required'), 400);
            return;
        }

        try {
            const backend = await getBackend();
            const result = await backend.typeText(text);
            sendJson(res, {
                success: result.success,
                message: result.message
            });
        } catch (error) {
            sendError(res, error, 500);
        }
    })) return true;

    // POST /api/computer-use/key — Press key
    if (route(req, res, 'POST', '/api/computer-use/key', async () => {
        const body = await jsonBody(req);
        const { key } = body;

        if (!key) {
            sendError(res, new Error('key is required'), 400);
            return;
        }

        try {
            const backend = await getBackend();
            const result = await backend.key(key);
            sendJson(res, {
                success: result.success,
                message: result.message
            });
        } catch (error) {
            sendError(res, error, 500);
        }
    })) return true;

    req.url = rawUrl;
    return false;
}

module.exports = { handleComputerUseRoutes };
