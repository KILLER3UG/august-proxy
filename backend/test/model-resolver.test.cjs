/* ModelResolver tests — alias-first resolution with active-provider fallback.
 *
 * Uses the same require.cache injection pattern as route-resolver.test.cjs
 * so the resolver runs against a fixture without touching disk or env vars.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');

const RESOLVER_PATH = path.join(__dirname, '..', 'providers', 'model-resolver.js');
const REGISTRY_PATH = path.join(__dirname, '..', 'providers', 'provider-registry.js');
const CONFIG_PATH = path.join(__dirname, '..', 'lib', 'config.js');
const ROUTE_RESOLVER_PATH = path.join(__dirname, '..', 'providers', 'route-resolver.js');
const PROVIDER_RESOLVER_PATH = path.join(__dirname, '..', 'providers', 'provider-resolver.js');
const ROUTES_PATH = path.join(__dirname, '..', 'services', 'providers', 'providers-routes.js');
const MODEL_LIST_PATH = path.join(__dirname, '..', 'providers', 'model-list.js');

/* ── Fixtures ─────────────────────────────────────────────────────── */

/* Catalog entries used by both route-resolver and the alias map. */
const FIXTURE_STORE = [
    {
        id: 'anthropic',
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiFormat: 'anthropic',
        enabled: true,
        apiKey: 'sk-ant',
        models: [
            { id: 'claude-3-5-sonnet-20241022', name: 'claude-3-5-sonnet-20241022' },
            { id: 'claude-opus-4-7', name: 'claude-opus-4-7' },
        ],
    },
    {
        id: 'opencode-zen',
        name: 'OpenCode Zen',
        baseUrl: 'https://opencode.ai/zen/v1',
        apiFormat: 'openai-chat',
        enabled: true,
        apiKey: 'sk-zen',
        models: [
            { id: 'deepseek-v4-flash-free', name: 'deepseek-v4-flash-free' },
        ],
    },
];

/* JS profiles — the active provider in fixture. */
const FIXTURE_PROFILES = [
    {
        name: 'anthropic',
        aliases: ['anthropic'],
        apiMode: 'anthropic_messages',
        envVars: ['ANTHROPIC_API_KEY'],
        defaultModel: 'claude-3-5-sonnet-20241022',
        isAvailable: () => true,
        resolveApiKey: () => 'sk-ant',
        resolveBaseUrl: () => 'https://api.anthropic.com',
    },
    {
        name: 'opencode-zen',
        aliases: ['opencode-zen'],
        apiMode: 'openai_chat',
        envVars: ['OPENCODE_ZEN_KEY'],
        defaultModel: 'deepseek-v4-flash-free',
        isAvailable: () => true,
        resolveApiKey: () => 'sk-zen',
        resolveBaseUrl: () => 'https://opencode.ai/zen/v1',
    },
];

/* User-defined aliases from config.modelAliases. */
const FIXTURE_USER_ALIASES = [
    {
        alias: 'my-claude',
        targetModel: 'claude-3-5-sonnet-20241022',
        targetProvider: 'anthropic',
    },
];

/* ── Mock injection ───────────────────────────────────────────────── */

