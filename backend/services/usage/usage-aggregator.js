/* ── usage-aggregator ─ aggregate token usage from session-store ── */
/* Reads from the existing SQLite session store and produces three views   */
/* used by the Settings → Usage tab:                                      */
/*   • getStats(range)   — totals + favorite model + active-day count  */
/*   • getHeatmap(range) — per-day message count (for the GitHub-style  */
/*                         activity heatmap)                            */
/*   • getByModel(range) — token share per model (for the donut chart) */
/*                                                                       */
/* All read-only; data is whatever the adapters and Workbench have written */
/* to the session store. Usage events are preferred when available.        */

const { listSessions, listUsageEvents } = require('../storage/session-store');

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

function usageEventsInRange(range = '30d') {
    const start = rangeStart(range);
    return listUsageEvents().filter(e => inRange(e.created_at, start));
}

function sessionsAndLegacyUsage(range = '30d') {
    const start = rangeStart(range);
    const sessions = listSessions().filter(s => inRange(s.created_at, start));
    const usageEvents = usageEventsInRange(range);
    const sessionsWithUsage = new Set(usageEvents.map(e => e.session_id).filter(Boolean));
    const legacySessions = sessions.filter(s => !sessionsWithUsage.has(s.id));
    return { sessions, usageEvents, legacySessions };
}

/** Top-level stats: total tokens, sessions, messages, active days, current streak, favorite model. */
function getStats(range = '30d') {
    const { sessions, usageEvents, legacySessions } = sessionsAndLegacyUsage(range);
    const totalTokens = usageEvents.reduce((sum, e) => sum + (e.total_tokens || 0), 0)
        + legacySessions.reduce((sum, s) => sum + (s.total_tokens || 0), 0);
    const messages = sessions.reduce((sum, s) => sum + (s.message_count || 0), 0);

    // Active days: usage event days plus legacy session-created days.
    const activeDays = new Set();
    usageEvents.forEach(s => activeDays.add(ymd(s.created_at)));
    legacySessions.forEach(s => activeDays.add(ymd(s.created_at)));

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
    usageEvents.forEach(s => {
        const key = s.model || 'unknown';
        byModel.set(key, (byModel.get(key) || 0) + (s.total_tokens || 0));
    });
    legacySessions.forEach(s => {
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
    const { usageEvents, legacySessions } = sessionsAndLegacyUsage(range);
    const byModel = new Map();
    usageEvents.forEach(s => {
        const key = s.model || 'unknown';
        byModel.set(key, (byModel.get(key) || 0) + (s.total_tokens || 0));
    });
    legacySessions.forEach(s => {
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

/** Per-day token totals. Used by the Tokens-per-day bar chart.
 *  Returns both the daily total and a per-model breakdown so the UI can
 *  render stacked bars with hover tooltips that list each model's
 *  contribution. */
function getByDay(range = '30d') {
    const { usageEvents, legacySessions } = sessionsAndLegacyUsage(range);
    // day -> { tokens, models: Map<model, tokens> }
    const byDay = new Map();
    const addToDay = (day, model, tokens) => {
        if (!byDay.has(day)) byDay.set(day, { tokens: 0, models: new Map() });
        const entry = byDay.get(day);
        entry.tokens += tokens;
        entry.models.set(model, (entry.models.get(model) || 0) + tokens);
    };
    for (const s of usageEvents) {
        const day = ymd(s.created_at);
        addToDay(day, s.model || 'unknown', s.total_tokens || 0);
    }
    for (const s of legacySessions) {
        const day = ymd(s.created_at);
        addToDay(day, s.model || 'unknown', s.total_tokens || 0);
    }
    const days = range === '7d' ? 7 : 30;
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const day = ymd(new Date(Date.now() - i * DAY_MS));
        const entry = byDay.get(day) || { tokens: 0, models: new Map() };
        // Sort models within a day by tokens desc for a stable rendering order.
        const models = Array.from(entry.models.entries())
            .map(([model, tokens]) => ({ model, tokens }))
            .sort((a, b) => b.tokens - a.tokens);
        out.push({ date: day, tokens: entry.tokens, models });
    }
    return out;
}

module.exports = { getStats, getHeatmap, getByModel, getByDay };
