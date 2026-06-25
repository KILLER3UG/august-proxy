/* ── usage-routes ─ HTTP handlers for the Usage tab ────────────────── */
/* Three GET endpoints backed by usage-aggregator.js:                    */
/*   • /api/usage/stats?range=7d|30d                                    */
/*   • /api/usage/heatmap?range=7d|30d                                  */
/*   • /api/usage/by-model?range=7d|30d                                 */
/*   • /api/usage/session?id=<sessionId>  (per-session usage)           */

const { getStats, getHeatmap, getByModel, getByDay } = require('./usage-aggregator');
const { listUsageEvents } = require('../storage/session-store');
const { sendJson } = require('../../lib/http-utils');

function parseRange(req) {
    try {
        const url = new URL(req.url, 'http://x');
        const r = url.searchParams.get('range');
        return r === '7d' ? '7d' : '30d';
    } catch {
        return '30d';
    }
}

function handleUsageRoutes(req, res) {
    if (req.method !== 'GET') return false;

    if (req.url.startsWith('/api/usage/session')) {
        try {
            const url = new URL(req.url, 'http://x');
            const sessionId = url.searchParams.get('id');
            if (!sessionId) {
                sendJson(res, { error: 'Missing session id' }, 400);
                return true;
            }
            const events = listUsageEvents(sessionId);
            const aggregated = {
                sessionId,
                totalEvents: events.length,
                totalInputTokens: events.reduce((s, e) => s + (e.input_tokens || 0), 0),
                totalOutputTokens: events.reduce((s, e) => s + (e.output_tokens || 0), 0),
                totalTokens: events.reduce((s, e) => s + (e.total_tokens || 0), 0),
                totalCost: events.reduce((s, e) => s + (e.total_cost || 0), 0),
                model: events.length > 0 ? events[0].model : null,
                provider: events.length > 0 ? events[0].provider : null,
                events: events.map(e => ({
                    id: e.id,
                    requestType: e.request_type,
                    model: e.model,
                    inputTokens: e.input_tokens,
                    outputTokens: e.output_tokens,
                    totalTokens: e.total_tokens,
                    totalCost: e.total_cost,
                    createdAt: e.created_at,
                })),
            };
            sendJson(res, aggregated);
        } catch (err) { return false; }
        return true;
    }

    if (req.url.startsWith('/api/usage/stats')) {
        try { sendJson(res, getStats(parseRange(req))); }
        catch (err) { return false; }
        return true;
    }
    if (req.url.startsWith('/api/usage/heatmap')) {
        try { sendJson(res, { results: getHeatmap(parseRange(req)) }); }
        catch (err) { return false; }
        return true;
    }
    if (req.url.startsWith('/api/usage/by-model')) {
        try { sendJson(res, { results: getByModel(parseRange(req)) }); }
        catch (err) { return false; }
        return true;
    }
    if (req.url.startsWith('/api/usage/by-day')) {
        try { sendJson(res, { results: getByDay(parseRange(req)) }); }
        catch (err) { return false; }
        return true;
    }
    return false;
}

module.exports = { handleUsageRoutes };
