/* ── Per-model provider routing ────────────────────────────────────── */
/* Resolves which provider + baseUrl + apiKey + apiMode should serve a
 * given model id. The cascade is intentionally catalog-first: the
 * Settings UI's `providers.json` is the source of truth, and model
 * routing consults it before any of the older hint/profile/family
 * fallbacks. This keeps the Settings and the routing layer aligned —
 * a model that the user adds in Settings is routable without editing
 * any built-in JS profiles.
 *
 * Returns null when no provider-specific match is found, in which case
 * callers keep their existing fallback (claude/codex profile / active
 * provider).
 */

const { listProviders, getProvider } = require('./provider-registry');
const { getProviderConfig, getActiveProvider } = require('../lib/config');

/** Map UI apiFormat to internal apiMode. */
function uiApiFormatToApiMode(apiFormat) {
    if (!apiFormat) return null;
    if (apiFormat === 'anthropic') return 'anthropic_messages';
    if (apiFormat === 'openai-chat') return 'openai_chat';
    if (apiFormat === 'openai-responses') return 'codex_responses';
    return null;
}

/**
 * Resolve a provider for a model id using this precedence:
 *   1. explicit providerHint / provider / providerName from caller
 *   2. exact catalog match: any provider in providers.json whose
 *      models[].id === model and which has credentials
 *   3. longest catalog prefix match: provider.name / provider.id prefix
 *      or segment on the model id
 *
 * Legacy provider-hints.js (route-resolver.js step 4) was removed after
 * the seeded migration in providers-routes ran on next boot. Hinted
 * models now live in providers.json under their provider's models[].
 *
 * Active-provider fallback is intentionally NOT in this cascade. It
 * belongs in the caller (workbench.js / model-list.js / adapters) so
 * routing and "user's current default" stay decoupled.
 *
 * Returns { provider, baseUrl, apiKey, apiMode } or null.
 */
function resolveProviderByName(providerName) {
    if (!providerName) return null;
    const rawName = String(providerName).trim();
    const p = getProvider(rawName) || getProvider(rawName.toLowerCase());
    if (!p || !jsProviderHasCredentials(p)) return null;
    const resolved = toResolvedFromJsProfile(p);
    // Prefer the display name from providers.json over the JS profile's
    // lowercased id (e.g. "OpenCode Zen" vs "opencode-zen") so callers
    // don't have to do a second lookup for the user-facing label.
    try {
        const { listPublicProviders, getStoredProviderByName } = require('../services/providers/providers-routes');
        const storeEntry = getStoredProviderByName
            ? getStoredProviderByName(p.name)
            : (listPublicProviders ? listPublicProviders().find((s) => s.id === p.name) : null);
        if (storeEntry && storeEntry.name) resolved.name = storeEntry.name;
    } catch (_) { /* providers-routes not loaded — keep profile name */ }
    return resolved;
}

function resolveProviderForModel(model, options = {}) {
    if (!model || typeof model !== 'string') return null;

    // 1. Explicit provider hint from caller.
    const hintedProvider = resolveProviderByName(
        options.providerHint || options.provider || options.providerName
    );
    if (hintedProvider) return hintedProvider;

    // 2. Exact catalog match. Iterate providers.json directly so store-only
    //    providers (no built-in JS profile) are routable.
    try {
        const { listPublicProviders } = require('../services/providers/providers-routes');
        const stored = listPublicProviders ? listPublicProviders() : [];
        const lowerModel = model.toLowerCase();
        for (const sp of stored) {
            if (!sp || !storeHasCredentials(sp)) continue;
            const models = Array.isArray(sp.models) ? sp.models : [];
            const hit = models.find((m) => m && m.id && (
                m.id === model || m.id.toLowerCase() === lowerModel
            ));
            if (hit) return toResolvedFromStoreEntry(sp, hit);
        }
    } catch (_) {
        // providers-routes not loaded yet — fall through to prefix match.
    }

    // 3. Longest catalog prefix match. Compare provider.id / provider.name
    //    (lowercased) as prefixes of the model id; split model on / and :
    //    so segment-based names (e.g. "opencode-go/claude-opus-4-7" →
    //    "opencode-go") also hit.
    try {
        const { listPublicProviders } = require('../services/providers/providers-routes');
        const stored = listPublicProviders ? listPublicProviders() : [];
        const lowerModel = model.toLowerCase();
        const segments = new Set(lowerModel.split(/[/:]+/).filter(Boolean));
        let best = null;
        let bestLen = -1;
        for (const sp of stored) {
            if (!sp || !storeHasCredentials(sp)) continue;
            const candidates = [sp.id, sp.name].filter(Boolean).map(s => s.toLowerCase());
            for (const cand of candidates) {
                if (!cand) continue;
                if (lowerModel.startsWith(cand + '/') || lowerModel.startsWith(cand + ':') || lowerModel === cand) {
                    if (cand.length > bestLen) { best = sp; bestLen = cand.length; }
                } else if (segments.has(cand)) {
                    if (cand.length > bestLen) { best = sp; bestLen = cand.length; }
                }
            }
        }
        if (best) return toResolvedFromStoreEntry(best);
    } catch (_) {
        // providers-routes not loaded yet — fall through to no-match.
    }

    return null;
}

