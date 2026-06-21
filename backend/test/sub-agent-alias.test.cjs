/* Sub-agent alias propagation tests.
 *
 * Verifies that when the parent session has a model alias, the spawned
 * sub-agent inherits it (instead of dropping it on the floor — the original
 * bug). We test via the public delegate-tools entry point so we don't have
 * to mock the entire workbench subsystem.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');

const DELEGATE_TOOLS_PATH = path.join(__dirname, '..', 'services', 'tools', 'delegate-tools.js');
const WORKBENCH_PATH = path.join(__dirname, '..', 'services', 'workbench', 'workbench.js');
const AGENT_SESSIONS_PATH = path.join(__dirname, '..', 'services', 'tools', 'agent-sessions.js');
const AGENT_JOBS_PATH = path.join(__dirname, '..', 'services', 'tools', 'agent-jobs.js');
const AGENT_REGISTRY_PATH = path.join(__dirname, '..', 'services', 'tools', 'agent-registry.js');
const REGISTRY_PATH = path.join(__dirname, '..', 'providers', 'provider-registry.js');
const CONFIG_PATH = path.join(__dirname, '..', 'lib', 'config.js');
const ROUTE_RESOLVER_PATH = path.join(__dirname, '..', 'providers', 'route-resolver.js');
const PROVIDER_RESOLVER_PATH = path.join(__dirname, '..', 'providers', 'provider-resolver.js');
const ROUTES_PATH = path.join(__dirname, '..', 'services', 'providers', 'providers-routes.js');
const MODEL_LIST_PATH = path.join(__dirname, '..', 'providers', 'model-list.js');

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
        ],
    },
];

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
];

function injectProviderMocks() {
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
            getConfig: () => ({ activeProvider: 'anthropic', modelAliases: [] }),
            getProviderConfig: (providerName) => {
                if (!providerName) return null;
                const stored = FIXTURE_STORE.find(
                    (s) => s.id === providerName || (s.name || '').toLowerCase() === String(providerName).toLowerCase()
                );
                if (!stored) return null;
                return { apiKey: stored.apiKey, baseUrl: stored.baseUrl, apiFormat: stored.apiFormat };
            },
            getActiveProvider: () => 'anthropic',
        },
    };
    require.cache[PROVIDER_RESOLVER_PATH] = {
        id: PROVIDER_RESOLVER_PATH,
        filename: PROVIDER_RESOLVER_PATH,
        loaded: true,
        exports: {
            resolveActiveProvider: () => {
                const p = FIXTURE_PROFILES.find((pp) => pp.name === 'anthropic');
                const cfg = FIXTURE_STORE.find((s) => s.id === 'anthropic') || {};
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
    require.cache[MODEL_LIST_PATH] = {
        id: MODEL_LIST_PATH,
        filename: MODEL_LIST_PATH,
        loaded: true,
        exports: {
            resolveModelAlias: (modelId) => modelId,
            resolveModelAliasDetails: (modelId) => {
                if (modelId === 'claude-3-5-sonnet') {
                    return { modelId: 'claude-3-5-sonnet-20241022', provider: 'anthropic' };
                }
                return { modelId, provider: '' };
            },
            getModelAliasMap: () => new Map([
                ['claude-3-5-sonnet', { modelId: 'claude-3-5-sonnet-20241022', provider: 'anthropic' }],
            ]),
        },
    };
    delete require.cache[ROUTE_RESOLVER_PATH];
    require(ROUTE_RESOLVER_PATH);
}

/* Build a fake workbench module whose sendWorkbenchMessage captures the
 * options it was called with and returns a canned assistant response. */
function injectFakeWorkbench({ capturedOpts, fetchCalls }) {
    require.cache[WORKBENCH_PATH] = {
        id: WORKBENCH_PATH,
        filename: WORKBENCH_PATH,
        loaded: true,
        exports: {
            getWorkbenchSession: () => ({ id: 'fake-sub-session' }),
            sendWorkbenchMessage: async (subSessionId, systemPrompt, opts) => {
                if (capturedOpts) capturedOpts.push(opts);
                return { assistant: 'fake sub-agent response' };
            },
        },
    };
}

function injectAgentStores() {
    require.cache[AGENT_SESSIONS_PATH] = {
        id: AGENT_SESSIONS_PATH,
        filename: AGENT_SESSIONS_PATH,
        loaded: true,
        exports: {
            createAgentSession: (input) => ({ id: 'fake-session', ...input }),
            updateAgentSession: () => ({}),
        },
    };
    require.cache[AGENT_JOBS_PATH] = {
        id: AGENT_JOBS_PATH,
        filename: AGENT_JOBS_PATH,
        loaded: true,
        exports: {
            createAgentJob: (input) => ({
                id: `job_test_${Math.random().toString(36).slice(2, 8)}`,
                ...input,
            }),
            appendAgentJobMessage: () => ({}),
            appendAgentJobToolResult: () => ({}),
            completeAgentJob: () => ({}),
            failAgentJob: () => ({}),
        },
    };
    require.cache[AGENT_REGISTRY_PATH] = {
        id: AGENT_REGISTRY_PATH,
        filename: AGENT_REGISTRY_PATH,
        loaded: true,
        exports: {
            getAgent: (id) => ({
                id: id || 'general',
                role: 'Test Agent',
                mode: 'subagent',
                goal: 'Test goal',
                scopes: ['project'],
                permissions: {},
                tools: [],
            }),
        },
    };
}

