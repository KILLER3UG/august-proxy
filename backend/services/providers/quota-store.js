/* ── quota-store ─ local + (optional) native per-model daily quota ── */
/* Tracks today's prompt + completion tokens per (provider, model) in     */
/* memory. Adapters call recordUsage() after each successful response.   */
/*                                                                       */
/* The native-quota API differs wildly per provider (Z.ai has /api/usage, */
/* OpenAI uses rate-limit headers, Anthropic has admin API usage, …).   */
/* `fetchNativeQuota(provider, model)` is overridable per provider in    */
/* the provider's adapter; the default implementation returns null so    */
/* the store falls back to local tracking.                                */
/*                                                                       */
/* Public API:                                                           */
/*   • recordUsage(provider, model, prompt, completion)                  */
/*   • getDailyQuota(provider, model) → { used, limit, percent, resetsAt } */
/*   • getAllQuotas(provider) → [{ model, used, limit, percent, resetsAt }] */
/*   • clearQuotaStore()                                                 */

const { listProviders, getProvider } = require('../../providers/provider-registry');

const DAY_MS = 24 * 60 * 60 * 1000;

function todayKey(date = new Date()) {
    return date.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

// In-memory bucket: { [provider]: { [model]: { date, prompt, completion, limit? } } }
const usage = new Map();

// Per-model daily limits; populated by recordUsage (if the provider reports
// a per-call limit) and by setLimit (manual override).
const limits = new Map();

function bucket(provider, model) {
    let p = usage.get(provider);
    if (!p) { p = new Map(); usage.set(provider, p); }
    let m = p.get(model);
    const today = todayKey();
    if (!m || m.date !== today) {
        m = { date: today, prompt: 0, completion: 0 };
        p.set(model, m);
    }
    return m;
}

function resetsAt(date = new Date()) {
    // Next UTC midnight
    const d = new Date(date);
    d.setUTCHours(24, 0, 0, 0);
    return d.toISOString();
}

/** Record prompt + completion tokens consumed for a single request. */
function recordUsage(provider, model, prompt = 0, completion = 0) {
    if (!provider || !model) return;
    const m = bucket(provider, model);
    m.prompt += Math.max(0, Number(prompt) || 0);
    m.completion += Math.max(0, Number(completion) || 0);
}

/** Set / override the daily limit for a model (used by native-quota merges). */
function setLimit(provider, model, limit) {
    if (!provider || !model) return;
    const key = `${provider}:${model}`;
    limits.set(key, Math.max(0, Number(limit) || 0));
}

function getLimit(provider, model) {
    return limits.get(`${provider}:${model}`) || null;
}

/** Native-quota hook: returns `{ used, limit, resetsAt } | null` per provider. */
async function fetchNativeQuota(provider, model) {
    try {
        const p = getProvider(provider);
        if (!p || typeof p.getNativeQuota !== 'function') return null;
        return await p.getNativeQuota(model);
    } catch (_) {
        return null;
    }
}

/** Single-model daily quota: merges local + native (native wins when present). */
async function getDailyQuota(provider, model) {
    const m = bucket(provider, model);
    const used = m.prompt + m.completion;
    const native = await fetchNativeQuota(provider, model);
    const limit = (native && native.limit) || getLimit(provider, model) || null;
    return {
        provider,
        model,
        used,
        prompt: m.prompt,
        completion: m.completion,
        limit,
        percent: limit ? Math.min(100, (used / limit) * 100) : 0,
        resetsAt: resetsAt(),
        source: native ? 'native' : (limit ? 'local' : 'none'),
    };
}

/** All models for a provider that have any recorded usage (or known limit). */
async function getAllQuotas(provider) {
    const models = new Set();
    const providerBucket = usage.get(provider);
    if (providerBucket) providerBucket.forEach((_, m) => models.add(m));
    for (const key of limits.keys()) {
        const [p, m] = key.split(':');
        if (p === provider) models.add(m);
    }
    const out = [];
    for (const model of models) {
        out.push(await getDailyQuota(provider, model));
    }
    return out;
}

/** All known models (for every provider) — used by the Models tab to pre-populate. */
function listAllKnownModels() {
    const out = new Set();
    for (const provider of listProviders()) {
        try {
            const models = provider.fallbackModels || [];
            for (const m of models) out.add(m);
            // Also include anything we've seen today
            const bucket = usage.get(provider.name);
            if (bucket) bucket.forEach((_, m) => out.add(m));
        } catch (_) { /* ignore */ }
    }
    return Array.from(out);
}

function clearQuotaStore() {
    usage.clear();
    limits.clear();
}

module.exports = {
    recordUsage,
    setLimit,
    getLimit,
    fetchNativeQuota,
    getDailyQuota,
    getAllQuotas,
    listAllKnownModels,
    clearQuotaStore,
};
