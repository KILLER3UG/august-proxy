const fs = require('fs');
const path = require('path');

const DEFAULT_GRAPH_FILE = path.join(__dirname, '..', '..', '..', 'data', 'august_graph_memory.json');
const MAX_ENTITIES = 1000;
const MAX_RELATIONS = 2500;
const MAX_OBSERVATIONS = 4000;

function getGraphMemoryFile() {
    return process.env.AUGUST_GRAPH_MEMORY_FILE || DEFAULT_GRAPH_FILE;
}

function nowIso() {
    return new Date().toISOString();
}

function compactText(value, max = 600) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeKey(value) {
    const key = compactText(value, 120)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return key || 'unknown';
}

function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of Array.isArray(values) ? values : []) {
        const text = compactText(value, 160);
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        result.push(text);
    }
    return result;
}

function defaultGraph() {
    return {
        version: 1,
        updatedAt: nowIso(),
        entities: [],
        relations: [],
        observations: []
    };
}

function normalizeGraph(raw) {
    const graph = raw && typeof raw === 'object' ? raw : defaultGraph();
    return {
        version: Number(graph.version || 1),
        updatedAt: graph.updatedAt || null,
        entities: Array.isArray(graph.entities) ? graph.entities : [],
        relations: Array.isArray(graph.relations) ? graph.relations : [],
        observations: Array.isArray(graph.observations) ? graph.observations : []
    };
}

function readGraphMemory() {
    const filePath = getGraphMemoryFile();
    if (!fs.existsSync(filePath)) return defaultGraph();
    try {
        return normalizeGraph(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch (_err) {
        return defaultGraph();
    }
}

function writeGraphMemory(graph) {
    const filePath = getGraphMemoryFile();
    const normalized = normalizeGraph(graph);
    normalized.updatedAt = nowIso();
    normalized.entities = normalized.entities.slice(-MAX_ENTITIES);
    normalized.relations = normalized.relations.slice(-MAX_RELATIONS);
    normalized.observations = normalized.observations.slice(-MAX_OBSERVATIONS);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2));
    return normalized;
}

function entityIdFor(type, name) {
    return `ent_${safeKey(type || 'concept')}_${safeKey(name)}`;
}

function relationIdFor(from, type, to) {
    return `rel_${safeKey(from)}_${safeKey(type || 'related_to')}_${safeKey(to)}`;
}

function observationIdFor(entityId, text, source) {
    return `obs_${safeKey(entityId)}_${safeKey(source || 'manual')}_${safeKey(text).slice(0, 80)}`;
}

function mergeSources(existingSources, source) {
    const sources = Array.isArray(existingSources) ? existingSources.slice() : [];
    const incoming = Array.isArray(source) ? source : [source || 'manual'];
    for (const item of incoming) {
        const sourceText = compactText(item, 120);
        if (!sourceText) continue;
        if (!sources.some(existing => String(existing || '').toLowerCase() === sourceText.toLowerCase())) {
            sources.push(sourceText);
        }
    }
    return sources.slice(-12);
}

function mergeConfidence(oldValue, nextValue) {
    const oldNum = Number(oldValue || 0);
    const nextNum = Number(nextValue || 0.7);
    return Math.max(oldNum || 0, nextNum || 0);
}

function upsertEntity(input = {}) {
    const graph = readGraphMemory();
    const name = compactText(input.name || input.id, 180);
    if (!name) throw new Error('entity name is required');
    const type = compactText(input.type || 'concept', 80);
    const id = input.id || entityIdFor(type, name);
    const now = nowIso();
    let entity = graph.entities.find(item => item.id === id);

    if (!entity) {
        entity = {
            id,
            type,
            name,
            aliases: [],
            confidence: Number(input.confidence || 0.7),
            sources: [],
            createdAt: now,
            updatedAt: now
        };
        graph.entities.push(entity);
    }

    entity.type = type || entity.type;
    entity.name = name || entity.name;
    entity.aliases = uniqueStrings([...(entity.aliases || []), ...(Array.isArray(input.aliases) ? input.aliases : [])]);
    entity.confidence = mergeConfidence(entity.confidence, input.confidence);
    entity.sources = mergeSources(entity.sources, input.source || input.sources);
    entity.updatedAt = now;
    writeGraphMemory(graph);
    return entity;
}

