/* ── Shared model-list aggregation ─────────────────────────────────── */
/* Used by both /api/models (web UI) and /v1/models (OpenAI-compatible
 * clients). Iterates every configured provider, tries a live fetch from
 * each provider's /models endpoint, falls back to static known lists,
 * and returns a de-duplicated list with reasoning/thinking flags and an
 * isFree marker (:free / -free suffix conventions used by OpenRouter
 * and friends). */

const { listProviders, getProvider } = require('./provider-registry');
const { getConfig, getProviderConfig } = require('../lib/config');
const { inferFromModelId, deriveModelsUrl } = require('../lib/models');
const { resolveModelProfile } = require('../lib/model-profiles');
const { resolveProviderForModel, resolveProviderByName } = require('./route-resolver');
const { listPublicProviders } = require('../services/providers/providers-routes');

let modelAliasCache = null;
let modelAliasCacheAt = 0;
const MODEL_ALIAS_CACHE_TTL_MS = 60000;

// ── Model list cache (5 min TTL) ────────────────────────────────────────
// The aggregated list of every provider's models is expensive to rebuild
// (network calls per provider). A stale-on-read pattern lets the first
// caller see the previous result immediately while a background refresh
// fills in fresh data.
let modelListCache = null;
let modelListCacheAt = 0;
const MODEL_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
let modelListRefreshInFlight = null;

function invalidateModelListCache() {
    modelListCache = null;
    modelListCacheAt = 0;
}

/**
 * Fetch one provider's models with a hard timeout. Never throws — failures
 * are returned as `{ ok: false, error }` so the caller can drop the provider
 * from the aggregated list without aborting the rest of the fetch.
 */
