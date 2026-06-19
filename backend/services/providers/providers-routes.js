/* ── providers-store + routes + auto-fetch ─────────────────────────── */
/* CRUD for custom model providers and their models. The Settings page's  */
/* Model settings tab needs to:                                           */
/*   • list providers (built-in + custom) with their models inlined       */
/*   • create / update / delete a custom provider                         */
/*   • add / update / remove a model under a provider                     */
/*   • auto-fetch models from `<baseUrl>/v1/models` when the toggle is on */
/*                                                                        */
/* Storage is a single JSON file at backend/data/providers.json. The store */
/* is loaded once at startup, mutated in-memory, and flushed on every     */
/* mutation. Manual models (source = 'manual') are preserved across       */
/* auto-refresh; only 'fetched' models are removed if they disappear.    */
/*                                                                        */
/* On first boot (or after the store is wiped) the built-in provider       */
/* registry is seeded into providers.json so the new Model Settings UI     */
/* shows every provider with its hardcoded baseUrl + apiFormat + models   */
/* filled in. Users can then edit baseUrl, change apiFormat, manage keys   */
/* and models, etc. User edits are preserved across restarts.              */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendJson, readJsonBody } = require('../../lib/http-utils');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'providers.json');

let store = { providers: [] };

/** Map provider-registry apiMode values to the UI's ApiFormat enum. */
function mapApiModeToUi(apiMode) {
    if (!apiMode) return null;
    if (apiMode === 'anthropic_messages') return 'anthropic';
    if (apiMode === 'openai_chat') return 'openai-chat';
    if (apiMode === 'codex_responses') return 'openai-responses';
    // bedrock_converse + other AWS-SDK variants have no UI surface; skip.
    return null;
}

/**
 * Seed built-in providers from the registry into providers.json when the
 * store is empty (first boot, or after the file was deleted). For each
 * registry entry we copy:
 *   - id, name (displayName)
 *   - baseUrl (resolved via env override)
 *   - apiFormat (mapped from apiMode; bedrock-style providers are skipped)
 *   - enabled + apiKeySet (derived from isAvailable(), i.e. env key present)
 *   - models (staticModelsFor + defaultModel + fallbackModels), each marked
 *     source = 'manual' so an auto-refresh won't remove them
 *
 * Providers already in the store are NEVER overwritten — user edits win.
 * Idempotent: running seed multiple times is a no-op once the store is
 * populated.
 */
function seedFromRegistry() {
    let registry, modelList;
    try { registry = require('../../providers/provider-registry'); } catch (_) { return; }
    try { modelList = require('../../providers/model-list'); } catch (_) { return; }
    if (!registry || typeof registry.listProviders !== 'function') return;
    if (!modelList || typeof modelList.staticModelsFor !== 'function') return;

    /* Ensure the built-in registry is populated before we read it.
     * backend/index.js normally calls registerBuiltinProviders() at boot,
     * but providers-routes may be required earlier (e.g. by lib/config.js
     * during startup). Calling it here is safe — it's idempotent. */
    try {
        const builtin = require('../../providers/builtin');
        if (typeof builtin.registerBuiltinProviders === 'function') {
            builtin.registerBuiltinProviders();
        }
    } catch (_) { /* builtins unavailable — fall through */ }

    const list = registry.listProviders();
    console.log('[seed] listProviders returned', list.length, 'providers');

    const existingIds = new Set(store.providers.map((p) => p.id));
    const existingNames = new Set(store.providers.map((p) => (p.name || '').toLowerCase()));
    const now = new Date().toISOString();
    let added = 0;

    for (const profile of registry.listProviders()) {
        const id = profile.name;
        if (!id) continue;
        if (existingIds.has(id) || existingNames.has((profile.displayName || id).toLowerCase())) continue;

        const apiFormat = mapApiModeToUi(profile.apiMode);
        if (!apiFormat) continue; // no UI representation (e.g. bedrock)

        const enabled = !!profile.isAvailable();
        const baseUrl = profile.resolveBaseUrl() || profile.baseUrl || '';

        const modelMap = new Map();
        for (const m of modelList.staticModelsFor(id) || []) {
            if (!m || !m.id) continue;
            modelMap.set(m.id, {
                id: m.id,
                name: m.id,
                contextWindow: m.contextWindow,
                reasoning: false,
                free: false,
                source: 'manual',
                createdAt: now,
                updatedAt: now,
            });
        }
        const extras = [];
        if (profile.defaultModel && !modelMap.has(profile.defaultModel)) extras.push(profile.defaultModel);
        if (Array.isArray(profile.fallbackModels)) {
            for (const m of profile.fallbackModels) {
                if (m && !modelMap.has(m)) extras.push(m);
            }
        }
        for (const mid of extras) {
            modelMap.set(mid, {
                id: mid,
                name: mid,
                contextWindow: undefined,
                reasoning: false,
                free: false,
                source: 'manual',
                createdAt: now,
                updatedAt: now,
            });
        }

        store.providers.push({
            id,
            name: profile.displayName || id,
            baseUrl,
            apiFormat,
            apiKey: '',
            enabled,
            autoFetch: false,
            models: Array.from(modelMap.values()),
            createdAt: now,
            updatedAt: now,
        });
        existingIds.add(id);
        existingNames.add((profile.displayName || id).toLowerCase());
        added++;
    }

    if (added > 0) {
        try {
            persist();
            console.log(`[providers] seeded ${added} built-in provider${added === 1 ? '' : 's'} into providers.json`);
        } catch (err) {
            console.warn('[providers] failed to persist after seed:', err.message);
        }
    }
}

