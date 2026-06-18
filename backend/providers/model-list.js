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
const { resolveProviderForModel } = require('./route-resolver');

let modelAliasCache = null;
let modelAliasCacheAt = 0;
const MODEL_ALIAS_CACHE_TTL_MS = 60000;

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
    const models = await getModelList();
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
            const routed = resolveProviderForModel(userAlias.targetModel);
            return !!(routed && routed.baseUrl && routed.apiKey);
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
 */
async function getModelList() {
    const providers = listProviders();
    const allModels = [];

    for (const p of providers) {
        const config = getProviderConfig(p.name) || {};
        const apiKey = config.apiKey || p.resolveApiKey();
        const baseUrl = config.baseUrl || config.targetUrl || p.resolveBaseUrl();
        const enabled = p.isAvailable() || !!config.apiKey;

        if (!enabled) continue;

        let models = [];

        // Try a live fetch from the provider's /models endpoint.
        try {
            const modelsUrl = deriveModelsUrl(baseUrl);
            if (modelsUrl && apiKey) {
                const fetchRes = await fetch(modelsUrl, {
                    headers: { Authorization: `Bearer ${apiKey}` },
                    signal: AbortSignal.timeout(5000),
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

        // Attach reasoning/thinking flags + isFree marker.
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

        allModels.push(...mappedModels);
    }

    // De-duplicate by id, free models first.
    const unique = Array.from(new Map(allModels.map((m) => [m.id, m])).values());
    unique.sort((a, b) => {
        if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        return (a.id || '').localeCompare(b.id || '');
    });
    // Inject user-defined aliases from config.
    try {
        const cfg = getConfig();
        const userAliases = cfg.modelAliases || [];
        for (const aliasDef of userAliases) {
            if (!aliasDef || !aliasDef.alias) continue;
            if (unique.some(m => m.id === aliasDef.alias)) continue; // don't override real models
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

/** Convert the aggregated list to OpenAI-style { object: "list", data: [...] }. */
async function getModelListOpenAI({ includeClientAliases = false, filterRoutable = false } = {}) {
    const models = await getModelList();
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
    return {
        object: 'list',
        data,
    };
}

module.exports = {
    getModelList,
    getModelListOpenAI,
    resolveModelAlias,
    resolveModelAliasDetails,
    getModelDisplayAlias,
    isFreeModelId,
};
