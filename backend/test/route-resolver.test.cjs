/* Route resolver tests — catalog-first cascade.
 *
 * These tests inject controlled provider-registry, lib/config, and
 * services/providers/providers-routes modules via require.cache so the
 * resolver runs against a fixture without touching disk. The mocks are
 * scoped to this test file and restored at the end.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');

const ROUTE_RESOLVER_PATH = path.join(__dirname, '..', 'providers', 'route-resolver.js');
const REGISTRY_PATH = path.join(__dirname, '..', 'providers', 'provider-registry.js');
const CONFIG_PATH = path.join(__dirname, '..', 'lib', 'config.js');
const ROUTES_PATH = path.join(__dirname, '..', 'services', 'providers', 'providers-routes.js');

/* Fixture: providers in providers-routes (the catalog). */
const FIXTURE_STORE = [
    {
        id: 'opencode-zen',
        name: 'OpenCode Zen',
        baseUrl: 'https://opencode.ai/zen/v1',
        apiFormat: 'openai-chat',
        enabled: true,
        apiKey: 'sk-zen',
        models: [
            { id: 'deepseek-v4-flash-free', name: 'deepseek-v4-flash-free' },
            { id: 'claude-opus-4-7', name: 'claude-opus-4-7' },
        ],
    },
    {
        id: 'opencode-go',
        name: 'OpenCode Go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiFormat: 'openai-chat',
        enabled: true,
        apiKey: 'sk-go',
        models: [
            { id: 'claude-opus-4-7', name: 'claude-opus-4-7' },
        ],
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiFormat: 'anthropic',
        enabled: false, // disabled but has credentials — must still route
        apiKey: 'sk-ant',
        models: [
            { id: 'claude-3-5-sonnet-20241022', name: 'claude-3-5-sonnet-20241022' },
        ],
    },
    {
        id: 'no-creds',
        name: 'No Credentials',
        baseUrl: 'https://example.com',
        apiFormat: 'openai-chat',
        enabled: false,
        apiKey: '',
        models: [
            { id: 'unreachable-model', name: 'unreachable-model' },
        ],
    },
    {
        id: 'store-only',
        name: 'Custom Store-Only',
        baseUrl: 'https://custom.example.com/v1',
        apiFormat: 'openai-chat',
        enabled: true,
        apiKey: 'sk-custom',
        models: [
            { id: 'custom-model-1', name: 'custom-model-1' },
        ],
    },
];

/* Fixture: providers in the JS provider-registry. Subset of FIXTURE_STORE. */
const FIXTURE_PROFILES = [
    {
        name: 'opencode-zen',
        aliases: ['opencode-zen'],
        apiMode: 'openai_chat',
        envVars: ['OPENCODE_ZEN_KEY'],
        defaultModel: 'claude-opus-4-7',
        isAvailable: () => true,
        resolveApiKey: () => 'sk-zen-env',
        resolveBaseUrl: () => 'https://opencode.ai/zen/v1',
    },
    {
        name: 'opencode-go',
        aliases: ['opencode-go'],
        apiMode: 'openai_chat',
        envVars: ['OPENCODE_GO_KEY'],
        defaultModel: 'claude-opus-4-7',
        isAvailable: () => true,
        resolveApiKey: () => 'sk-go-env',
        resolveBaseUrl: () => 'https://opencode.ai/zen/go/v1',
    },
    {
        name: 'anthropic',
        aliases: ['anthropic'],
        apiMode: 'anthropic_messages',
        envVars: ['ANTHROPIC_API_KEY'],
        defaultModel: 'claude-3-5-sonnet-20241022',
        isAvailable: () => true,
        resolveApiKey: () => 'sk-ant-env',
        resolveBaseUrl: () => 'https://api.anthropic.com',
    },
    {
        name: 'no-creds',
        aliases: ['no-creds'],
        apiMode: 'openai_chat',
        envVars: [],
        defaultModel: 'unreachable-model',
        isAvailable: () => false,
        resolveApiKey: () => '',
        resolveBaseUrl: () => 'https://example.com',
    },
    // 'store-only' is intentionally NOT in FIXTURE_PROFILES — it's store-only.
];