function load() {
    try {
        if (fs.existsSync(STORE_PATH)) {
            const raw = fs.readFileSync(STORE_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.providers)) {
                store = parsed;
            }
        }
    } catch (err) {
        console.warn('[providers] failed to load store, starting empty:', err.message);
        store = { providers: [] };
    }
    if (!Array.isArray(store.providers)) store.providers = [];

    /* First-boot seed: if the store is empty, populate it from the
     * built-in provider registry so the new Model Settings UI has data to
     * show without the user having to enter anything by hand. */
    if (store.providers.length === 0) {
        try { seedFromRegistry(); } catch (err) {
            console.warn('[providers] seed failed:', err.message);
        }
    }

    /* Legacy hint migration: copy every model id from the now-deprecated
     * provider-hints.js table into the matching provider's models[]. This
     * preserves routing for any model that lived only in the JS hint
     * table (e.g. older routes that bypassed the providers.json catalog).
     * Gated by a `_hintsMigrated` flag persisted on the store object so
     * it runs exactly once. */
    if (!store._hintsMigrated) {
        try { seedHintsIntoProviders(); } catch (err) {
            console.warn('[providers] hints migration failed:', err.message);
        }
        store._hintsMigrated = true;
        try { persist(); } catch (_) { /* best-effort */ }
    }
}

/** Legacy model→provider hint table. Embedded here so the migration
 *  doesn't depend on the now-deleted backend/providers/provider-hints.js.
 *  After this migration runs once, every model below lives in
 *  providers.json under its provider's models[], and the resolver
 *  finds it via the catalog-first cascade. */
const LEGACY_HINTS = {
    // Groq
    'llama-3.1-70b-versatile': 'groq',
    'llama-3.1-8b-instant': 'groq',
    'llama-3.3-70b-versatile': 'groq',
    'mixtral-8x7b-32768': 'groq',
    'gemma2-9b-it': 'groq',
    // Mistral
    'mistral-large-latest': 'mistral',
    'mistral-small-latest': 'mistral',
    'codestral-latest': 'mistral',
    'pixtral-large-latest': 'mistral',
    // Cohere
    'command-r-plus': 'cohere',
    'command-r': 'cohere',
    'command-light': 'cohere',
    // Perplexity
    'sonar-pro': 'perplexity',
    'sonar-plus': 'perplexity',
    'sonar': 'perplexity',
    // Together
    'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo': 'together',
    'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo': 'together',
    'mistralai/Mixtral-8x7B-Instruct-v0.1': 'together',
    // Fireworks
    'accounts/fireworks/models/llama-v3p1-70b-instruct': 'fireworks',
    'accounts/fireworks/models/mixtral-8x7b-instruct': 'fireworks',
    // Replicate
    'meta/meta-llama-3.1-405b-instruct': 'replicate',
    'meta/meta-llama-3-70b-instruct': 'replicate',
    // Cerebras
    'llama3.1-8b': 'cerebras',
    'llama3.1-70b': 'cerebras',
    // Fal
    'fal-ai/flux/schnell': 'fal',
    'fal-ai/flux-pro': 'fal',
    'fal-ai/aurora': 'fal',
    // xAI Grok
    'grok-2-latest': 'grok',
    'grok-2': 'grok',
    'grok-beta': 'grok',
    // Qwen
    'qwen-plus': 'qwen',
    'qwen-max': 'qwen',
    'qwen-turbo': 'qwen',
    'qwq-32b': 'qwen',
    // Tencent
    'hunyuan-lite': 'tencent',
    'hunyuan-standard': 'tencent',
    'hunyuan-large': 'tencent',
    // Microsoft / Azure
    'gpt-4o': 'microsoft',
    'gpt-4o-mini': 'microsoft',
    'o1-preview': 'microsoft',
    'o1-mini': 'microsoft',
    // Local
    'local-model': 'lmstudio',
};