/* ── credential checks ─────────────────────────────────────────────── */

/** True if a built-in JS provider has an env-var key or a config.json
 *  apiKey. Mirrors the old hasCredentials but only operates on JS
 *  profiles (has isAvailable()). */
function jsProviderHasCredentials(provider) {
    if (!provider) return false;
    const config = getProviderConfig(provider.name) || {};
    return !!(provider.isAvailable() || config.apiKey);
}

/** True if a providers.json store entry has credentials: either an
 *  apiKey in providers.json itself, or — if a matching JS profile
 *  exists — an env-var key set on that profile. */
function storeHasCredentials(storeEntry) {
    if (!storeEntry) return false;
    if (storeEntry.apiKey) return true;
    const profile = getProvider(storeEntry.id) || getProvider(storeEntry.name);
    if (profile && typeof profile.isAvailable === 'function' && profile.isAvailable()) return true;
    return false;
}

/* ── shape converters ─────────────────────────────────────────────── */

/** Build a resolved object from a JS profile (uses getProviderConfig
 *  for stored apiKey/baseUrl overrides and provider.resolveApiKey/BaseUrl
 *  for env-driven defaults). */
function toResolvedFromJsProfile(provider) {
    const config = getProviderConfig(provider.name) || {};
    return {
        provider,
        name: provider.name,
        baseUrl: config.baseUrl || config.targetUrl || provider.resolveBaseUrl(),
        apiKey: config.apiKey || provider.resolveApiKey(),
        model: config.model || config._upstreamModel || config.currentModel || provider.defaultModel,
        apiMode: config.apiMode || provider.apiMode,
    };
}

/** Build a resolved object from a providers.json store entry. Used
 *  for store-only providers (no JS profile) AND for store entries
 *  that win the cascade before their JS counterpart is consulted. */
function toResolvedFromStoreEntry(storeEntry, modelHit) {
    if (!storeEntry) return null;
    const id = storeEntry.id;
    // Pull any config.json overrides by id (e.g. config[id].apiKey) so
    // users with both layers still get the override.
    const config = id ? (getProviderConfig(id) || {}) : {};
    // The apiKey precedence: store entry → config.json override → JS profile env.
    let apiKey = storeEntry.apiKey || config.apiKey || '';
    let baseUrl = storeEntry.baseUrl || config.baseUrl || '';
    if (!apiKey || !baseUrl) {
        const profile = getProvider(id) || getProvider(storeEntry.name);
        if (profile) {
            if (!apiKey && typeof profile.resolveApiKey === 'function') apiKey = profile.resolveApiKey();
            if (!baseUrl && typeof profile.resolveBaseUrl === 'function') baseUrl = profile.resolveBaseUrl();
        }
    }
    // apiFormat on the store entry is the canonical source-of-truth
    // when present; fall back to the JS profile's apiMode otherwise.
    let apiMode = uiApiFormatToApiMode(storeEntry.apiFormat);
    if (!apiMode) {
        const profile = getProvider(id) || getProvider(storeEntry.name);
        apiMode = profile ? profile.apiMode : 'openai_chat';
    }
    return {
        provider: null, // store-only entries don't have a JS profile handle
        name: storeEntry.name || id,
        baseUrl,
        apiKey,
        model: (modelHit && modelHit.id) || config.model || storeEntry.id,
        apiMode: apiMode || config.apiMode || 'openai_chat',
    };
}

module.exports = { resolveProviderForModel, resolveProviderByName };
