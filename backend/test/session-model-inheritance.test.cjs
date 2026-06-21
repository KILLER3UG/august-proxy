/* session-model-inheritance tests */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'lib', 'config.js');
const RESOLVER_PATH = path.join(__dirname, '..', 'providers', 'model-resolver.js');
const INHERIT_PATH = path.join(__dirname, '..', 'providers', 'session-model-inheritance.js');

const USER_ALIASES = [
    { alias: 'Opus 4.7-Alias', targetModel: 'claude-opus-4-7', targetProvider: 'anthropic' },
    { alias: 'Sonnet 4.6-Alias', targetModel: 'claude-sonnet-4-6', targetProvider: 'opencode-zen' },
];

const RESOLVER_FIXTURE = {
    listAliases: () => [
        'claude-3-7-sonnet-20250219',
        'claude-3-5-sonnet-20241022',
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
        'Opus 4.7-Alias',
        'Sonnet 4.6-Alias',
        'claude-3-5-sonnet',
    ],
    resolve: (input) => {
        const map = {
            'Opus 4.7-Alias': { alias: 'Opus 4.7-Alias', provider: 'anthropic', model: 'claude-opus-4-7' },
            'Sonnet 4.6-Alias': { alias: 'Sonnet 4.6-Alias', provider: 'opencode-zen', model: 'claude-sonnet-4-6' },
            'claude-3-5-sonnet': { alias: 'claude-3-5-sonnet', provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
            'claude-opus-4-7': { alias: 'claude-opus-4-7', provider: 'anthropic', model: 'claude-opus-4-7' },
        };
        if (!map[input]) {
            return { alias: input, provider: 'unknown', model: input, isFallback: false };
        }
        return map[input];
    },
};

function injectMocks(fallbackConfig) {
    require.cache[CONFIG_PATH] = {
        id: CONFIG_PATH,
        filename: CONFIG_PATH,
        loaded: true,
        exports: { getConfig: () => ({ modelAliases: USER_ALIASES, subAgentFallback: fallbackConfig }) },
    };
    require.cache[RESOLVER_PATH] = {
        id: RESOLVER_PATH,
        filename: RESOLVER_PATH,
        loaded: true,
        exports: RESOLVER_FIXTURE,
    };
    delete require.cache[INHERIT_PATH];
    return require(INHERIT_PATH);
}

function silentLogger() {
    return { log() {}, warn() {}, error() {} };
}

test('isAliasCandidate: recognises user aliases', () => {
    const inherit = injectMocks();
    assert.equal(inherit.isAliasCandidate('Opus 4.7-Alias'), true);
    assert.equal(inherit.isAliasCandidate('Sonnet 4.6-Alias'), true);
});

test('isAliasCandidate: recognises built-in Claude aliases', () => {
    const inherit = injectMocks();
    assert.equal(inherit.isAliasCandidate('claude-opus-4-7'), true);
    assert.equal(inherit.isAliasCandidate('claude-sonnet-4-6'), true);
});

test('isAliasCandidate: rejects raw backend ids', () => {
    const inherit = injectMocks();
    assert.equal(inherit.isAliasCandidate('claude-opus-4-7-raw'), false);
    assert.equal(inherit.isAliasCandidate('MiniMax-M3'), false);
    assert.equal(inherit.isAliasCandidate('deepseek-v3'), false);
});

test('first non-alias request is rejected', async () => {
    const inherit = injectMocks();
    const out = await inherit.resolveInheritedModel({
        sessionId: 'sess-A',
        model: 'deepseek-chat',
        logger: silentLogger(),
    });
    assert.equal(out.action, 'reject_first_non_alias');
    assert.equal(out.resolution, null);
});

test('first alias request resolves and stores', async () => {
    const inherit = injectMocks();
    const out = await inherit.resolveInheritedModel({
        sessionId: 'sess-B',
        model: 'Opus 4.7-Alias',
        logger: silentLogger(),
    });
    assert.equal(out.action, 'use_alias');
    assert.equal(out.resolution.provider, 'anthropic');
    assert.equal(out.resolution.model, 'claude-opus-4-7');
    const state = inherit.getSessionState('sess-B');
    assert.equal(state.aliases.size, 1);
    assert.equal(state.aliases.get('Opus 4.7-Alias').model, 'claude-opus-4-7');
    assert.equal(state.lastAlias, 'Opus 4.7-Alias');
});

test('two aliases in the same session keep independent mappings', async () => {
    const inherit = injectMocks();
    await inherit.resolveInheritedModel({ sessionId: 'sess-C', model: 'Opus 4.7-Alias', logger: silentLogger() });
    await inherit.resolveInheritedModel({ sessionId: 'sess-C', model: 'Sonnet 4.6-Alias', logger: silentLogger() });
    const state = inherit.getSessionState('sess-C');
    assert.equal(state.aliases.size, 2);
    assert.equal(state.aliases.get('Opus 4.7-Alias').model, 'claude-opus-4-7');
    assert.equal(state.aliases.get('Sonnet 4.6-Alias').model, 'claude-sonnet-4-6');
});

test('sub-agent with explicit parentAlias inherits that alias model', async () => {
    const inherit = injectMocks();
    await inherit.resolveInheritedModel({ sessionId: 'sess-D', model: 'Opus 4.7-Alias', logger: silentLogger() });
    await inherit.resolveInheritedModel({ sessionId: 'sess-D', model: 'Sonnet 4.6-Alias', logger: silentLogger() });
    const out = await inherit.resolveInheritedModel({
        sessionId: 'sess-D',
        model: 'deepseek-chat',
        parentAlias: 'Opus 4.7-Alias',
        logger: silentLogger(),
    });
    assert.equal(out.action, 'use_inherited');
    assert.equal(out.parentAlias, 'Opus 4.7-Alias');
    assert.equal(out.resolution.model, 'claude-opus-4-7');
});

test('sub-agent with no parent alias and no lastAlias is rejected', async () => {
    const inherit = injectMocks();
    const out = await inherit.resolveInheritedModel({
        sessionId: 'sess-E',
        model: 'deepseek-chat',
        logger: silentLogger(),
    });
    assert.equal(out.action, 'reject_first_non_alias');
});

test('sub-agent with no parent alias but lastAlias available falls back', async () => {
    const inherit = injectMocks();
    await inherit.resolveInheritedModel({ sessionId: 'sess-F', model: 'Opus 4.7-Alias', logger: silentLogger() });
    const out = await inherit.resolveInheritedModel({
        sessionId: 'sess-F',
        model: 'deepseek-chat',
        logger: silentLogger(),
    });
    assert.equal(out.action, 'use_inherited');
    assert.equal(out.parentAlias, 'Opus 4.7-Alias');
    assert.equal(out.resolution.model, 'claude-opus-4-7');
});

test('alias update after sub-agent spawn does NOT mutate the child snapshot', async () => {
    const inherit = injectMocks();
    await inherit.resolveInheritedModel({ sessionId: 'sess-G', model: 'Opus 4.7-Alias', logger: silentLogger() });
    const entryBefore = inherit.getSessionState('sess-G').aliases.get('Opus 4.7-Alias');
    assert.equal(entryBefore.model, 'claude-opus-4-7');
    const newResolver = {
        ...RESOLVER_FIXTURE,
        resolve: (input) => {
            if (input === 'Opus 4.7-Alias') return { alias: 'Opus 4.7-Alias', provider: 'anthropic', model: 'claude-opus-4-7-NEW' };
            return RESOLVER_FIXTURE.resolve(input);
        },
    };
    require.cache[RESOLVER_PATH] = {
        id: RESOLVER_PATH, filename: RESOLVER_PATH, loaded: true, exports: newResolver,
    };
    delete require.cache[INHERIT_PATH];
    const inherit2 = require(INHERIT_PATH);
    await inherit2.resolveInheritedModel({ sessionId: 'sess-G', model: 'Opus 4.7-Alias', logger: silentLogger() });
    const entryAfter = inherit2.getSessionState('sess-G').aliases.get('Opus 4.7-Alias');
    assert.equal(entryAfter.model, 'claude-opus-4-7-NEW');
    const snapshot = inherit2.snapshotForSubAgent({
        parentAlias: 'Opus 4.7-Alias',
        resolution: { provider: entryBefore.provider, model: entryBefore.model },
    });
    assert.equal(snapshot.model, 'claude-opus-4-7');
});

test('concurrent recordAliasResolution calls are serialised per session', async () => {
    require.cache[RESOLVER_PATH] = {
        id: RESOLVER_PATH, filename: RESOLVER_PATH, loaded: true, exports: RESOLVER_FIXTURE,
    };
    const inherit = injectMocks();
    const promises = [];
    for (let i = 0; i < 20; i += 1) {
        const alias = i % 2 === 0 ? 'Opus 4.7-Alias' : 'Sonnet 4.6-Alias';
        promises.push(inherit.recordAliasResolution({
            sessionId: 'sess-H',
            alias,
            resolution: RESOLVER_FIXTURE.resolve(alias),
            logger: silentLogger(),
        }));
    }
    const results = await Promise.all(promises);
    assert.equal(results.length, 20);
    for (const r of results) {
        assert.ok(r && r.alias && r.provider && r.model, 'bad result: ' + JSON.stringify(r));
    }
    const state = inherit.getSessionState('sess-H');
    assert.ok(state.aliases.has('Opus 4.7-Alias'));
    assert.ok(state.aliases.has('Sonnet 4.6-Alias'));
});

test('getParentAliasFromRequest extracts metadata and headers', () => {
    const inherit = injectMocks();
    const body = { metadata: { parentAlias: 'Opus 4.7-Alias' } };
    assert.equal(inherit.getParentAliasFromRequest(body, null), 'Opus 4.7-Alias');
    const body2 = { metadata: { parent_alias: 'Sonnet 4.6-Alias' } };
    assert.equal(inherit.getParentAliasFromRequest(body2, null), 'Sonnet 4.6-Alias');
    const headers = { 'x-parent-alias': 'Opus 4.7-Alias' };
    assert.equal(inherit.getParentAliasFromRequest({}, { headers }), 'Opus 4.7-Alias');
});

test('clearSession removes the alias map', async () => {
    const inherit = injectMocks();
    await inherit.resolveInheritedModel({ sessionId: 'sess-I', model: 'Opus 4.7-Alias', logger: silentLogger() });
    assert.equal(inherit.getSessionState('sess-I').aliases.size, 1);
    inherit.clearSession('sess-I');
    assert.equal(inherit.getSessionState('sess-I'), null);
});

test('sub-agent fallback: session_only mode resolves when session exists', async () => {
    const fallback = { enabled: true, mode: 'session_only', provider: 'minimax', model: 'MiniMax-M3' };
    const inherit = injectMocks(fallback);
    const out = await inherit.resolveInheritedModel({
        sessionId: 'sess-fallback-1',
        model: 'unknown-model-name',
        logger: silentLogger(),
    });
    assert.equal(out.action, 'use_alias');
    assert.equal(out.resolution.provider, 'minimax');
    assert.equal(out.resolution.model, 'MiniMax-M3');
});

test('sub-agent fallback: session_only mode rejects when session is missing', async () => {
    const fallback = { enabled: true, mode: 'session_only', provider: 'minimax', model: 'MiniMax-M3' };
    const inherit = injectMocks(fallback);
    const out = await inherit.resolveInheritedModel({
        sessionId: '',
        model: 'unknown-model-name',
        logger: silentLogger(),
    });
    assert.equal(out, null);
});

test('sub-agent fallback: marked_subagent_only mode resolves when marked', async () => {
    const fallback = { enabled: true, mode: 'marked_subagent_only', provider: 'minimax', model: 'MiniMax-M3' };
    const inherit = injectMocks(fallback);
    const out = await inherit.resolveInheritedModel({
        sessionId: 'sess-fallback-2',
        model: 'unknown-model-name',
        metadata: { subAgent: true },
        logger: silentLogger(),
    });
    assert.equal(out.action, 'use_alias');
    assert.equal(out.resolution.model, 'MiniMax-M3');
});

test('sub-agent fallback: marked_subagent_only mode rejects when not marked', async () => {
    const fallback = { enabled: true, mode: 'marked_subagent_only', provider: 'minimax', model: 'MiniMax-M3' };
    const inherit = injectMocks(fallback);
    const out = await inherit.resolveInheritedModel({
        sessionId: 'sess-fallback-3',
        model: 'unknown-model-name',
        logger: silentLogger(),
    });
    assert.equal(out.action, 'reject_first_non_alias');
});

test('sub-agent fallback: always mode always resolves', async () => {
    const fallback = { enabled: true, mode: 'always', provider: 'minimax', model: 'MiniMax-M3' };
    const inherit = injectMocks(fallback);
    const out = await inherit.resolveInheritedModel({
        sessionId: 'sess-fallback-4',
        model: 'unknown-model-name',
        logger: silentLogger(),
    });
    assert.equal(out.action, 'use_alias');
    assert.equal(out.resolution.model, 'MiniMax-M3');
});

test('sub-agent fallback: disabled fallback rejects', async () => {
    const fallback = { enabled: false, mode: 'always', provider: 'minimax', model: 'MiniMax-M3' };
    const inherit = injectMocks(fallback);
    const out = await inherit.resolveInheritedModel({
        sessionId: 'sess-fallback-5',
        model: 'unknown-model-name',
        logger: silentLogger(),
    });
    assert.equal(out.action, 'reject_first_non_alias');
});

