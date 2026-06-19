/* ── usage-routes ─ HTTP handlers for the Usage tab ────────────────── */
/* Three GET endpoints backed by usage-aggregator.js:                    */
/*   • /api/usage/stats?range=7d|30d                                    */
/*   • /api/usage/heatmap?range=7d|30d                                  */
/*   • /api/usage/by-model?range=7d|30d                                 */

const { getStats, getHeatmap, getByModel, getByDay } = require('./usage-aggregator');
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