function findEntity(graph, ref) {
    if (!ref) return null;
    const text = compactText(ref, 180);
    const key = text.toLowerCase();
    return graph.entities.find(entity =>
        entity.id === text ||
        String(entity.name || '').toLowerCase() === key ||
        (entity.aliases || []).some(alias => String(alias || '').toLowerCase() === key)
    ) || null;
}

function resolveEntityRef(graph, ref, fallbackType = 'concept', source = 'manual') {
    if (ref && typeof ref === 'object') {
        const existing = findEntity(graph, ref.id || ref.name);
        if (existing) return existing;
        return upsertEntity({
            name: ref.name || ref.id,
            type: ref.type || fallbackType,
            aliases: ref.aliases,
            confidence: ref.confidence,
            source
        });
    }
    const existing = findEntity(graph, ref);
    if (existing) return existing;
    return upsertEntity({ name: ref, type: fallbackType, source });
}

function upsertRelation(input = {}) {
    const source = input.source || 'manual';
    const graph = readGraphMemory();
    const fromEntity = resolveEntityRef(graph, input.from || input.fromName || input.source_entity, input.fromType || 'concept', source);
    const toEntity = resolveEntityRef(graph, input.to || input.toName || input.target_entity, input.toType || 'concept', source);
    const relationType = compactText(input.type || input.relation || 'related_to', 80);
    if (!fromEntity?.id || !toEntity?.id) throw new Error('relation from and to are required');
    const id = input.id || relationIdFor(fromEntity.id, relationType, toEntity.id);
    const nextGraph = readGraphMemory();
    const now = nowIso();
    let relation = nextGraph.relations.find(item => item.id === id);

    if (!relation) {
        relation = {
            id,
            from: fromEntity.id,
            type: relationType,
            to: toEntity.id,
            confidence: Number(input.confidence || 0.7),
            sources: [],
            createdAt: now,
            updatedAt: now
        };
        nextGraph.relations.push(relation);
    }

    relation.from = fromEntity.id;
    relation.type = relationType;
    relation.to = toEntity.id;
    relation.confidence = mergeConfidence(relation.confidence, input.confidence);
    relation.sources = mergeSources(relation.sources, source);
    relation.updatedAt = now;
    writeGraphMemory(nextGraph);
    return relation;
}

function addObservation(input = {}) {
    const text = compactText(input.text || input.observation || input.value, 1200);
    if (!text) throw new Error('observation text is required');
    const source = input.source || 'manual';
    const graph = readGraphMemory();
    const entity = input.entityId
        ? findEntity(graph, input.entityId)
        : resolveEntityRef(graph, input.entity || input.name || input.key || 'August Brain', input.type || 'concept', source);
    if (!entity) throw new Error('entity not found for observation');

    const nextGraph = readGraphMemory();
    const id = input.id || observationIdFor(entity.id, text, source);
    const now = nowIso();
    let observation = nextGraph.observations.find(item => item.id === id);
    if (!observation) {
        observation = {
            id,
            entityId: entity.id,
            text,
            source: compactText(source, 120),
            confidence: Number(input.confidence || 0.7),
            createdAt: now,
            updatedAt: now
        };
        nextGraph.observations.push(observation);
    } else {
        observation.text = text;
        observation.confidence = mergeConfidence(observation.confidence, input.confidence);
        observation.updatedAt = now;
    }
    writeGraphMemory(nextGraph);
    return observation;
}

function entityLabelMap(graph) {
    return new Map(graph.entities.map(entity => [entity.id, entity.name || entity.id]));
}

function scoreText(text, query) {
    const value = String(text || '').toLowerCase();
    const q = String(query || '').toLowerCase().trim();
    if (!q) return 0;
    if (value === q) return 10;
    if (value.includes(q)) return 6;
    let score = 0;
    for (const part of q.split(/\s+/).filter(Boolean)) {
        if (value.includes(part)) score += 1;
    }
    return score;
}

