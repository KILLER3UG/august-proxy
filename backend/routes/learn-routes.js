/**
 * learn-routes.js — API routes for skill learning and authoring.
 * Provides endpoints for /learn command, web extraction, and validation.
 */

const { readJsonBody, sendError, sendJson } = require('../lib/http-utils');
const { buildLearnPrompt, validateSkillMd, buildGatherSourcesPrompt } = require('../services/skills/learn-command');
const { extractContent, searchWeb } = require('../services/tools/web-extract');
const validation = require('../services/skills/validation');

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

async function handleLearnRoutes(req, res, rawUrl) {
    const requestUrl = new URL(rawUrl, 'http://localhost');
    req.url = requestUrl;
    const path = requestUrl.pathname;

    if (!path.startsWith('/api/learn')) {
        req.url = rawUrl;
        return false;
    }

    // POST /api/learn/prompt — Generate learn prompt for a source
    if (route(req, res, 'POST', '/api/learn/prompt', async () => {
        const body = await jsonBody(req);
        const { source } = body;

        const prompt = buildLearnPrompt(source);
        const gatherPrompt = buildGatherSourcesPrompt(source || 'the current conversation');

        sendJson(res, {
            prompt,
            gatherPrompt,
            source: source || 'current conversation'
        });
    })) return true;

    // POST /api/learn/extract — Extract content from a URL
    if (route(req, res, 'POST', '/api/learn/extract', async () => {
        const body = await jsonBody(req);
        const { url, provider, depth } = body;

        if (!url) {
            sendError(res, new Error('URL is required'), 400);
            return;
        }

        const result = await extractContent(url, { provider, depth });
        sendJson(res, result);
    })) return true;

    // POST /api/learn/search — Search the web
    if (route(req, res, 'POST', '/api/learn/search', async () => {
        const body = await jsonBody(req);
        const { query, maxResults, depth } = body;

        if (!query) {
            sendError(res, new Error('Query is required'), 400);
            return;
        }

        const result = await searchWeb(query, { maxResults, depth });
        sendJson(res, result);
    })) return true;

    // POST /api/learn/validate — Validate skill content
    if (route(req, res, 'POST', '/api/learn/validate', async () => {
        const body = await jsonBody(req);
        const { content } = body;

        if (!content) {
            sendError(res, new Error('Content is required'), 400);
            return;
        }

        const result = validateSkillMd(content);
        sendJson(res, result);
    })) return true;

    // POST /api/learn/sessions/search — Search past sessions (FTS)
    if (route(req, res, 'POST', '/api/learn/sessions/search', async () => {
        const body = await jsonBody(req);
        const { query, maxResults } = body;

        if (!query) {
            sendError(res, new Error('Query is required'), 400);
            return;
        }

        const { getFtsSearch } = require('../services/memory/fts-search');
        const fts = getFtsSearch();
        const results = await fts.search(query, { maxResults: maxResults || 10 });
        sendJson(res, { results, stats: fts.getStats() });
    })) return true;

    // GET /api/learn/standards — Get authoring standards
    if (route(req, res, 'GET', '/api/learn/standards', async () => {
        sendJson(res, {
            standards: validation.STANDARDS,
            marketingWords: validation.MARKETING_WORDS
        });
    })) return true;

    req.url = rawUrl;
    return false;
}

module.exports = { handleLearnRoutes };