/** One-time migration: copy legacy provider-hints entries into the
 *  providers.json store. Idempotent — models that already exist are
 *  skipped. Uses the embedded LEGACY_HINTS table so this works even
 *  after backend/providers/provider-hints.js has been deleted. */
function seedHintsIntoProviders() {
    if (!LEGACY_HINTS || typeof LEGACY_HINTS !== 'object') return;

    const now = new Date().toISOString();
    let added = 0;
    for (const [modelId, providerName] of Object.entries(LEGACY_HINTS)) {
        if (!modelId || !providerName) continue;
        const lowerName = String(providerName).toLowerCase();
        const target = store.providers.find((p) =>
            p.id === providerName || (p.name || '').toLowerCase() === lowerName
        );
        if (!target) continue;
        if (!Array.isArray(target.models)) target.models = [];
        if (target.models.some((m) => m && m.id === modelId)) continue;
        target.models.push({
            id: modelId,
            name: modelId,
            contextWindow: null,
            reasoning: false,
            free: false,
            source: 'manual',
            createdAt: now,
            updatedAt: now,
        });
        added += 1;
    }
    if (added > 0) {
        console.log(`[providers] migrated ${added} legacy hint model${added === 1 ? '' : 's'} into providers.json`);
    }
}

function persist() {
    try {
        const dir = path.dirname(STORE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
    } catch (err) {
        console.warn('[providers] failed to persist store:', err.message);
    }
}

function findProvider(id) {
    return store.providers.find((p) => p.id === id);
}

/**
 * Read-only getters used by the routing layer (lib/config.js
 * getProviderConfig) to consult the canonical provider store before
 * falling back to config.json. Returns the raw in-memory record so
 * callers can read apiKey/baseUrl/apiFormat/enabled directly.
 */
function getStoredProvider(id) {
    if (!id) return null;
    return store.providers.find((p) => p.id === id) || null;
}

function getStoredProviderByName(name) {
    if (!name) return null;
    const lower = String(name).toLowerCase();
    return (
        store.providers.find((p) => p.id === name) ||
        store.providers.find((p) => (p.name || '').toLowerCase() === lower) ||
        null
    );
}

/** Public listing (used by tests and any other caller that needs the
 *  full in-memory state without going through the publicProvider
 *  redaction). */
function listPublicProviders() {
    return store.providers.slice();
}

function publicProvider(p) {
    return {
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiFormat: p.apiFormat,
        enabled: !!p.enabled,
        apiKeySet: !!p.apiKey,
        autoFetch: !!p.autoFetch,
        models: Array.isArray(p.models) ? p.models : [],
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
    };
}

function newId(name) {
    const slug = String(name || 'provider')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    const rand = crypto.randomBytes(3).toString('hex');
    return `${slug || 'provider'}-${rand}`;
}

load();

/* ── Auto-fetch from `<baseUrl>/v1/models` (smart-appended) ──────────── */
/* Constructs the right models-list URL for the provider's API format so
 * the user can enter just the bare host (e.g. "https://api.openai.com")
 * and we append "/v1/models" automatically. If their baseUrl already
 * ends in "/v1" (e.g. "https://api.openai.com/v1"), we only append
 * "/models" to avoid a duplicated path segment.
 *
 * Anthropic doesn't expose a models endpoint — for `anthropic_messages`
 * we skip the live fetch entirely and rely on the static fallback in
 * `model-list.js`'s `getModelList()` path. */

function buildModelsUrl(baseUrl) {
    const trimmed = String(baseUrl || '').replace(/\/+$/, '');
    if (/\/v1$/.test(trimmed)) return `${trimmed}/models`;
    return `${trimmed}/v1/models`;
}

function providerSupportsLiveModelsList(apiFormat) {
    // Anthropic doesn't expose a /v1/models endpoint.
    return apiFormat !== 'anthropic';
}

async function fetchModelsFromProvider(p) {
    if (!p || !p.baseUrl) throw new Error('Provider has no baseUrl');
    if (!p.apiKey) throw new Error('Provider has no API key configured');
    if (!providerSupportsLiveModelsList(p.apiFormat)) {
        throw new Error('This provider does not expose a live models endpoint');
    }

    const url = buildModelsUrl(p.baseUrl);

    const resp = await fetch(url, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${p.apiKey}`,
        },
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Provider returned ${resp.status}: ${text.slice(0, 200)}`);
    }
    const json = await resp.json();
    const list = Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.models)
          ? json.models
          : [];
    return list
        .map((m) => {
            if (typeof m === 'string') return { id: m, name: m };
            return {
                id: m.id || m.name,
                name: m.name || m.id,
                contextWindow: m.context_window || m.contextWindow,
                reasoning: !!(m.supported_parameters?.includes('reasoning') || m.reasoning),
            };
        })
        .filter((m) => m.id);
}

