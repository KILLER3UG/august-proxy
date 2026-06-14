/* ── Shared model-list aggregation ─────────────────────────────────── */
/* Used by both /api/models (web UI) and /v1/models (OpenAI-compatible
 * clients). Iterates every configured provider, tries a live fetch from
 * each provider's /models endpoint, falls back to static known lists,
 * and returns a de-duplicated list with reasoning/thinking flags and an
 * isFree marker (:free / -free suffix conventions used by OpenRouter
 * and friends). */

const { listProviders } = require('./provider-registry');
const { getProviderConfig } = require('../lib/config');
const { inferFromModelId, deriveModelsUrl } = require('../lib/models');
const { resolveModelProfile } = require('../lib/model-profiles');

function isFreeModelId(id) {
    if (typeof id !== 'string') return false;
    const lower = id.toLowerCase();
    return lower.includes(':free') || lower.includes('-free') || lower.endsWith('free');
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
    return unique;
}

/** Convert the aggregated list to OpenAI-style { object: "list", data: [...] }. */
async function getModelListOpenAI() {
    const models = await getModelList();
    const created = Math.floor(Date.now() / 1000);
    return {
        object: 'list',
        data: models.map((m) => ({
            id: m.id,
            object: 'model',
            created,
            owned_by: m.provider,
        })),
    };
}

module.exports = {
    getModelList,
    getModelListOpenAI,
    isFreeModelId,
};
