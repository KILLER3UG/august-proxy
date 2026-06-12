const coreMemory = require('./core-memory');
const semanticMemory = require('./semantic-memory');
const guidelines = require('./learned-guidelines');
const vectorDb = require('./vector-db');
const sqliteStore = require('./sqlite-memory-store');
const memoryGovernance = require('./memory-governance');
const { listMemoryItems } = require('./memory-lifecycle');

function compact(value, limit = 500) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeText(value) {
    return compact(value).toLowerCase();
}

function daysOld(iso) {
    if (!iso) return 999999;
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return 999999;
    return Math.max(0, Math.round((Date.now() - time) / 86400000));
}

function queryHitScore(text, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return 0;
    const terms = q.split(/\s+/).filter(Boolean);
    const haystack = String(text || '').toLowerCase();
    return terms.filter(term => haystack.includes(term)).length;
}

function scoreItem(item, query = '') {
    const reasons = [];
    let score = 50;
    const text = `${item.title || item.key || item.topic || item.name || ''} ${item.summary || item.value || item.text || ''}`;
    const age = daysOld(item.updatedAt || item.updated || item.timestamp || item.createdAt || item.lastSeenAt || item.updated_at);

    if (item.pinned || item.metadata?.pinned || item.lifecycleStatus === 'pinned') {
        score += 20;
        reasons.push('pinned or explicitly kept');
    }
    if (item.lifecycleStatus === 'archived' || item.status === 'archived') {
        score -= 25;
        reasons.push('already archived');
    }
    if (item.lifecycleStatus === 'stale' || item.status === 'stale') {
        score -= 18;
        reasons.push('marked stale');
    }

    const confidence = Number(item.confidence ?? item.trust ?? item.quality?.confidence ?? 0.75);
    if (Number.isFinite(confidence)) score += Math.round((confidence - 0.5) * 30);

    if (age <= 30) {
        score += 12;
        reasons.push('recent');
    } else if (age <= 180) {
        score += 5;
        reasons.push('moderately recent');
    } else if (age > 365) {
        score -= 18;
        reasons.push('older than one year');
    }

    const hitCount = queryHitScore(text, query);
    if (query && hitCount > 0) {
        score += Math.min(18, hitCount * 6);
        reasons.push(`matches query (${hitCount})`);
    }

    if (item.ttl && new Date(item.ttl) < new Date()) {
        score -= 70;
        reasons.push('ttl expired');
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    let recommendation = 'review';
    if (score < 35) recommendation = 'remove';
    else if (score >= 70) recommendation = 'keep';

    return { score, recommendation, reasons };
}

function candidateId(memoryType, item) {
    return item.id || item.key || item.targetId || item.name || item.topic || `${memoryType}:${JSON.stringify(item)}`;
}

function collectCandidates(query, limit) {
    const candidates = [];
    const core = coreMemory.readAugustCoreMemory();
    for (const item of listMemoryItems(core)) {
        candidates.push({
            id: candidateId('core', item),
            memoryType: 'core',
            type: item.type,
            key: item.key,
            title: item.title,
            summary: item.summary,
            pinned: item.pinned,
            status: item.status,
            lifecycleStatus: item.lifecycleStatus,
            confidence: item.confidence,
            updatedAt: item.updatedAt,
            createdAt: item.createdAt
        });
    }
    for (const fact of semanticMemory.getAllFacts()) {
        candidates.push({
            id: fact.key,
            memoryType: 'semantic',
            type: fact.category,
            key: fact.key,
            title: fact.key,
            summary: fact.value,
            pinned: fact.provenance?.pinned,
            status: 'active',
            lifecycleStatus: fact.lifecycleStatus || 'active',
            confidence: fact.confidence,
            updatedAt: fact.updated,
            createdAt: fact.created,
            ttl: fact.ttl
        });
    }
    for (const fact of sqliteStore.listMemoryFacts({ limit: 100 })) {
        candidates.push({
            id: fact.id,
            memoryType: 'sqlite-fact',
            type: fact.category,
            key: fact.key,
            title: fact.key,
            summary: fact.value,
            pinned: fact.metadata?.pinned,
            status: fact.lifecycleStatus,
            lifecycleStatus: fact.lifecycleStatus,
            confidence: fact.confidence,
            updatedAt: fact.updatedAt,
            createdAt: fact.createdAt,
            ttl: fact.ttl
        });
    }
    for (const memory of sqliteStore.listSqliteMemories({ limit: 100 })) {
        candidates.push({
            id: memory.id,
            memoryType: 'sqlite',
            type: memory.metadata?.type || 'memory',
            key: memory.id,
            title: memory.topic,
            summary: memory.summary,
            pinned: memory.metadata?.pinned,
            status: memory.lifecycleStatus,
            lifecycleStatus: memory.lifecycleStatus,
            confidence: memory.trust,
            updatedAt: memory.updatedAt || memory.timestamp,
            createdAt: memory.timestamp
        });
    }
    for (const entry of vectorDb.readVectorEntries().slice(0, 100)) {
        candidates.push({
            id: entry.id,
            memoryType: 'vector',
            type: entry.metadata?.type || 'episode',
            key: entry.id,
            title: entry.topic,
            summary: entry.summary,
            pinned: entry.metadata?.pinned,
            status: entry.metadata?.lifecycleStatus || 'active',
            lifecycleStatus: entry.metadata?.lifecycleStatus || 'active',
            confidence: entry.metadata?.confidence || 0.75,
            updatedAt: entry.timestamp || entry.updatedAt,
            createdAt: entry.timestamp
        });
    }
    for (const guideline of guidelines.listLearnedGuidelines({ status: 'all' })) {
        candidates.push({
            id: guideline.id,
            memoryType: 'guideline',
            type: 'guideline',
            key: guideline.id,
            title: guideline.text,
            summary: guideline.text,
            status: guideline.status,
            lifecycleStatus: guideline.status,
            confidence: guideline.confidence,
            updatedAt: guideline.updatedAt || guideline.lastSeenAt,
            createdAt: guideline.createdAt
        });
    }

    const seen = new Set();
    const unique = candidates.filter(item => {
        const key = `${item.memoryType}:${item.key || item.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return unique.slice(0, Math.max(1, Math.min(500, Number(limit) || 80)));
}

function detectDuplicates(candidates) {
    const buckets = new Map();
    for (const item of candidates) {
        const key = normalizeText(`${item.title} ${item.summary}`);
        if (key.length < 20) continue;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(item);
    }
    const duplicateKeys = new Set([...buckets.values()].filter(group => group.length > 1).flat().map(item => `${item.memoryType}:${item.key || item.id}`));
    return duplicateKeys;
}

function generateRetentionPlan({ query = '', limit = 80 } = {}) {
    const candidates = collectCandidates(query, limit);
    const duplicateKeys = detectDuplicates(candidates);
    const items = candidates.map(item => {
        const scored = scoreItem(item, query);
        const reasons = [...scored.reasons];
        let recommendation = scored.recommendation;
        const key = `${item.memoryType}:${item.key || item.id}`;
        if (duplicateKeys.has(key) && recommendation !== 'remove') {
            recommendation = 'merge';
            reasons.push('duplicate or near-duplicate candidate');
        }
        return {
            id: key,
            memoryType: item.memoryType,
            type: item.type,
            targetId: item.id,
            targetKey: item.key,
            title: item.title,
            summary: compact(item.summary, 240),
            updatedAt: item.updatedAt,
            score: scored.score,
            recommendation,
            reasons,
            actions: ['keep', 'review', 'remove', 'merge']
        };
    }).sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));

    return {
        generatedAt: new Date().toISOString(),
        query,
        totalCandidates: items.length,
        summary: {
            keep: items.filter(item => item.recommendation === 'keep').length,
            review: items.filter(item => item.recommendation === 'review').length,
            remove: items.filter(item => item.recommendation === 'remove').length,
            merge: items.filter(item => item.recommendation === 'merge').length
        },
        items
    };
}

function applyRetentionDecision(input = {}) {
    const action = String(input.action || input.recommendation || 'review').trim();
    if (!['keep', 'review', 'remove', 'merge'].includes(action)) throw new Error('action must be keep, review, remove, or merge');
    const memoryType = String(input.memoryType || input.memory_type || 'memory').trim();
    const targetId = input.targetId || input.target_id || null;
    const targetKey = input.targetKey || input.target_key || null;
    const score = Number.isFinite(Number(input.score)) ? Math.round(Number(input.score)) : null;
    const reasons = Array.isArray(input.reasons) ? input.reasons : [String(input.reason || action)];

    if (action === 'remove') {
        if (memoryType === 'semantic') semanticMemory.deleteFact(targetKey);
        if (memoryType === 'sqlite-fact') sqliteStore.deleteMemoryFact(targetId || targetKey);
        if (memoryType === 'sqlite') sqliteStore.deleteMemory(targetId);
        if (memoryType === 'vector') vectorDb.deleteCheckpoint(targetId);
        if (memoryType === 'core') memoryGovernance.applyMemoryGovernance({ action: 'forget_core', type: input.type, key: targetKey });
        if (memoryType === 'guideline') guidelines.setLearnedGuidelineStatus(targetId || targetKey, 'archived', { reason: reasons.join('; '), actor: input.actor || 'system' });
    }

    if (action === 'keep') {
        if (memoryType === 'sqlite' && targetId) sqliteStore.updateMemoryLifecycle(targetId, { lifecycleStatus: 'active', trust: 0.9, metadata: { keptBy: input.actor || 'system' } });
        if (memoryType === 'sqlite-fact' && targetId) sqliteStore.upsertMemoryFact({ id: targetId, key: targetKey, lifecycleStatus: 'active', trust: 0.9, metadata: { keptBy: input.actor || 'system' } });
        if (memoryType === 'core' && input.type && targetKey !== null && targetKey !== undefined) memoryGovernance.applyMemoryGovernance({ action: 'pin_core', type: input.type, key: targetKey });
        if (memoryType === 'guideline') guidelines.setLearnedGuidelineStatus(targetId || targetKey, 'active', { reason: reasons.join('; '), actor: input.actor || 'system' });
    }

    if (action === 'merge') {
        if (memoryType === 'sqlite' && targetId) sqliteStore.updateMemoryLifecycle(targetId, { lifecycleStatus: 'archived', metadata: { mergedBy: input.actor || 'system', mergeTarget: input.mergeTarget || null } });
        if (memoryType === 'guideline') guidelines.setLearnedGuidelineStatus(targetId || targetKey, 'archived', { reason: reasons.join('; '), actor: input.actor || 'system' });
    }

    const decision = sqliteStore.recordRetentionDecision({
        memoryType,
        targetId,
        targetKey,
        score,
        recommendation: action,
        reasons,
        metadata: { actor: input.actor || 'system', mergeTarget: input.mergeTarget || null }
    });
    return { action, decision, memoryType, targetId, targetKey };
}

module.exports = {
    applyRetentionDecision,
    detectDuplicates,
    generateRetentionPlan,
    scoreItem
};