async function fetchProviderModelsWithTimeout(p, timeoutMs = 5000) {
    const config = getProviderConfig(p.name) || {};
    const apiKey = config.apiKey || p.resolveApiKey();
    const baseUrl = config.baseUrl || config.targetUrl || p.resolveBaseUrl();

    let models = [];
    let liveOk = false;

    try {
        const modelsUrl = deriveModelsUrl(baseUrl);
        if (modelsUrl && apiKey) {
            const fetchRes = await fetch(modelsUrl, {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (fetchRes.ok) {
                const data = await fetchRes.json();
                const list = data.data || data.models || data || [];
                models = list.map((m) => ({
                    id: m.id,
                    name: m.id,
                    provider: p.name,
                    contextWindow: getContextWindowForModel(m.id, p, m.context_length),
                }));
                liveOk = true;
            }
        }
    } catch (e) {
        console.warn(`[Proxy Models] Failed to fetch models for ${p.name}:`, e.message);
    }

    // Fallback to static known models for providers without a models API.
    if (models.length === 0) {
        let staticModels = staticModelsFor(p.name);
        if (staticModels.length === 0) {
            if (p.defaultModel) staticModels.push({ id: p.defaultModel, contextWindow: 128000 });
            if (p.fallbackModels) p.fallbackModels.forEach((m) => staticModels.push({ id: m, contextWindow: 128000 }));
        }
        models = staticModels.map((m) => ({
            id: m.id,
            name: m.id,
            provider: p.name,
            contextWindow: getContextWindowForModel(m.id, p, m.contextWindow),
        }));
    }

    // Always include any explicitly configured models for this provider.
    const configuredModelIds = new Set();
    if (config.currentModel) configuredModelIds.add(config.currentModel);
    if (config.model) configuredModelIds.add(config.model);
    if (config._upstreamModel) configuredModelIds.add(config._upstreamModel);
    if (config.contextModelId) configuredModelIds.add(config.contextModelId);
    if (Array.isArray(config.models)) {
        config.models.forEach((m) => {
            if (typeof m === 'string') configuredModelIds.add(m);
            else if (m && m.id) configuredModelIds.add(m.id);
        });
    }
    for (const mid of configuredModelIds) {
        if (!models.some((m) => m.id === mid)) {
            models.push({
                id: mid,
                name: mid,
                provider: p.name,
                contextWindow: getContextWindowForModel(mid, p, config.contextWindow),
            });
        }
    }

    const mappedModels = models.map((m) => {
        const provProfile = p.getModelProfile(m.id);
        const globalProfile = resolveModelProfile(m.id);
        const supportsThinking = !!(provProfile?.supportsThinking || globalProfile?.supportsThinking);
        const supportsReasoning = !!(provProfile?.supportsReasoning || provProfile?.supportsThinking || globalProfile?.supportsReasoning || globalProfile?.supportsThinking);
        return {
            ...m,
            supportsReasoning,
            supportsThinking,
            isFree: isFreeModelId(m.id),
        };
    });

    return { ok: true, provider: p.name, models: mappedModels, liveOk };
}

/**
 * Aggregate every provider's models in parallel. Each provider runs
 * independently so a slow / failing provider no longer blocks the rest.
 */
async function aggregateModels() {
    const providers = listProviders();
    const enabled = providers.filter((p) => {
        const config = getProviderConfig(p.name) || {};
        const apiKey = config.apiKey || p.resolveApiKey();
        return p.isAvailable() || !!apiKey;
    });

    const results = await Promise.allSettled(
        enabled.map((p) => fetchProviderModelsWithTimeout(p, 5000))
    );

    const allModels = [];
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value?.models) {
            allModels.push(...r.value.models);
        } else if (r.status === 'rejected') {
            console.warn('[Proxy Models] Provider aggregation rejected:', r.reason?.message || r.reason);
        }
    }

    // Include models from user-created custom providers (stored in providers.json)
    // that are not part of the built-in provider registry. These providers are
    // managed via the Settings UI and their models exist only in providers.json,
    // not in provider-registry.js — without this step they'd never appear in
    // /api/models and would be invisible to the chat model dropdown.
    try {
        const storedProviders = listPublicProviders();
        const registryNames = new Set(providers.map((p) => p.name));
        for (const sp of storedProviders) {
            if (sp.name && !registryNames.has(sp.name) && sp.enabled && sp.apiKey) {
                const storedModels = Array.isArray(sp.models) ? sp.models : [];
                for (const m of storedModels) {
                    allModels.push({
                        id: m.id,
                        name: m.name || m.id,
                        provider: sp.name,
                        contextWindow: m.contextWindow || getContextWindowForModel(m.id, null),
                        supportsReasoning: !!(m.reasoning || resolveModelProfile(m.id)?.supportsReasoning || resolveModelProfile(m.id)?.supportsThinking),
                        supportsThinking: !!(m.reasoning || resolveModelProfile(m.id)?.supportsThinking || resolveModelProfile(m.id)?.supportsReasoning),
                        isFree: !!m.free || isFreeModelId(m.id),
                    });
                }
            }
        }
    } catch (_) {}

    // De-duplicate by id, free models first.
    const unique = Array.from(new Map(allModels.map((m) => [m.id, m])).values());
    unique.sort((a, b) => {
        if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        return (a.id || '').localeCompare(b.id || '');
    });

    // Inject user-defined aliases from config, overriding any real model
    // with the same ID so they appear under the 'Alias' provider group.
    try {
        const cfg = getConfig();
        const userAliases = cfg.modelAliases || [];
        for (const aliasDef of userAliases) {
            if (!aliasDef || !aliasDef.alias) continue;
            const existingIdx = unique.findIndex(m => m.id === aliasDef.alias);
            if (existingIdx >= 0) unique.splice(existingIdx, 1);
            unique.push({
                id: aliasDef.alias,
                name: aliasDef.alias,
                provider: 'Alias',
                contextWindow: 128000,
                supportsReasoning: false,
                supportsThinking: false,
                isFree: false,
            });
        }
    } catch (_) {}

    return unique;
}

/**
 * Refresh the model list cache in the background. Coalesces concurrent
 * refreshes via `modelListRefreshInFlight` so the first caller after
 * expiry triggers exactly one refresh.
 */
