const { readAugustCoreMemory, renderAugustCoreMemory } = require('./core-memory');
const semanticMemory = require('./semantic-memory');
const vectorDb = require('./vector-db');
const sqliteStore = require('./sqlite-memory-store');

const MAX_PROVIDER_RESULTS = 5;

function compact(value, limit = 220) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function providerEvent(providerId, hook, payload) {
    try {
        sqliteStore.recordProviderEvent(providerId, hook, payload);
    } catch (e) {
        // Provider events are audit accelerators; they must never break requests.
    }
}

const providers = [
    {
        id: 'core',
        label: 'August Core Memory',
        type: 'structured',
        enabled: true,
        systemPromptBlock() {
            const rendered = renderAugustCoreMemory(readAugustCoreMemory());
            return [
                'Core memory provider:',
                `User profile: ${compact(rendered.user_profile, 500)}`,
                `Global context: ${compact(rendered.global_context, 800)}`
            ].join('\n');
        },
        prefetch(query) {
            const q = String(query || '').toLowerCase();
            const memory = readAugustCoreMemory();
            const items = [
                ...(memory.active_projects || []).map(item => ({ type: 'project', title: item.name, text: item.summary })),
                ...Object.entries(memory.integrations || {}).map(([name, item]) => ({ type: 'integration', title: name, text: item.summary || item.status })),
                ...(memory.recent_events || []).map(item => ({ type: 'event', title: item.source || 'event', text: item.summary })),
                ...(memory.conversation_checkpoints || []).map(item => ({ type: 'checkpoint', title: item.topic || 'checkpoint', text: item.summary }))
            ];
            const terms = q.split(/\s+/).filter(Boolean);
            return items
                .map(item => ({
                    provider: 'core',
                    ...item,
                    score: terms.filter(term => `${item.title} ${item.text}`.toLowerCase().includes(term)).length
                }))
                .filter(item => item.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, MAX_PROVIDER_RESULTS);
        },
        syncTurn(payload) {
            providerEvent('core', 'sync_turn', payload);
            return { synced: true };
        },
        onPreCompress(payload) {
            providerEvent('core', 'pre_compress', payload);
            return { captured: true };
        }
    },
    {
        id: 'semantic',
        label: 'Semantic Fact Memory',
        type: 'facts',
        enabled: true,
        systemPromptBlock() {
            const facts = semanticMemory.getAllFacts().slice(0, 12);
            if (facts.length === 0) return 'Semantic memory provider: no active facts.';
            return [
                'Semantic memory provider:',
                ...facts.map(fact => `- [${fact.category}] ${fact.key}: ${fact.value}`)
            ].join('\n');
        },
        prefetch(query) {
            return semanticMemory.searchFacts(query)
                .slice(0, MAX_PROVIDER_RESULTS)
                .map(fact => ({
                    provider: 'semantic',
                    type: fact.category,
                    title: fact.key,
                    text: fact.value,
                    source: fact.source,
                    updated: fact.updated,
                    score: 1
                }));
        },
        syncTurn(payload) {
            providerEvent('semantic', 'sync_turn', payload);
            return { synced: true };
        },
        onMemoryWrite(payload) {
            providerEvent('semantic', 'memory_write', payload);
            return { captured: true };
        }
    },
    {
        id: 'vector',
        label: 'Hybrid Vector + BM25 Memory',
        type: 'episodic',
        enabled: true,
        systemPromptBlock() {
            const count = vectorDb.readVectorEntries().length;
            return `Vector memory provider: ${count} indexed episodic checkpoints. Retrieval uses local vectors, BM25, SQLite FTS when available, and RRF fusion.`;
        },
        prefetch(query, filters) {
            return vectorDb.searchCheckpointsByText(query, MAX_PROVIDER_RESULTS, { filters })
                .map(item => ({
                    provider: 'vector',
                    type: item.metadata?.type || 'episode',
                    title: item.topic,
                    text: item.summary,
                    timestamp: item.timestamp,
                    score: item.score,
                    retrieval: item.retrieval
                }));
        },
        syncTurn(payload) {
            providerEvent('vector', 'sync_turn', payload);
            return { synced: true };
        },
        onPreCompress(payload) {
            if (!payload || !payload.summary) return { captured: false };
            vectorDb.saveCheckpointWithEmbedding(payload.topic || 'Context compression', payload.summary, null, {
                type: 'episode',
                source: 'memory-provider',
                session_id: payload.session_id || payload.sessionId,
                tags: ['compression']
            });
            return { captured: true };
        }
    },
    {
        id: 'sqlite',
        label: 'SQLite FTS Store',
        type: 'index',
        enabled: true,
        systemPromptBlock() {
            const status = sqliteStore.getMemoryStoreStatus();
            return `SQLite memory provider: ${status.available ? 'available' : 'fallback'} (${status.driver}), ${status.count} mirrored rows.`;
        },
        prefetch(query) {
            return sqliteStore.searchMemoryFts(query, { limit: MAX_PROVIDER_RESULTS })
                .map(item => ({
                    provider: 'sqlite',
                    type: item.metadata?.type || 'fts',
                    title: item.topic,
                    text: item.summary,
                    timestamp: item.timestamp,
                    score: item.ftsRank ? 1 / item.ftsRank : 0,
                    retrieval: { method: 'sqlite-fts5', rank: item.ftsRank }
                }));
        },
        syncTurn(payload) {
            providerEvent('sqlite', 'sync_turn', payload);
            return sqliteStore.syncVectorEntries(vectorDb.readVectorEntries());
        }
    }
];

function listMemoryProviders() {
    const sqlite = sqliteStore.getMemoryStoreStatus();
    return providers.map(provider => ({
        id: provider.id,
        label: provider.label,
        type: provider.type,
        enabled: provider.enabled,
        hooks: Object.keys(provider).filter(key => typeof provider[key] === 'function'),
        status: provider.id === 'sqlite' ? sqlite : undefined
    }));
}

function prefetchAll(query, filters = {}) {
    const results = [];
    for (const provider of providers.filter(item => item.enabled && typeof item.prefetch === 'function')) {
        try {
            results.push(...provider.prefetch(query, filters));
        } catch (e) {
            results.push({ provider: provider.id, type: 'error', title: provider.label, text: e.message, score: 0 });
        }
    }
    return results
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, 12);
}

function buildMemoryProviderContext(query = '') {
    const status = providers.map(provider => provider.systemPromptBlock()).join('\n\n');
    const recalled = query ? prefetchAll(query) : [];
    if (recalled.length === 0) return status;
    return [
        status,
        '',
        '<memory-context>',
        ...recalled.map(item => `- [${item.provider}/${item.type}] ${item.title}: ${compact(item.text, 400)}`),
        '</memory-context>'
    ].join('\n');
}

function syncTurnMemory(payload = {}) {
    return providers
        .filter(provider => provider.enabled && typeof provider.syncTurn === 'function')
        .map(provider => ({ provider: provider.id, result: provider.syncTurn(payload) }));
}

function onPreCompress(payload = {}) {
    return providers
        .filter(provider => provider.enabled && typeof provider.onPreCompress === 'function')
        .map(provider => ({ provider: provider.id, result: provider.onPreCompress(payload) }));
}

module.exports = {
    buildMemoryProviderContext,
    listMemoryProviders,
    onPreCompress,
    prefetchAll,
    syncTurnMemory
};
