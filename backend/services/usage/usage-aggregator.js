/* ── usage-aggregator ─ aggregate token usage from session-store ── */
/* Reads from the existing SQLite session store (sessions + messages    */
/* tables) and produces three views used by the Settings → Usage tab:    */
/*   • getStats(range)   — totals + favorite model + active-day count  */
/*   • getHeatmap(range) — per-day message count (for the GitHub-style  */
/*                         activity heatmap)                            */
/*   • getByModel(range) — token share per model (for the donut chart) */
/*                                                                       */
/* All read-only; data is whatever the adapters have written to the     */
/* session store. No new schema required.                                */

const { listSessions, getMessages } = require('../storage/session-store');

const DAY_MS = 24 * 60 * 60 * 1000;

function rangeStart(range) {
    const now = new Date();
    const days = range === '7d' ? 7 : 30;
    return new Date(now.getTime() - days * DAY_MS);
}

function ymd(date) {
    const d = new Date(date);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function inRange(iso, start) {
    return new Date(iso).getTime() >= start.getTime();
}

/** Top-level stats: total tokens, sessions, messages, active days, current streak, favorite model. */
function getStats(range = '30d') {
    const start = rangeStart(range);
    const sessions = listSessions().filter(s => inRange(s.created_at, start));
    const totalTokens = sessions.reduce((sum, s) => sum + (s.total_tokens || 0), 0);
    const messages = sessions.reduce((sum, s) => sum + (s.message_count || 0), 0);

    // Active days: distinct YMD of any session created_at
    const activeDays = new Set();
    sessions.forEach(s => activeDays.add(ymd(s.created_at)));

    // Current streak: walk back from today, counting consecutive days
    // that have at least one session.
    const today = new Date();
    let currentStreak = 0;
    for (let i = 0; i < 365; i++) {
        const day = new Date(today.getTime() - i * DAY_MS);
        if (activeDays.has(ymd(day))) currentStreak++;
        else if (i > 0) break; // today can be empty without breaking the streak
    }

    // Favorite model
    const byModel = new Map();
    sessions.forEach(s => {
        const key = s.model || 'unknown';
        byModel.set(key, (byModel.get(key) || 0) + (s.total_tokens || 0));
    });
    let favoriteModel = null;
    let favoriteTokens = 0;
    for (const [model, tokens] of byModel) {
        if (tokens > favoriteTokens) {
            favoriteModel = model;
            favoriteTokens = tokens;
        }
    }
    const favoriteModelShare = totalTokens > 0 ? (favoriteTokens / totalTokens) * 100 : 0;

    return {
        range,
        totalTokens,
        sessions: sessions.length,
        messages,
        activeDays: activeDays.size,
        currentStreak,
        favoriteModel,
        favoriteModelShare,
        at: new Date().toISOString(),
    };
}

/** Per-day message counts. Used by the activity heatmap. */
function getHeatmap(range = '30d') {
    const start = rangeStart(range);
    const sessions = listSessions().filter(s => inRange(s.created_at, start));
    const byDay = new Map();
    for (const s of sessions) {
        const day = ymd(s.created_at);
        byDay.set(day, (byDay.get(day) || 0) + (s.message_count || 0));
    }
    // Always include the full range so the heatmap has stable columns
    const out = [];
    const days = range === '7d' ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
        const day = ymd(new Date(Date.now() - i * DAY_MS));
        out.push({ date: day, count: byDay.get(day) || 0 });
    }
    return out;
}

/** Token share per model. Used by the donut chart. */
function getByModel(range = '30d') {
    const start = rangeStart(range);
    const sessions = listSessions().filter(s => inRange(s.created_at, start));
    const byModel = new Map();
    sessions.forEach(s => {
        const key = s.model || 'unknown';
        byModel.set(key, (byModel.get(key) || 0) + (s.total_tokens || 0));
    });
    const total = Array.from(byModel.values()).reduce((a, b) => a + b, 0) || 1;
    const out = Array.from(byModel.entries())
        .map(([model, tokens]) => ({
            model,
            tokens,
            percent: (tokens / total) * 100,
        }))
        .sort((a, b) => b.tokens - a.tokens);
    return out;
}

/** Per-day token totals. Used by the Tokens-per-day bar chart. */
function getByDay(range = '30d') {
    const start = rangeStart(range);
    const sessions = listSessions().filter(s => inRange(s.created_at, start));
    const byDay = new Map();
    for (const s of sessions) {
        const day = ymd(s.created_at);
        byDay.set(day, (byDay.get(day) || 0) + (s.total_tokens || 0));
    }
    const days = range === '7d' ? 7 : 30;
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const day = ymd(new Date(Date.now() - i * DAY_MS));
        out.push({ date: day, tokens: byDay.get(day) || 0 });
    }
    return out;
}

module.exports = { getStats, getHeatmap, getByModel, getByDay };