function injectMocks({ activeProviderName = 'anthropic', userAliases = FIXTURE_USER_ALIASES, activeProviderAvailable = true } = {}) {
    require.cache[ROUTES_PATH] = {
        id: ROUTES_PATH,
        filename: ROUTES_PATH,
        loaded: true,
        exports: {
            listPublicProviders: () => FIXTURE_STORE,
            getStoredProviderByName: (name) => {
                if (!name) return null;
                const lower = String(name).toLowerCase();
                return FIXTURE_STORE.find((s) => s.id === name || (s.name || '').toLowerCase() === lower) || null;
            },
        },
    };

    require.cache[REGISTRY_PATH] = {
        id: REGISTRY_PATH,
        filename: REGISTRY_PATH,
        loaded: true,
        exports: {
            listProviders: () => FIXTURE_PROFILES,
            getProvider: (name) => {
                if (!name) return null;
                const lower = String(name).toLowerCase();
                return FIXTURE_PROFILES.find((p) =>
                    p.name === name || p.name === lower ||
                    (Array.isArray(p.aliases) && p.aliases.includes(lower))
                ) || null;
            },
        },
    };

    require.cache[CONFIG_PATH] = {
        id: CONFIG_PATH,
        filename: CONFIG_PATH,
        loaded: true,
        exports: {
            getConfig: () => ({ modelAliases: userAliases, activeProvider: activeProviderName }),
            getProviderConfig: (providerName) => {
                if (!providerName) return null;
                const stored = FIXTURE_STORE.find(
                    (s) => s.id === providerName || (s.name || '').toLowerCase() === String(providerName).toLowerCase()
                );
                if (!stored) return null;
                return { apiKey: stored.apiKey, baseUrl: stored.baseUrl, apiFormat: stored.apiFormat };
            },
            getActiveProvider: () => activeProviderName,
        },
    };

    require.cache[PROVIDER_RESOLVER_PATH] = {
        id: PROVIDER_RESOLVER_PATH,
        filename: PROVIDER_RESOLVER_PATH,
        loaded: true,
        exports: {
            resolveActiveProvider: () => {
                if (!activeProviderAvailable) return null;
                const p = FIXTURE_PROFILES.find((pp) => pp.name === activeProviderName);
                if (!p) return null;
                const cfg = FIXTURE_STORE.find((s) => s.id === activeProviderName) || {};
                return {
                    provider: p,
                    name: p.name,
                    baseUrl: cfg.baseUrl || p.resolveBaseUrl(),
                    apiKey: cfg.apiKey || p.resolveApiKey(),
                    model: cfg.model || p.defaultModel,
                    apiMode: p.apiMode,
                };
            },
        },
    };

    // model-list's resolveModelAliasDetails is async in production; the test
// mock returns a sync object because in practice it short-circuits on
// user-defined aliases (the first branch) which is always sync. The async
// catalog-cache path is covered separately by listAliasesAsync /
// getAliasForModelAsync.
require.cache[MODEL_LIST_PATH] = {
        id: MODEL_LIST_PATH,
        filename: MODEL_LIST_PATH,
        loaded: true,
        exports: {
            resolveModelAlias: (modelId) => modelId,
            resolveModelAliasDetails: (modelId) => {
                // Simulate catalog alias: 'claude-3-5-sonnet' -> 'claude-3-5-sonnet-20241022'
                if (modelId === 'claude-3-5-sonnet') {
                    return { modelId: 'claude-3-5-sonnet-20241022', provider: 'anthropic' };
                }
                if (modelId === 'opus-4-7') {
                    return { modelId: 'claude-opus-4-7', provider: 'anthropic' };
                }
                return { modelId, provider: '' };
            },
            getModelAliasMap: () => new Map([
                ['claude-3-5-sonnet', { modelId: 'claude-3-5-sonnet-20241022', provider: 'anthropic' }],
                ['opus-4-7', { modelId: 'claude-opus-4-7', provider: 'anthropic' }],
            ]),
        },
    };

    delete require.cache[ROUTE_RESOLVER_PATH];
    require(ROUTE_RESOLVER_PATH);

    delete require.cache[RESOLVER_PATH];
    return require(RESOLVER_PATH);
}

// ── Tests ───────────────────────────────────────────────────────────

test('model-resolver: resolve("claude-3-5-sonnet") routes via catalog alias to anthropic', () => {
    const { resolve } = injectMocks();
    const r = resolve('claude-3-5-sonnet');
    assert.equal(r.alias, 'claude-3-5-sonnet');
    assert.equal(r.provider, 'Anthropic');
    assert.equal(r.model, 'claude-3-5-sonnet-20241022');
    assert.equal(r.isFallback, false);
});

test('model-resolver: resolve(user-defined alias) uses config.modelAliases target', () => {
    const { resolve } = injectMocks();
    const r = resolve('my-claude');
    assert.equal(r.alias, 'my-claude');
    assert.equal(r.provider, 'Anthropic');
    assert.equal(r.model, 'claude-3-5-sonnet-20241022');
    assert.equal(r.isFallback, false);
});