function injectMocks() {
    // Mock providers-routes (used lazily by the resolver).
    require.cache[ROUTES_PATH] = {
        id: ROUTES_PATH,
        filename: ROUTES_PATH,
        loaded: true,
        exports: {
            listPublicProviders: () => FIXTURE_STORE,
            getStoredProviderByName: (name) => {
                if (!name) return null;
                const lower = String(name).toLowerCase();
                return FIXTURE_STORE.find((s) =>
                    s.id === name || (s.name || '').toLowerCase() === lower
                ) || null;
            },
        },
    };

    // Mock provider-registry.
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

    // Mock lib/config.
    require.cache[CONFIG_PATH] = {
        id: CONFIG_PATH,
        filename: CONFIG_PATH,
        loaded: true,
        exports: {
            getProviderConfig: (providerName) => {
                if (!providerName) return null;
                // Find matching store entry (mock the merged config).
                const stored = FIXTURE_STORE.find(
                    (s) => s.id === providerName || (s.name || '').toLowerCase() === String(providerName).toLowerCase()
                );
                if (!stored) return null;
                return {
                    apiKey: stored.apiKey,
                    baseUrl: stored.baseUrl,
                    apiFormat: stored.apiFormat,
                    enabled: stored.enabled,
                };
            },
            getActiveProvider: () => null, // active-provider fallback must NOT fire
        },
    };

    // Force-reload route-resolver so it picks up the mocked deps.
    delete require.cache[ROUTE_RESOLVER_PATH];
    return require(ROUTE_RESOLVER_PATH);
}

test('route-resolver: exact catalog match routes to the right provider', () => {
    const { resolveProviderForModel } = injectMocks();
    const r = resolveProviderForModel('deepseek-v4-flash-free');
    assert.ok(r, 'expected a resolved provider');
    assert.equal(r.name, 'OpenCode Zen');
    assert.equal(r.baseUrl, 'https://opencode.ai/zen/v1');
    assert.equal(r.apiKey, 'sk-zen');
    assert.equal(r.apiMode, 'openai_chat');
});

test('route-resolver: duplicate exact match with providerHint routes to hinted provider', () => {
    const { resolveProviderForModel } = injectMocks();
    const r = resolveProviderForModel('claude-opus-4-7', { providerHint: 'opencode-go' });
    assert.ok(r, 'expected a resolved provider');
    assert.equal(r.name, 'OpenCode Go');
    assert.equal(r.baseUrl, 'https://opencode.ai/zen/go/v1');
    assert.equal(r.apiKey, 'sk-go');
});

test('route-resolver: provider without credentials is skipped even with matching model', () => {
    const { resolveProviderForModel } = injectMocks();
    // 'unreachable-model' only exists in 'no-creds', which has no credentials.
    const r = resolveProviderForModel('unreachable-model');
    assert.equal(r, null);
});

test('route-resolver: enabled:false + credentials still routes', () => {
    const { resolveProviderForModel } = injectMocks();
    // 'claude-3-5-sonnet-20241022' is in 'anthropic' which is enabled:false
    // but has an apiKey — hasCredentials treats credentials, not enabled.
    const r = resolveProviderForModel('claude-3-5-sonnet-20241022');
    assert.ok(r, 'expected a resolved provider');
    assert.equal(r.apiMode, 'anthropic_messages');
    assert.equal(r.apiKey, 'sk-ant');
});

test('route-resolver: store-only provider (no JS profile) routes via catalog', () => {
    const { resolveProviderForModel } = injectMocks();
    const r = resolveProviderForModel('custom-model-1');
    assert.ok(r, 'expected a resolved provider for store-only entry');
    assert.equal(r.baseUrl, 'https://custom.example.com/v1');
    assert.equal(r.apiKey, 'sk-custom');
    assert.equal(r.apiMode, 'openai_chat');
});

test('route-resolver: longest prefix match wins', () => {
    const { resolveProviderForModel } = injectMocks();
    // Both 'opencode-zen' and 'opencode-go' are prefixes of 'opencode-zen/foo'.
    // 'opencode-zen' (id) is a longer prefix than 'opencode-go' (id) — they
    // tie at 10 chars. Use a model that distinguishes them.
    const r = resolveProviderForModel('opencode-go/some-model');
    assert.ok(r, 'expected a resolved provider');
    assert.equal(r.name, 'OpenCode Go');
    assert.equal(r.baseUrl, 'https://opencode.ai/zen/go/v1');
});

test('route-resolver: unknown model returns null', () => {
    const { resolveProviderForModel } = injectMocks();
    const r = resolveProviderForModel('totally-unknown-model-xyz');
    assert.equal(r, null);
});