async function refreshProviderModels(p) {
    const fetched = await fetchModelsFromProvider(p);
    const byId = new Map((p.models || []).map((m) => [m.id, { ...m }]));
    const added = [];
    const updated = [];
    for (const m of fetched) {
        const existing = byId.get(m.id);
        if (existing) {
            existing.name = m.name || existing.name;
            existing.contextWindow = m.contextWindow ?? existing.contextWindow;
            existing.reasoning = m.reasoning ?? existing.reasoning;
            existing.source = 'fetched';
            existing.updatedAt = new Date().toISOString();
            updated.push(m.id);
        } else {
            byId.set(m.id, {
                id: m.id,
                name: m.name,
                contextWindow: m.contextWindow,
                reasoning: !!m.reasoning,
                free: false,
                source: 'fetched',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            added.push(m.id);
        }
    }
    // Preserve manual models; remove fetched models no longer returned.
    const removed = [];
    for (const [id, m] of byId) {
        if (m.source === 'fetched' && !fetched.find((f) => f.id === id)) {
            byId.delete(id);
            removed.push(id);
        }
    }
    p.models = Array.from(byId.values());
    p.updatedAt = new Date().toISOString();
    persist();
    return { added, updated, removed };
}

/* ── Route handlers ─────────────────────────────────────────────────── */

function jsonBody(req, res, max = 1024 * 64) {
    return readJsonBody(req, res, max);
}

function sendErr(res, status, code, message) {
    sendJson(res, { error: { code, message } }, status);
}

async function handleProvidersRoutes(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const method = req.method;

    /* List all providers */
    if (path === '/api/providers' && method === 'GET') {
        sendJson(res, store.providers.map(publicProvider));
        return true;
    }

    /* Create a provider */
    if (path === '/api/providers' && method === 'POST') {
        const body = await jsonBody(req, res);
        if (!body || !body.name || !body.baseUrl || !body.apiFormat) {
            sendErr(res, 400, 'invalid_input', 'name, baseUrl, apiFormat are required');
            return true;
        }
        const id = body.id && /^[a-z0-9][a-z0-9-]*$/i.test(body.id) ? body.id : newId(body.name);
        if (findProvider(id)) {
            sendErr(res, 409, 'duplicate_id', `Provider ${id} already exists`);
            return true;
        }
        const p = {
            id,
            name: body.name,
            baseUrl: body.baseUrl,
            apiFormat: body.apiFormat,
            apiKey: body.apiKey || '',
            enabled: body.enabled !== false,
            autoFetch: !!body.autoFetch,
            models: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        store.providers.push(p);
        persist();
        sendJson(res, publicProvider(p), 201);
        return true;
    }

    /* Per-provider routes */
    const providerMatch = path.match(/^\/api\/providers\/([^/]+)(\/.*)?$/);
    if (providerMatch) {
        const id = decodeURIComponent(providerMatch[1]);
        const subPath = providerMatch[2] || '';
        const p = findProvider(id);
        if (!p) {
            sendErr(res, 404, 'not_found', `Provider ${id} not found`);
            return true;
        }

        /* Update provider */
        if (subPath === '' && method === 'PATCH') {
            const body = await jsonBody(req, res);
            if (body.name !== undefined) p.name = String(body.name);
            if (body.baseUrl !== undefined) p.baseUrl = String(body.baseUrl);
            if (body.apiFormat !== undefined) p.apiFormat = body.apiFormat;
            if (body.apiKey !== undefined) p.apiKey = String(body.apiKey);
            if (body.enabled !== undefined) p.enabled = !!body.enabled;
            if (body.autoFetch !== undefined) p.autoFetch = !!body.autoFetch;
            p.updatedAt = new Date().toISOString();
            persist();
            sendJson(res, publicProvider(p));
            return true;
        }

        /* Delete provider */
        if (subPath === '' && method === 'DELETE') {
            store.providers = store.providers.filter((x) => x.id !== id);
            persist();
            sendJson(res, { ok: true });
            return true;
        }

        /* Add model */
        if (subPath === '/models' && method === 'POST') {
            const body = await jsonBody(req, res);
            if (!body || !body.id) {
                sendErr(res, 400, 'invalid_input', 'model id is required');
                return true;
            }
            if ((p.models || []).find((m) => m.id === body.id)) {
                sendErr(res, 409, 'duplicate_model', `Model ${body.id} already exists on ${id}`);
                return true;
            }
            const m = {
                id: body.id,
                name: body.name || body.id,
                contextWindow: body.contextWindow,
                reasoning: !!body.reasoning,
                free: !!body.free,
                source: 'manual',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            p.models = [...(p.models || []), m];
            p.updatedAt = new Date().toISOString();
            persist();
            sendJson(res, publicProvider(p), 201);
            return true;
        }

        /* Update / delete model */
        const modelMatch = subPath.match(/^\/models\/([^/]+)$/);
        if (modelMatch) {
            const modelId = decodeURIComponent(modelMatch[1]);
            const existing = (p.models || []).find((m) => m.id === modelId);
            if (method === 'PATCH') {
                if (!existing) {
                    sendErr(res, 404, 'not_found', `Model ${modelId} not found on ${id}`);
                    return true;
                }
                const body = await jsonBody(req, res);
                if (body.name !== undefined) existing.name = String(body.name);
                if (body.contextWindow !== undefined) existing.contextWindow = body.contextWindow;
                if (body.reasoning !== undefined) existing.reasoning = !!body.reasoning;
                if (body.free !== undefined) existing.free = !!body.free;
                existing.updatedAt = new Date().toISOString();
                p.updatedAt = new Date().toISOString();
                persist();
                sendJson(res, publicProvider(p));
                return true;
            }
            if (method === 'DELETE') {
                if (!existing) {
                    sendErr(res, 404, 'not_found', `Model ${modelId} not found on ${id}`);
                    return true;
                }
                p.models = (p.models || []).filter((m) => m.id !== modelId);
                p.updatedAt = new Date().toISOString();
                persist();
                sendJson(res, { ok: true });
                return true;
            }
        }

        /* Refresh models from /v1/models */
        if (subPath === '/models/refresh' && method === 'POST') {
            try {
                const result = await refreshProviderModels(p);
                sendJson(res, result);
            } catch (err) {
                sendErr(res, 502, 'refresh_failed', err.message || String(err));
            }
            return true;
        }
    }

    return false;
}

module.exports = {
    handleProvidersRoutes,
    getStoredProvider,
    getStoredProviderByName,
    listPublicProviders,
    /** Exposed for the unit test (and for advanced callers that want to
     *  trigger a re-seed after manually clearing providers.json). */
    seedFromRegistry,
};