function searchGraph(query, options = {}) {
    const graph = readGraphMemory();
    const limit = Math.max(1, Math.min(50, Number(options.limit || 10)));
    const q = compactText(query || '', 240);
    const labels = entityLabelMap(graph);
    const entityScores = graph.entities
        .map(entity => ({
            ...entity,
            score: scoreText(`${entity.name} ${entity.type} ${(entity.aliases || []).join(' ')}`, q)
        }))
        .filter(item => item.score > 0 || !q)
        .sort((a, b) => b.score - a.score || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
        .slice(0, limit);

    const relationScores = graph.relations
        .map(relation => ({
            ...relation,
            fromName: labels.get(relation.from) || relation.from,
            toName: labels.get(relation.to) || relation.to,
            score: scoreText(`${relation.type} ${labels.get(relation.from) || ''} ${labels.get(relation.to) || ''}`, q)
        }))
        .filter(item => item.score > 0 || !q)
        .sort((a, b) => b.score - a.score || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
        .slice(0, limit);

    const observationScores = graph.observations
        .map(observation => ({
            ...observation,
            entityName: labels.get(observation.entityId) || observation.entityId,
            score: scoreText(`${observation.text} ${labels.get(observation.entityId) || ''} ${observation.source || ''}`, q)
        }))
        .filter(item => item.score > 0 || !q)
        .sort((a, b) => b.score - a.score || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
        .slice(0, limit);

    return {
        query: q,
        counts: graphStats(graph).counts,
        entities: entityScores,
        relations: relationScores,
        observations: observationScores
    };
}

function extractEntitiesFromText(text, options = {}) {
    const value = String(text || '');
    const found = new Map();
    const max = Math.max(1, Math.min(50, Number(options.limit || 18)));
    const patterns = [
        { type: 'path', regex: /[A-Z]:\\[^\s"'<>|]+/g },
        { type: 'tool', regex: /\b(?:august|mcp|workbench|computer)__?[a-zA-Z0-9_-]+\b/g },
        { type: 'project', regex: /\b[A-Z][A-Za-z0-9_-]*(?:-[A-Za-z0-9_-]+)+\b/g },
        { type: 'concept', regex: /\b[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){1,4}\b/g }
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.regex.exec(value)) && found.size < max) {
            const name = compactText(match[0], 180);
            if (name.length < 3) continue;
            const key = `${pattern.type}:${name.toLowerCase()}`;
            if (!found.has(key)) found.set(key, { name, type: pattern.type, confidence: 0.45 });
        }
    }
    return Array.from(found.values());
}

function indexTextToGraph(text, options = {}) {
    const source = options.source || 'text';
    const rootName = options.rootName || 'August Brain';
    const rootType = options.rootType || 'memory';
    const root = upsertEntity({ name: rootName, type: rootType, source, confidence: 0.7 });
    const entities = extractEntitiesFromText(text, options);
    const relations = [];
    for (const entity of entities) {
        const saved = upsertEntity({ ...entity, source });
        relations.push(upsertRelation({
            from: root.id,
            type: 'mentions',
            to: saved.id,
            source,
            confidence: entity.confidence || 0.45
        }));
    }
    if (compactText(text, 1200)) {
        addObservation({ entityId: root.id, text: compactText(text, 1200), source, confidence: options.confidence || 0.5 });
    }
    return { root, entities, relations };
}

function indexCoreMemory() {
    const { readAugustCoreMemory } = require('./core-memory');
    const semanticMemory = require('./semantic-memory');
    const memory = readAugustCoreMemory();
    const graph = readGraphMemory();
    const results = {
        projects: 0,
        integrations: 0,
        events: 0,
        checkpoints: 0,
        semanticFacts: 0,
        extractedEntities: 0
    };

    const upsertEntityLocal = (input = {}) => {
        const name = compactText(input.name || input.id, 180);
        if (!name) return null;
        const type = compactText(input.type || 'concept', 80);
        const id = input.id || entityIdFor(type, name);
        const now = nowIso();
        let entity = graph.entities.find(item => item.id === id);
        if (!entity) {
            entity = {
                id,
                type,
                name,
                aliases: [],
                confidence: Number(input.confidence || 0.7),
                sources: [],
                createdAt: now,
                updatedAt: now
            };
            graph.entities.push(entity);
        }
        entity.type = type || entity.type;
        entity.name = name || entity.name;
        entity.aliases = uniqueStrings([...(entity.aliases || []), ...(Array.isArray(input.aliases) ? input.aliases : [])]);
        entity.confidence = mergeConfidence(entity.confidence, input.confidence);
        entity.sources = mergeSources(entity.sources, input.source || input.sources);
        entity.updatedAt = now;
        return entity;
    };

    const findEntityLocal = ref => findEntity(graph, ref);
    const resolveEntityLocal = (ref, fallbackType = 'concept', source = 'core-memory') => {
        if (ref && typeof ref === 'object') {
            return findEntityLocal(ref.id || ref.name) || upsertEntityLocal({
                name: ref.name || ref.id,
                type: ref.type || fallbackType,
                aliases: ref.aliases,
                confidence: ref.confidence,
                source
            });
        }
        return findEntityLocal(ref) || upsertEntityLocal({ name: ref, type: fallbackType, source });
    };

    const upsertRelationLocal = (input = {}) => {
        const source = input.source || 'core-memory';
        const fromEntity = resolveEntityLocal(input.from || input.fromName, input.fromType || 'concept', source);
        const toEntity = resolveEntityLocal(input.to || input.toName, input.toType || 'concept', source);
        if (!fromEntity || !toEntity) return null;
        const relationType = compactText(input.type || input.relation || 'related_to', 80);
        const id = input.id || relationIdFor(fromEntity.id, relationType, toEntity.id);
        const now = nowIso();
        let relation = graph.relations.find(item => item.id === id);
        if (!relation) {
            relation = {
                id,
                from: fromEntity.id,
                type: relationType,
                to: toEntity.id,
                confidence: Number(input.confidence || 0.7),
                sources: [],
                createdAt: now,
                updatedAt: now
            };
            graph.relations.push(relation);
        }
        relation.from = fromEntity.id;
        relation.type = relationType;
        relation.to = toEntity.id;
        relation.confidence = mergeConfidence(relation.confidence, input.confidence);
        relation.sources = mergeSources(relation.sources, source);
        relation.updatedAt = now;
        return relation;
    };

    const addObservationLocal = (input = {}) => {
        const text = compactText(input.text || input.observation || input.value, 1200);
        if (!text) return null;
        const source = input.source || 'core-memory';
        const entity = input.entityId ? findEntityLocal(input.entityId) : resolveEntityLocal(input.entity || input.name || 'August Brain', input.type || 'concept', source);
        if (!entity) return null;
        const id = input.id || observationIdFor(entity.id, text, source);
        const now = nowIso();
        let observation = graph.observations.find(item => item.id === id);
        if (!observation) {
            observation = {
                id,
                entityId: entity.id,
                text,
                source: compactText(source, 120),
                confidence: Number(input.confidence || 0.7),
                createdAt: now,
                updatedAt: now
            };
            graph.observations.push(observation);
        } else {
            observation.text = text;
            observation.confidence = mergeConfidence(observation.confidence, input.confidence);
            observation.updatedAt = now;
        }
        return observation;
    };

    const indexTextLocal = (text, options = {}) => {
        const source = options.source || 'text';
        const root = upsertEntityLocal({
            name: options.rootName || 'August Brain',
            type: options.rootType || 'memory',
            source,
            confidence: 0.7
        });
        const entities = extractEntitiesFromText(text, options);
        for (const entity of entities) {
            const saved = upsertEntityLocal({ ...entity, source });
            if (root && saved) {
                upsertRelationLocal({ from: root.id, type: 'mentions', to: saved.id, source, confidence: entity.confidence || 0.45 });
            }
        }
        if (root && compactText(text, 1200)) {
            addObservationLocal({ entityId: root.id, text: compactText(text, 1200), source, confidence: options.confidence || 0.5 });
        }
        return entities;
    };

    const brain = upsertEntityLocal({ name: 'August Brain', type: 'memory', source: 'core-memory', confidence: 0.9 });
    results.extractedEntities += indexTextLocal([memory.user_profile, memory.global_context].filter(Boolean).join('\n'), {
        source: 'core-memory:text',
        rootName: 'August Brain',
        rootType: 'memory',
        limit: 30
    }).length;

    for (const project of Array.isArray(memory.active_projects) ? memory.active_projects : []) {
        if (!project?.name) continue;
        const entity = upsertEntityLocal({ name: project.name, type: 'project', source: 'core-memory:active_projects', confidence: 0.85 });
        upsertRelationLocal({ from: brain.id, type: 'tracks_project', to: entity.id, source: 'core-memory:active_projects', confidence: 0.85 });
        if (project.summary || project.status) {
            addObservationLocal({ entityId: entity.id, text: `${project.status || 'status unknown'}: ${project.summary || ''}`, source: 'core-memory:active_projects', confidence: 0.8 });
            results.extractedEntities += extractEntitiesFromText(project.summary || '').length;
        }
        results.projects++;
    }

    for (const [name, integration] of Object.entries(memory.integrations || {})) {
        const entity = upsertEntityLocal({ name, type: 'integration', source: 'core-memory:integrations', confidence: 0.85 });
        upsertRelationLocal({ from: brain.id, type: 'uses_integration', to: entity.id, source: 'core-memory:integrations', confidence: 0.8 });
        if (integration?.summary || integration?.status) {
            addObservationLocal({ entityId: entity.id, text: `${integration.status || 'status unknown'}: ${integration.summary || ''}`, source: 'core-memory:integrations', confidence: 0.78 });
            results.extractedEntities += extractEntitiesFromText(integration.summary || '').length;
        }
        results.integrations++;
    }

    for (const event of Array.isArray(memory.recent_events) ? memory.recent_events : []) {
        const text = event?.summary || '';
        if (!text) continue;
        addObservationLocal({ entityId: brain.id, text, source: event.source || 'core-memory:recent_events', confidence: 0.65 });
        results.extractedEntities += indexTextLocal(text, { source: 'core-memory:recent_events', rootName: 'August Brain', rootType: 'memory', limit: 8 }).length;
        results.events++;
    }

    for (const checkpoint of Array.isArray(memory.conversation_checkpoints) ? memory.conversation_checkpoints : []) {
        if (!checkpoint?.summary) continue;
        const topic = checkpoint.topic || 'Conversation Checkpoint';
        const entity = upsertEntityLocal({ name: topic, type: 'checkpoint_topic', source: 'core-memory:checkpoints', confidence: 0.65 });
        upsertRelationLocal({ from: brain.id, type: 'has_checkpoint', to: entity.id, source: 'core-memory:checkpoints', confidence: 0.65 });
        addObservationLocal({ entityId: entity.id, text: checkpoint.summary, source: 'core-memory:checkpoints', confidence: 0.65 });
        results.extractedEntities += indexTextLocal(checkpoint.summary, { source: 'core-memory:checkpoints', rootName: topic, rootType: 'checkpoint_topic', limit: 8 }).length;
        results.checkpoints++;
    }

    for (const fact of semanticMemory.getAllFacts()) {
        if (!fact?.key || !fact?.value) continue;
        const entity = upsertEntityLocal({ name: fact.key, type: fact.category || 'semantic_fact', source: fact.source || 'semantic-memory', confidence: 0.8 });
        upsertRelationLocal({ from: brain.id, type: 'has_fact', to: entity.id, source: 'semantic-memory', confidence: 0.78 });
        addObservationLocal({ entityId: entity.id, text: fact.value, source: fact.source || 'semantic-memory', confidence: 0.78 });
        results.extractedEntities += extractEntitiesFromText(fact.value).length;
        results.semanticFacts++;
    }

    const savedGraph = writeGraphMemory(graph);
    return {
        status: 'indexed',
        generatedAt: nowIso(),
        results,
        graph: graphStats(savedGraph)
    };
}

function graphStats(graph = readGraphMemory()) {
    const normalized = normalizeGraph(graph);
    const byType = {};
    for (const entity of normalized.entities) {
        const type = entity.type || 'concept';
        byType[type] = (byType[type] || 0) + 1;
    }
    return {
        file: getGraphMemoryFile(),
        updatedAt: normalized.updatedAt || null,
        counts: {
            entities: normalized.entities.length,
            relations: normalized.relations.length,
            observations: normalized.observations.length
        },
        entityTypes: byType
    };
}

function formatGraphSearch(query, limit = 8) {
    const result = searchGraph(query, { limit });
    const lines = [`[August Graph Memory] query="${result.query || '*'}"`];
    if (result.entities.length) {
        lines.push('\nEntities:');
        for (const entity of result.entities) {
            lines.push(`- ${entity.name} [${entity.type}] confidence=${entity.confidence ?? 'n/a'}`);
        }
    }
    if (result.relations.length) {
        lines.push('\nRelations:');
        for (const relation of result.relations) {
            lines.push(`- ${relation.fromName} --${relation.type}--> ${relation.toName}`);
        }
    }
    if (result.observations.length) {
        lines.push('\nObservations:');
        for (const observation of result.observations) {
            lines.push(`- ${observation.entityName}: ${observation.text}`);
        }
    }
    if (lines.length === 1) lines.push('No graph matches found.');
    return lines.join('\n');
}

module.exports = {
    DEFAULT_GRAPH_FILE,
    addObservation,
    entityIdFor,
    extractEntitiesFromText,
    findEntity,
    formatGraphSearch,
    getGraphMemoryFile,
    graphStats,
    indexCoreMemory,
    indexTextToGraph,
    readGraphMemory,
    relationIdFor,
    searchGraph,
    upsertEntity,
    upsertRelation,
    writeGraphMemory
};