test('route-resolver: empty catalog returns null', () => {
    // Inject empty mocks.
    require.cache[ROUTES_PATH] = {
        id: ROUTES_PATH,
        filename: ROUTES_PATH,
        loaded: true,
        exports: { listPublicProviders: () => [] },
    };
    delete require.cache[ROUTE_RESOLVER_PATH];
    const { resolveProviderForModel } = require(ROUTE_RESOLVER_PATH);
    const r = resolveProviderForModel('deepseek-v4-flash-free');
    assert.equal(r, null);
});

test('route-resolver: providers-routes load failure returns null (not throws)', () => {
    // Simulate providers-routes throwing on require.
    const orig = require.cache[ROUTES_PATH];
    require.cache[ROUTES_PATH] = {
        id: ROUTES_PATH,
        filename: ROUTES_PATH,
        loaded: true,
        exports: new Proxy({}, {
            get() { throw new Error('mocked module failure'); }
        }),
    };
    try {
        delete require.cache[ROUTE_RESOLVER_PATH];
        const { resolveProviderForModel } = require(ROUTE_RESOLVER_PATH);
        const r = resolveProviderForModel('deepseek-v4-flash-free');
        assert.equal(r, null, 'should return null when providers-routes is broken');
    } finally {
        require.cache[ROUTES_PATH] = orig;
        delete require.cache[ROUTE_RESOLVER_PATH];
    }
});

test('route-resolver: explicit providerHint bypasses catalog', () => {
    const { resolveProviderForModel } = injectMocks();
    const r = resolveProviderForModel('totally-unknown-model', { providerHint: 'anthropic' });
    assert.ok(r, 'providerHint should resolve even when model id is unknown');
    assert.equal(r.name, 'Anthropic');
    assert.equal(r.apiMode, 'anthropic_messages');
});

test('route-resolver: apiFormat openai-responses maps to codex_responses apiMode', () => {
    // Inject a fixture with apiFormat: 'openai-responses'.
    const origStore = FIXTURE_STORE;
    const augmented = FIXTURE_STORE.concat({
        id: 'codex-store',
        name: 'Codex Store',
        baseUrl: 'https://codex.example.com',
        apiFormat: 'openai-responses',
        enabled: true,
        apiKey: 'sk-codex',
        models: [{ id: 'codex-foo', name: 'codex-foo' }],
    });
    require.cache[ROUTES_PATH] = {
        id: ROUTES_PATH,
        filename: ROUTES_PATH,
        loaded: true,
        exports: { listPublicProviders: () => augmented },
    };
    delete require.cache[ROUTE_RESOLVER_PATH];
    const { resolveProviderForModel } = require(ROUTE_RESOLVER_PATH);
    const r = resolveProviderForModel('codex-foo');
    assert.ok(r, 'expected a resolved provider');
    assert.equal(r.apiMode, 'codex_responses');
    // Restore.
    require.cache[ROUTES_PATH] = {
        id: ROUTES_PATH,
        filename: ROUTES_PATH,
        loaded: true,
        exports: { listPublicProviders: () => origStore },
    };
    delete require.cache[ROUTE_RESOLVER_PATH];
});

test('route-resolver: active-provider fallback is NOT consulted (caller responsibility)', () => {
    // The fixture's getActiveProvider returns null, but even if it returned a
    // valid provider, the resolver must NOT use it. Verify by setting up an
    // active provider that has no matching model — the cascade should still
    // return null.
    require.cache[CONFIG_PATH] = {
        id: CONFIG_PATH,
        filename: CONFIG_PATH,
        loaded: true,
        exports: {
            getProviderConfig: () => null,
            getActiveProvider: () => 'some-active-provider',
        },
    };
    delete require.cache[ROUTE_RESOLVER_PATH];
    const { resolveProviderForModel } = require(ROUTE_RESOLVER_PATH);
    const r = resolveProviderForModel('unknown-model-id');
    assert.equal(r, null, 'cascade must not silently fall back to the active provider');
});

test('route-resolver: source no longer imports provider-hints.js', () => {
    const source = require('node:fs').readFileSync(ROUTE_RESOLVER_PATH, 'utf8');
    assert.ok(
        !source.includes("require('./provider-hints')") &&
        !source.includes("require(\"./provider-hints\")"),
        'route-resolver.js must not import provider-hints.js'
    );
    assert.ok(
        !source.includes('getProviderHint'),
        'route-resolver.js must not reference getProviderHint'
    );
});