function loadDelegateTools() {
    delete require.cache[DELEGATE_TOOLS_PATH];
    return require(DELEGATE_TOOLS_PATH);
}

// ── Tests ───────────────────────────────────────────────────────────

test('delegate-tools: propagates parent session.model to sendWorkbenchMessage', async () => {
    injectProviderMocks();
    injectAgentStores();
    const capturedOpts = [];
    injectFakeWorkbench({ capturedOpts });
    const delegateTools = loadDelegateTools();

    const parentSession = { id: 'parent-1', model: 'claude-3-5-sonnet', modelProvider: null };

    await delegateTools.delegateTaskHandler(
        {
            goal: 'Investigate the bug',
            tasks: [{ id: 't1', description: 'Find the bug' }],
            parent_depth: 0,
        },
        { session: parentSession }
    );

    assert.equal(capturedOpts.length, 1, 'sendWorkbenchMessage should be called once');
    const opts = capturedOpts[0];
    assert.equal(opts.model, 'claude-3-5-sonnet',
        'sub-agent must inherit the parent alias, not drop it');
});

test('delegate-tools: when no parent alias, defaults to "default" sentinel', async () => {
    injectProviderMocks();
    injectAgentStores();
    const capturedOpts = [];
    injectFakeWorkbench({ capturedOpts });
    const delegateTools = loadDelegateTools();

    await delegateTools.delegateTaskHandler(
        {
            goal: 'Investigate the bug',
            tasks: [{ id: 't1', description: 'Find the bug' }],
            parent_depth: 0,
        },
        {} // empty ctx, no parent model
    );

    assert.equal(capturedOpts.length, 1);
    assert.equal(capturedOpts[0].model, 'default',
        'when parent has no model, default sentinel must be passed so the resolver can route');
});

test('delegate-tools: ctx.model (without a session) is used as the alias', async () => {
    injectProviderMocks();
    injectAgentStores();
    const capturedOpts = [];
    injectFakeWorkbench({ capturedOpts });
    const delegateTools = loadDelegateTools();

    await delegateTools.delegateTaskHandler(
        {
            goal: 'Investigate',
            tasks: [{ id: 't1', description: 'Find it' }],
            parent_depth: 0,
        },
        { model: 'claude-3-5-sonnet' }
    );

    assert.equal(capturedOpts[0].model, 'claude-3-5-sonnet');
});

test('delegate-tools: returns the sub-agent assistant text in the result', async () => {
    injectProviderMocks();
    injectAgentStores();
    injectFakeWorkbench({ capturedOpts: null });
    const delegateTools = loadDelegateTools();

    const result = await delegateTools.delegateTaskHandler(
        {
            goal: 'Test',
            tasks: [{ id: 't1', description: 'do something' }],
            parent_depth: 0,
        },
        { session: { id: 'p', model: 'claude-3-5-sonnet' } }
    );

    assert.ok(result.tasks);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].status, 'completed');
    assert.match(result.tasks[0].summary, /fake sub-agent response/);
});

test('delegate-tools: blocks at MAX_DELEGATION_DEPTH (depth > 3)', async () => {
    injectProviderMocks();
    injectAgentStores();
    const capturedOpts = [];
    injectFakeWorkbench({ capturedOpts });
    const delegateTools = loadDelegateTools();

    const result = await delegateTools.delegateTaskHandler(
        {
            goal: 'Test',
            tasks: [{ id: 't1', description: 'do something' }],
            parent_depth: 3, // depth + 1 = 4 > MAX_DELEGATION_DEPTH (3)
        },
        { session: { id: 'p', model: 'claude-3-5-sonnet' } }
    );

    assert.equal(result.tasks[0].status, 'blocked');
    assert.match(result.tasks[0].summary, /Max delegation depth/);
    assert.equal(capturedOpts.length, 0, 'must not call sendWorkbenchMessage when blocked');
});

test('delegate-tools: schema accepts parent_depth in 0..3 range', () => {
    const delegateTools = loadDelegateTools();
    // Should not throw.
    delegateTools.delegateSchema.parse({
        goal: 'Test',
        tasks: [{ description: 'do x' }],
        parent_depth: 2,
    });
    // Out-of-range should throw (Zod validation).
    assert.throws(() => {
        delegateTools.delegateSchema.parse({
            goal: 'Test',
            tasks: [{ description: 'do x' }],
            parent_depth: 5,
        });
    });
});