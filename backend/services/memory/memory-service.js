const coreMemory = require('./core-memory');
const semanticMemory = require('./semantic-memory');
const vectorDb = require('./vector-db');
const sqliteStore = require('./sqlite-memory-store');
const graphMemory = require('./graph-memory');
const guidelines = require('./learned-guidelines');
const { listMemoryProviders } = require('./memory-providers');
const { listMemoryItems, searchMemory } = require('./memory-lifecycle');

const DEFAULT_LIMITS = {
    coreItems: 24,
    semanticFacts: 40,
    sqliteFacts: 40,
    memories: 30,
    vectorEntries: 30,
    guidelines: 40,
    modelObservations: 20
};

function compact(value, limit = 420) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function safeSlice(items, limit) {
    const list = Array.isArray(items) ? items : [];
    return list.slice(0, Math.max(0, Math.min(500, Number(limit) || DEFAULT_LIMITS.semanticFacts)));
}

function getLimits(options = {}) {
    return {
        coreItems: Number(options.coreItems || DEFAULT_LIMITS.coreItems),
        semanticFacts: Number(options.semanticFacts || DEFAULT_LIMITS.semanticFacts),
        sqliteFacts: Number(options.sqliteFacts || DEFAULT_LIMITS.sqliteFacts),
        memories: Number(options.memories || DEFAULT_LIMITS.memories),
        vectorEntries: Number(options.vectorEntries || DEFAULT_LIMITS.vectorEntries),
        guidelines: Number(options.guidelines || DEFAULT_LIMITS.guidelines),
        modelObservations: Number(options.modelObservations || DEFAULT_LIMITS.modelObservations)
    };
}

function buildCounts(snapshot) {
    return {
        coreItems: Array.isArray(snapshot.core?.items) ? snapshot.core.items.length : 0,
        semanticFacts: Array.isArray(snapshot.semantic?.facts) ? snapshot.semantic.facts.length : 0,
        sqliteFacts: Array.isArray(snapshot.sqlite?.facts) ? snapshot.sqlite.facts.length : 0,
        sqliteMemories: Array.isArray(snapshot.sqlite?.memories) ? snapshot.sqlite.memories.length : 0,
        vectorEntries: Array.isArray(snapshot.vector?.entries) ? snapshot.vector.entries.length : 0,
        graphEntities: snapshot.graph?.stats?.entities || 0,
        graphRelations: snapshot.graph?.stats?.relations || 0,
        graphObservations: snapshot.graph?.stats?.observations || 0,
        learnedGuidelines: Array.isArray(snapshot.guidelines?.items) ? snapshot.guidelines.items.length : 0,
        modelObservations: Array.isArray(snapshot.modelObservations?.items) ? snapshot.modelObservations.items.length : 0
    };
}

function buildMemorySnapshot(options = {}) {
    const limits = getLimits(options);
    const core = coreMemory.readAugustCoreMemory();
    const renderedCore = coreMemory.renderAugustCoreMemory(core);
    const sqliteStatus = sqliteStore.getMemoryStoreStatus();
    const snapshot = {
        generatedAt: new Date().toISOString(),
        core: {
            file: coreMemory.getCoreMemoryFile(),
            rendered: renderedCore,
            raw: options.includeRaw ? core : undefined,
            items: safeSlice(listMemoryItems(core), limits.coreItems)
        },
        semantic: {
            file: semanticMemory.getSemanticMemoryFile(),
            facts: safeSlice(semanticMemory.getAllFacts(), limits.semanticFacts)
        },
        sqlite: {
            file: sqliteStore.SQLITE_MEMORY_FILE,
            status: sqliteStatus,
            facts: safeSlice(sqliteStore.listMemoryFacts({ limit: limits.sqliteFacts }), limits.sqliteFacts),
            memories: safeSlice(sqliteStore.listSqliteMemories({ limit: limits.memories }), limits.memories),
            schema: sqliteStore.listSchemaMeta()
        },
        vector: {
            file: vectorDb.getVectorFile ? vectorDb.getVectorFile() : '',
            entries: safeSlice(vectorDb.readVectorEntries(), limits.vectorEntries)
        },
        graph: {
            file: graphMemory.getGraphMemoryFile(),
            stats: graphMemory.graphStats(),
            search: options.query ? graphMemory.searchGraph(options.query, { limit: 10 }) : []
        },
        guidelines: {
            file: guidelines.getGuidelinesFile(),
            items: safeSlice(guidelines.listLearnedGuidelines({ status: 'all' }), limits.guidelines)
        },
        modelObservations: {
            items: safeSlice(sqliteStore.listModelObservations({ limit: limits.modelObservations }), limits.modelObservations)
        },
        providers: listMemoryProviders(),
        counts: {}
    };
    snapshot.counts = buildCounts(snapshot);
    return snapshot;
}

function normalizeSearchResult(provider, type, title, text, extra = {}) {
    return {
        provider,
        type,
        title: compact(title, 160),
        text: compact(text, 600),
        ...extra
    };
}

