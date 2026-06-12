const { readAugustCoreMemory, writeAugustCoreMemory } = require('../tools/august-tools');
const { readVectorEntries, searchTextEntries } = require('./vector-db');
const { factCount, searchFacts } = require('./semantic-memory');
const { decorateMemoryQuality, scoreMemoryQuality } = require('./memory-quality');

const ALLOWED_STATUSES = new Set(['active', 'stale', 'archived']);

function clampConfidence(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0.75;
    return Math.max(0, Math.min(1, parsed));
}

function normalizeStatus(value) {
    return ALLOWED_STATUSES.has(value) ? value : 'active';
}

function scoreMemoryText(text) {
    const raw = String(text || '');
    let score = 0;
    if (/proxy|jarvis|august|brain|mcp|plugin|skill|cowork|blender|claude|desktop|minimax/i.test(raw)) score += 80;
    if (/current|active|blocked|fix|debug|working|today|recent|in_progress/i.test(raw)) score += 40;
    if (/prefer|must|should|always|never|workflow|review|safe|local/i.test(raw)) score += 30;
    if (/resolved|old|previous|past|earlier/i.test(raw)) score -= 12;
    return score;
}

function explainInjection(text, item) {
    if (item.pinned) return 'Pinned memory is kept ahead of normal scoring.';
    const score = scoreMemoryText(text);
    if (score >= 90) return 'High-priority active proxy, tool, memory, or workflow signal.';
    if (score >= 50) return 'Relevant project or current-work signal.';
    if (score >= 20) return 'Durable preference or background context.';
    return 'Lower priority; may be compacted out when the brain limit is tight.';
}

function itemText(type, value, key) {
    if (type === 'project') return `${value.name || key}: ${value.summary || ''} ${value.status || ''}`;
    if (type === 'integration') return `${key}: ${value.summary || ''} ${value.status || ''}`;
    if (type === 'event') return value.summary || '';
    if (type === 'checkpoint') return `${value.topic || 'Checkpoint'}: ${value.summary || ''}`;
    return '';
}

function decorateItem(type, key, value) {
    const text = itemText(type, value, key);
    const score = scoreMemoryText(text);
    return decorateMemoryQuality({
        type,
        key: String(key),
        title: type === 'integration' ? key : (value.name || value.topic || `${type} ${Number(key) + 1}`),
        summary: value.summary || text,
        status: normalizeStatus(value.lifecycleStatus || value.memoryStatus || (type === 'project' ? value.status : 'active')),
        projectStatus: type === 'project' ? (value.status || '') : '',
        pinned: value.pinned === true,
        confidence: clampConfidence(value.confidence === undefined ? 0.75 : value.confidence),
        source: value.source || '',
        updatedAt: value.updated_at || value.updatedAt || value.timestamp || '',
        metadata: value.metadata || {},
        injection: {
            score,
            reason: explainInjection(text, value)
        }
    });
}

function listMemoryItems(memory = readAugustCoreMemory()) {
    const items = [];
    (memory.active_projects || []).forEach((project, index) => items.push(decorateItem('project', index, project)));
    Object.entries(memory.integrations || {}).forEach(([name, integration]) => items.push(decorateItem('integration', name, integration || {})));
    (memory.recent_events || []).forEach((event, index) => items.push(decorateItem('event', index, event)));
    (memory.conversation_checkpoints || []).forEach((checkpoint, index) => items.push(decorateItem('checkpoint', index, checkpoint)));
    return items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.injection.score - a.injection.score);
}

function lifecyclePatch(updates = {}) {
    const patch = {};
    if (updates.pinned !== undefined) patch.pinned = updates.pinned === true;
    if (updates.confidence !== undefined) patch.confidence = clampConfidence(updates.confidence);
    if (updates.status !== undefined || updates.lifecycleStatus !== undefined) {
        patch.lifecycleStatus = normalizeStatus(updates.lifecycleStatus || updates.status);
    }
    patch.updated_at = new Date().toISOString();
    return patch;
}

function updateMemoryItem({ type, key, updates }) {
    const memory = readAugustCoreMemory();
    const patch = lifecyclePatch(updates);
    const targetKey = String(key);

    if (type === 'project') {
        const numericIndex = Number(targetKey);
        const index = Number.isInteger(numericIndex)
            ? numericIndex
            : (memory.active_projects || []).findIndex(item => String(item.name) === targetKey);
        if (index === -1 || !memory.active_projects?.[index]) throw new Error(`Project memory not found: ${targetKey}`);
        memory.active_projects[index] = { ...memory.active_projects[index], ...patch };
    } else if (type === 'integration') {
        if (!memory.integrations || !memory.integrations[targetKey]) throw new Error(`Integration memory not found: ${targetKey}`);
        memory.integrations[targetKey] = { ...memory.integrations[targetKey], ...patch };
    } else if (type === 'event') {
        const index = Number(targetKey);
        if (!Number.isInteger(index) || !memory.recent_events?.[index]) throw new Error(`Event memory not found: ${targetKey}`);
        memory.recent_events[index] = { ...memory.recent_events[index], ...patch };
    } else if (type === 'checkpoint') {
        const index = Number(targetKey);
        if (!Number.isInteger(index) || !memory.conversation_checkpoints?.[index]) throw new Error(`Checkpoint memory not found: ${targetKey}`);
        memory.conversation_checkpoints[index] = { ...memory.conversation_checkpoints[index], ...patch };
    } else {
        throw new Error(`Unsupported memory item type: ${type}`);
    }

    writeAugustCoreMemory(memory);
    return { item: listMemoryItems(memory).find(item => item.type === type && item.key === targetKey), items: listMemoryItems(memory) };
}

function searchMemory(query, { limit = 8 } = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { query, core: [], semantic: [], vector: [], vectorCount: readVectorEntries().length, semanticCount: factCount() };
    const terms = q.split(/\s+/).filter(Boolean);
    const core = listMemoryItems()
        .map(item => {
            const haystack = `${item.title} ${item.summary} ${item.source}`.toLowerCase();
            const matches = terms.filter(term => haystack.includes(term)).length;
            return { ...item, matches };
        })
        .filter(item => item.matches > 0)
        .sort((a, b) => b.matches - a.matches || b.injection.score - a.injection.score)
        .slice(0, limit);

    const semantic = searchFacts(query)
        .map(fact => ({
            key: fact.key,
            value: fact.value,
            category: fact.category,
            source: fact.source,
            updated: fact.updated,
            confidence: fact.confidence,
            provenance: fact.provenance,
            quality: fact.provenance ? scoreMemoryQuality(fact) : undefined
        }))
        .slice(0, limit);

    const vector = searchTextEntries(query, limit);
    return { query, core, semantic, vector, vectorCount: readVectorEntries().length, semanticCount: factCount() };
}

module.exports = {
    listMemoryItems,
    searchMemory,
    updateMemoryItem
};