test('model-resolver: resolve(raw backend id with provider) returns that provider', () => {
    const { resolve } = injectMocks();
    const r = resolve('claude-3-5-sonnet-20241022');
    assert.equal(r.alias, 'claude-3-5-sonnet-20241022');
    assert.equal(r.provider, 'Anthropic');
    assert.equal(r.model, 'claude-3-5-sonnet-20241022');
    assert.equal(r.isFallback, false);
});

test('model-resolver: resolve(unknown alias) throws ModelResolutionError', () => {
    const { resolve, ModelResolutionError } = injectMocks();
    assert.throws(
        () => resolve('MiniMax-M3'),
        (err) => err instanceof ModelResolutionError && /Alias 'MiniMax-M3' not found\./.test(err.message)
    );
});

test('model-resolver: resolveOrFallback(unknown alias) returns active-provider result with isFallback=true', () => {
    const { resolveOrFallback } = injectMocks({ activeProviderName: 'anthropic' });
    const r = resolveOrFallback('MiniMax-M3');
    assert.ok(r, 'expected fallback result');
    assert.equal(r.alias, 'MiniMax-M3');
    assert.equal(r.isFallback, true);
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.model, 'claude-3-5-sonnet-20241022');
});

test('model-resolver: resolveOrFallback(null) uses default alias and falls back to active provider', () => {
    const { resolveOrFallback, DEFAULT_ALIAS } = injectMocks({ activeProviderName: 'anthropic' });
    const r = resolveOrFallback(null);
    assert.ok(r, 'expected fallback result');
    assert.equal(r.alias, DEFAULT_ALIAS);
    assert.equal(r.isFallback, true);
    assert.equal(r.model, 'claude-3-5-sonnet-20241022');
});

test('model-resolver: resolveOrFallback returns null when no provider is available', () => {
    const { resolveOrFallback } = injectMocks({ activeProviderAvailable: false });
    const r = resolveOrFallback('MiniMax-M3');
    assert.equal(r, null);
});

test('model-resolver: resolveOrFallback with known alias does NOT mark as fallback', () => {
    const { resolveOrFallback } = injectMocks();
    const r = resolveOrFallback('claude-3-5-sonnet');
    assert.ok(r);
    assert.equal(r.isFallback, false);
    assert.equal(r.model, 'claude-3-5-sonnet-20241022');
});

test('model-resolver: listAliases() includes user-defined, catalog, and built-in Claude aliases', () => {
    const { listAliases, BUILTIN_CLAUDE_PUBLIC_ALIASES } = injectMocks();
    const aliases = listAliases();
    assert.ok(aliases.includes('my-claude'), 'should include user-defined alias');
    for (const builtin of BUILTIN_CLAUDE_PUBLIC_ALIASES) {
        assert.ok(aliases.includes(builtin), `should include built-in Claude alias '${builtin}'`);
    }
});

test('model-resolver: getDefaultAlias() returns the default sentinel', () => {
    const { getDefaultAlias, DEFAULT_ALIAS } = injectMocks();
    assert.equal(getDefaultAlias(), DEFAULT_ALIAS);
    assert.equal(DEFAULT_ALIAS, 'default');
});

test('model-resolver: getAliasForModel finds a user-defined alias whose target matches', () => {
    const { getAliasForModel } = injectMocks();
    assert.equal(getAliasForModel('claude-3-5-sonnet-20241022'), 'my-claude');
});

test('model-resolver: getAliasForModel returns the built-in id if it IS one of the Claude public aliases', () => {
    const { getAliasForModel } = injectMocks();
    assert.equal(getAliasForModel('claude-opus-4-6'), 'claude-opus-4-6');
});

test('model-resolver: getAliasForModel returns null for completely unknown model ids', () => {
    const { getAliasForModel } = injectMocks();
    assert.equal(getAliasForModel('totally-unknown-xyz'), null);
});

test('model-resolver: ModelResolutionError carries the input and reason', () => {
    const { resolve, ModelResolutionError } = injectMocks();
    try {
        resolve('MiniMax-M3');
        assert.fail('expected throw');
    } catch (err) {
        assert.ok(err instanceof ModelResolutionError);
        assert.equal(err.input, 'MiniMax-M3');
        assert.equal(err.reason, 'no_matching_provider');
    }
});