function refreshInBackground() {
    if (modelListRefreshInFlight) return modelListRefreshInFlight;
    modelListRefreshInFlight = (async () => {
        try {
            const fresh = await aggregateModels();
            modelListCache = fresh;
            modelListCacheAt = Date.now();
            return fresh;
        } catch (e) {
            console.warn('[Proxy Models] Background refresh failed:', e.message);
            return modelListCache || [];
        } finally {
            modelListRefreshInFlight = null;
        }
    })();
    return modelListRefreshInFlight;
}

/**
 * Pre-warm the cache on app startup. Best-effort; logs and swallows errors.
 */
async function prewarmModelList({ logPrefix = '[Proxy PreWarm]' } = {}) {
    const t0 = Date.now();
    try {
        const list = await aggregateModels();
        modelListCache = list;
        modelListCacheAt = Date.now();
        console.log(`${logPrefix} model list cached in ${Date.now() - t0}ms (${list.length} models)`);
        return list;
    } catch (e) {
        console.warn(`${logPrefix} model list warmup failed:`, e.message);
        return [];
    }
}

function isFreeModelId(id) {
    if (typeof id !== 'string') return false;
    const lower = id.toLowerCase();
    return lower.includes(':free') || lower.includes('-free') || lower.endsWith('free');
}

const DISPLAY_VARIANT_TAGS = [
    [/-fast$/i, 'Fast'],
    [/-thinking$/i, 'Thinking'],
    [/-preview$/i, 'Preview'],
    [/-latest$/i, 'Latest'],
    [/:free$/i, 'Free'],
    [/-free$/i, 'Free'],
];

const titleCase = (text) => text.replace(/\b\w/g, c => c.toUpperCase()).trim();

function prettifyModelBase(base) {
    if (/^claude-/i.test(base)) return titleCase(base.replace(/^claude-/i, '').replace(/-/g, ' '));
    if (/^gpt-/i.test(base)) return base.replace(/^gpt-/i, 'GPT-');
    if (/^gemini-/i.test(base)) return 'Gemini ' + titleCase(base.replace(/^gemini-/i, '').replace(/-/g, ' '));
    if (/^deepseek-/i.test(base)) return titleCase(base.replace(/^deepseek-/i, 'DeepSeek '));
    if (/^llama-/i.test(base)) return titleCase(base.replace(/^llama-/i, 'Llama '));
    if (/^qwen-/i.test(base) || /^qwq-/i.test(base)) return titleCase(base.replace(/-/g, ' '));
    if (/^mistral-/i.test(base)) return titleCase(base.replace(/^mistral-/i, 'Mistral '));
    if (/^minimax-/i.test(base)) return titleCase(base.replace(/^minimax-/i, 'MiniMax '));
    return titleCase(base.replace(/-/g, ' '));
}

function stripProviderPrefix(id) {
    const sepIdx = id.search(/[/:]/);
    return sepIdx >= 0 ? id.slice(sepIdx + 1) : id;
}