function searchBrain(query, options = {}) {
    const q = String(query || '').trim();
    const lifecycle = searchMemory(q, { limit: options.limit || 8 });
    const sqliteFacts = sqliteStore.searchMemoryFacts(q, { limit: options.limit || 8 });
    const sqliteMemories = sqliteStore.searchMemoryFts(q, { limit: options.limit || 8 });
    const graph = q ? graphMemory.searchGraph(q, { limit: options.limit || 8 }) : [];
    const results = [
        ...(lifecycle.core || []).map(item => normalizeSearchResult(
            'core',
            item.type,
            item.title,
            item.summary,
            { key: item.key, score: item.injection?.score || 0, quality: item.quality }
        )),
        ...(lifecycle.semantic || []).map(item => normalizeSearchResult(
            'semantic',
            item.category,
            item.key,
            item.value,
            { key: item.key, score: item.confidence || 0, quality: item.quality }
        )),
        ...(lifecycle.vector || []).map(item => normalizeSearchResult(
            'vector',
            item.type || 'episode',
            item.topic || item.title,
            item.summary || item.text,
            { id: item.id, score: item.score || 0 }
        )),
        ...sqliteFacts.map(item => normalizeSearchResult(
            'sqlite-fact',
            item.category,
            item.key,
            item.value,
            { id: item.id, key: item.key, score: item.confidence || 0 }
        )),
        ...sqliteMemories.map(item => normalizeSearchResult(
            'sqlite-memory',
            item.metadata?.type || 'fts',
            item.topic,
            item.summary,
            { id: item.id, score: item.ftsRank ? 1 / item.ftsRank : 0 }
        )),
        ...graph.map(item => normalizeSearchResult(
            'graph',
            item.type || 'entity',
            item.title || item.name || item.id,
            item.text || item.summary || item.description || '',
            { id: item.id, score: item.score || 0 }
        ))
    ].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

    return {
        query: q,
        generatedAt: new Date().toISOString(),
        results,
        counts: {
            core: lifecycle.core?.length || 0,
            semantic: lifecycle.semantic?.length || 0,
            vector: lifecycle.vector?.length || 0,
            sqliteFacts: sqliteFacts.length,
            sqliteMemories: sqliteMemories.length,
            graph
        }
    };
}

function buildModelMemoryPack(options = {}) {
    const snapshot = buildMemorySnapshot({
        ...options,
        coreItems: options.coreItems || 12,
        semanticFacts: options.semanticFacts || 24,
        sqliteFacts: options.sqliteFacts || 24,
        memories: options.memories || 18,
        vectorEntries: options.vectorEntries || 18,
        guidelines: options.guidelines || 24,
        modelObservations: options.modelObservations || 12
    });
    const modelId = options.modelId || options.model_id || '';
    const provider = options.provider || '';
    if (modelId) {
        sqliteStore.recordMemoryUsage({
            memoryType: 'model-pack',
            targetId: modelId,
            metadata: { provider, query: options.query || '' }
        });
    }
    return {
        generatedAt: snapshot.generatedAt,
        model: {
            id: modelId,
            provider,
            scanInstructions: [
                'Use this pack as context only. Do not echo it back unless the user asks.',
                'Prefer durable active facts over stale or archived items.',
                'If you infer a memory edit, propose it with august__brain_edit instead of mutating files directly.'
            ]
        },
        core: snapshot.core.rendered,
        activeProjects: snapshot.core.items.filter(item => item.type === 'project'),
        integrations: snapshot.core.items.filter(item => item.type === 'integration'),
        semanticFacts: snapshot.semantic.facts.map(fact => ({
            key: fact.key,
            value: fact.value,
            category: fact.category,
            source: fact.source,
            confidence: fact.confidence,
            updatedAt: fact.updated
        })),
        sqliteFacts: snapshot.sqlite.facts.map(fact => ({
            id: fact.id,
            key: fact.key,
            value: fact.value,
            category: fact.category,
            lifecycleStatus: fact.lifecycleStatus,
            confidence: fact.confidence,
            updatedAt: fact.updatedAt
        })),
        recentEpisodes: snapshot.sqlite.memories.slice(0, 10).map(item => ({
            id: item.id,
            topic: item.topic,
            summary: item.summary,
            timestamp: item.timestamp,
            lifecycleStatus: item.lifecycleStatus,
            trust: item.trust
        })),
        vectorEpisodes: snapshot.vector.entries.slice(0, 10).map(item => ({
            id: item.id,
            topic: item.topic,
            summary: item.summary,
            timestamp: item.timestamp,
            type: item.metadata?.type || 'episode'
        })),
        learnedGuidelines: snapshot.guidelines.items
            .filter(item => item.status !== 'rejected' && item.status !== 'archived')
            .map(item => item.text),
        graphSummary: snapshot.graph.stats,
        lastModelObservations: snapshot.modelObservations.items
            .filter(item => !modelId || item.modelId === modelId)
            .slice(0, 6)
            .map(item => item.summary),
        counts: snapshot.counts
    };
}

function exportReadableSnapshot(options = {}) {
    const snapshot = buildMemorySnapshot({ ...options, includeRaw: true });
    return {
        format: 'august-brain-snapshot-v1',
        generatedAt: snapshot.generatedAt,
        schema: {
            durable: 'SQLite tables: memories, memory_facts, memory_proposals, memory_retention_decisions, model_observations, memory_usage, schema_meta',
            readableJson: 'core, semantic, guidelines, graph, vector snapshots are JSON mirrors for inspection and model packs'
        },
        snapshot
    };
}

module.exports = {
    buildCounts,
    buildMemorySnapshot,
    buildModelMemoryPack,
    DEFAULT_LIMITS,
    exportReadableSnapshot,
    searchBrain
};