function sanitizeProviderToken(providerName) {
    return String(providerName || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

function stripProviderAliasPrefix(id, providerName) {
    const providerToken = sanitizeProviderToken(providerName);
    if (!providerToken) return id;
    const lowerId = id.toLowerCase();
    const prefix = providerToken + '-';
    return lowerId.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function getModelDisplayAlias(model) {
    if (!model || typeof model.id !== 'string') return '';
    const hadProviderSeparator = /[/:]/.test(model.id);
    let base = stripProviderPrefix(model.id);
    const providerToken = sanitizeProviderToken(model.provider);
    const providerModelPrefix = providerToken ? `${providerToken}-${providerToken}-` : '';
    if (!hadProviderSeparator) {
        if (base.toLowerCase().startsWith(providerModelPrefix)) {
            base = base.slice(providerToken.length + 1);
        } else {
            base = stripProviderAliasPrefix(base, model.provider);
        }
    }

    let tag = '';
    for (const [pattern, label] of DISPLAY_VARIANT_TAGS) {
        if (pattern.test(base)) {
            base = base.replace(pattern, '');
            tag = label;
            break;
        }
    }

    const providerDisplayName = getProviderDisplayName(model.provider);
    const baseName = tag ? `${prettifyModelBase(base) || model.id} (${tag})` : (prettifyModelBase(base) || model.id);
    return providerDisplayName ? `${baseName}-${providerDisplayName}` : baseName;
}

function toClaudeDesktopModelAlias(id, providerName = '') {
    if (typeof id !== 'string') return '';
    const sanitizedId = id
        .replace(/^~/, '')
        .replace(/[/:]/g, '-')
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    const sanitizedProvider = sanitizeProviderToken(providerName);
    if (!sanitizedProvider || !sanitizedId || sanitizedId.toLowerCase().startsWith(sanitizedProvider + '-')) return sanitizedId;
    return sanitizedProvider + '-' + sanitizedId;
}

function getProviderDisplayName(providerName) {
    return getProvider(providerName)?.displayName || providerName || '';
}

function addModelAlias(aliases, ids, alias, model) {
    if (!alias || alias === model.id || ids.has(alias) || aliases.has(alias)) return false;
    aliases.set(alias, {
        modelId: model.id,
        provider: model.provider,
    });
    ids.add(alias);
    return true;
}

function buildModelAliasMap(models) {
    const ids = new Set(models.map(m => m.id));
    const aliases = new Map();
    for (const model of models) {
        const displayAlias = getModelDisplayAlias(model);
        if (!addModelAlias(aliases, ids, displayAlias, model)) {
            const providerDisplayName = getProviderDisplayName(model.provider);
            const providerAlias = providerDisplayName && providerDisplayName !== displayAlias ? `${displayAlias} (${providerDisplayName})` : '';
            if (!addModelAlias(aliases, ids, providerAlias, model)) {
                addModelAlias(aliases, ids, toClaudeDesktopModelAlias(model.id, model.provider), model);
            }
        }
    }
    return aliases;
}
async function getModelAliasMap() {
    const now = Date.now();
    if (modelAliasCache && now - modelAliasCacheAt < MODEL_ALIAS_CACHE_TTL_MS) return modelAliasCache;
    const result = await getModelList();
    const models = Array.isArray(result) ? result : (result.models || []);
    modelAliasCache = buildModelAliasMap(models);
    modelAliasCacheAt = now;
    return modelAliasCache;
}

function normalizeAliasEntry(entry, fallbackModelId) {
    if (!entry) return fallbackModelId;
    return typeof entry === 'string' ? entry : entry.modelId;
}

function findUserDefinedAlias(modelId) {
    if (!modelId || typeof modelId !== 'string') return null;
    try {
        const cfg = getConfig();
        const aliases = cfg.modelAliases || [];
        const match = aliases.find(a => a && a.alias === modelId);
        if (match && match.targetModel) return match;
    } catch (_) {}
    return null;
}

async function resolveModelAlias(modelId) {
    // 0. Check user-defined aliases from config first.
    const userAlias = findUserDefinedAlias(modelId);
    if (userAlias) return userAlias.targetModel;
    const aliases = await getModelAliasMap();
    return normalizeAliasEntry(aliases.get(modelId), modelId);
}

async function resolveModelAliasDetails(modelId) {
    // 0. Check user-defined aliases from config first.
    const userAlias = findUserDefinedAlias(modelId);
    if (userAlias) return { modelId: userAlias.targetModel, provider: userAlias.targetProvider || '' };
    const aliases = await getModelAliasMap();
    const entry = aliases.get(modelId);
    if (!entry) return { modelId, provider: '' };
    if (typeof entry === 'string') return { modelId: entry, provider: '' };
    return { modelId: entry.modelId, provider: entry.provider || '' };
}

function getProviderPrefix(modelId) {
    const match = String(modelId || '').trim().match(/^([^/:~]+)[/:]/);
    return match ? match[1] : '';
}

function providerMatchesPrefix(provider, prefix) {
    if (!provider || !prefix) return false;
    const lowerPrefix = prefix.toLowerCase();
    if (provider.name && provider.name.toLowerCase() === lowerPrefix) return true;
    return Array.isArray(provider.aliases) && provider.aliases.some((alias) => String(alias).toLowerCase() === lowerPrefix);
}

function isModelRoutableForClient(model) {
    // User-defined aliases (provider: 'Alias') are routable if their target
    // model can be resolved to a provider with credentials.
    if (model.provider === 'Alias') {
        const userAlias = findUserDefinedAlias(model.id);
        if (userAlias && userAlias.targetModel) {
            // Try routing the target model normally (by model name).
            const routed = resolveProviderForModel(userAlias.targetModel);
            if (routed && routed.baseUrl && routed.apiKey) return true;
            // Also try routing via the alias's explicitly configured provider.
            if (userAlias.targetProvider) {
                const providerRouted = resolveProviderByName(userAlias.targetProvider);
                if (providerRouted && providerRouted.baseUrl && providerRouted.apiKey) return true;
            }
        }
        return false;
    }

    const providerPrefixedId = model.provider ? `${model.provider}/${model.id}` : model.id;
    const providerRouted = resolveProviderForModel(providerPrefixedId);
    if (providerRouted && providerMatchesPrefix(providerRouted.provider, model.provider)) return true;

    const routed = resolveProviderForModel(model.id);
    if (!routed) return false;
    const prefix = getProviderPrefix(model.id);
    if (!prefix) return true;
    return providerMatchesPrefix(routed.provider, prefix);
}

function getContextWindowForModel(modelId, providerProfile, contextLengthFromApi) {
    if (contextLengthFromApi) return contextLengthFromApi;
    const inferred = inferFromModelId(modelId);
    if (inferred && inferred.inputTokens) return inferred.inputTokens;
    const profile = providerProfile ? providerProfile.getModelProfile(modelId) : null;
    if (profile && profile.contextWindow) return profile.contextWindow;
    return 128000;
}

/**
 * Static fallback model lists for providers without a usable /models endpoint.
 */
function staticModelsFor(providerName) {
    switch (providerName) {
        case 'anthropic':
            return [
                { id: 'claude-3-5-sonnet-20241022', contextWindow: 200000 },
                { id: 'claude-3-5-haiku-20241022', contextWindow: 200000 },
                { id: 'claude-3-opus-20240229', contextWindow: 200000 },
                { id: 'claude-sonnet-4-6', contextWindow: 200000 },
                { id: 'claude-opus-4-6', contextWindow: 200000 },
            ];
        case 'openai-api':
            return [
                { id: 'gpt-4o', contextWindow: 128000 },
                { id: 'gpt-4o-mini', contextWindow: 128000 },
                { id: 'o1', contextWindow: 200000 },
                { id: 'o3-mini', contextWindow: 200000 },
            ];
        case 'gemini':
            return [
                { id: 'gemini-2.5-pro', contextWindow: 2000000 },
                { id: 'gemini-2.5-pro-preview-06-05', contextWindow: 2000000 },
                { id: 'gemini-2.5-flash', contextWindow: 1000000 },
                { id: 'gemini-2.5-flash-preview-05-20', contextWindow: 1000000 },
                { id: 'gemini-2.0-flash', contextWindow: 1000000 },
                { id: 'gemini-2.0-flash-lite', contextWindow: 1000000 },
                { id: 'gemma-3-27b-it', contextWindow: 131072 },
                { id: 'gemma-3-12b-it', contextWindow: 131072 },
                { id: 'gemma-3-4b-it', contextWindow: 131072 },
                { id: 'gemma-3-1b-it', contextWindow: 32768 },
            ];
        case 'deepseek':
            return [
                { id: 'deepseek-chat', contextWindow: 64000 },
                { id: 'deepseek-reasoner', contextWindow: 64000 },
            ];
        default:
            return [];
    }
}

/**
 * Aggregate models from every configured (available) provider.
 * Returns a de-duplicated array of:
 *   { id, name, provider, contextWindow, supportsReasoning, supportsThinking, isFree }
 *
 * Free models are NOT filtered out here; callers decide how to sort/filter.
 *
 * Options:
 *   { skeleton = false }  → if true, returns `{ models: [], hasMore: false, total: 0 }` immediately
 *                            and triggers a background refresh.
 *   { limit = 0, offset = 0 } → pagination over the aggregated list.
 *   { refresh = false }  → force a synchronous refresh (skips cache).
 */
async function getModelList(options = {}) {
    const { skeleton = false, limit = 0, offset = 0, refresh = false } = options || {};

    if (skeleton) {
        // Trigger a background refresh without blocking.
        if (!modelListCache || (Date.now() - modelListCacheAt) >= MODEL_LIST_CACHE_TTL_MS) {
            refreshInBackground();
        }
        return { models: [], hasMore: false, total: modelListCache ? modelListCache.length : 0 };
    }

    if (refresh) {
        const fresh = await aggregateModels();
        modelListCache = fresh;
        modelListCacheAt = Date.now();
        return paginate(fresh, limit, offset);
    }

    if (modelListCache && (Date.now() - modelListCacheAt) < MODEL_LIST_CACHE_TTL_MS) {
        return paginate(modelListCache, limit, offset);
    }

    if (modelListCache) {
        // Stale-while-revalidate: return stale and refresh in background.
        refreshInBackground();
        return paginate(modelListCache, limit, offset);
    }

    // Cold path: aggregate synchronously and cache.
    const fresh = await aggregateModels();
    modelListCache = fresh;
    modelListCacheAt = Date.now();
    return paginate(fresh, limit, offset);
}

function paginate(list, limit, offset) {
    const total = list.length;
    if (!limit || limit <= 0) {
        return { models: list, hasMore: false, total };
    }
    const start = Math.max(0, offset || 0);
    const end = start + limit;
    return {
        models: list.slice(start, end),
        hasMore: end < total,
        total,
        nextOffset: end < total ? end : null
    };
}

/** Convert the aggregated list to OpenAI-style { object: "list", data: [...] }. */
async function getModelListOpenAI({ includeClientAliases = false, filterRoutable = false, limit = 0, offset = 0, skeleton = false } = {}) {
    const result = await getModelList({ skeleton, limit, offset });
    const models = Array.isArray(result) ? result : (result.models || []);
    const created = Math.floor(Date.now() / 1000);
    const visibleModels = filterRoutable ? models.filter(isModelRoutableForClient) : models;
    const aliases = includeClientAliases ? buildModelAliasMap(visibleModels) : new Map();
    const aliasesByRealId = new Map(Array.from(aliases, ([alias, entry]) => [normalizeAliasEntry(entry, alias), alias]));
    const data = [];
    for (const model of visibleModels) {
        const alias = aliasesByRealId.get(model.id) || getModelDisplayAlias(model) || model.id;
        data.push({
            id: alias,
            name: alias,
            object: 'model',
            created,
            owned_by: model.provider,
        });
    }
    const out = {
        object: 'list',
        data,
    };
    if (!Array.isArray(result) && result && typeof result === 'object') {
        out.has_more = !!result.hasMore;
        out.total = result.total;
        if (result.nextOffset !== undefined && result.nextOffset !== null) out.next_offset = result.nextOffset;
    }
    return out;
}

module.exports = {
    getModelList,
    getModelListOpenAI,
    prewarmModelList,
    invalidateModelListCache,
    resolveModelAlias,
    resolveModelAliasDetails,
    getModelDisplayAlias,
    isFreeModelId,
    /** Exported for the providers.json seeder (providers-routes.js) so the
     *  seeded model lists match what the live aggregator already used to use. */
    staticModelsFor,
};
