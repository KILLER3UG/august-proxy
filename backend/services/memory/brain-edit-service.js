const coreMemory = require('./core-memory');
const semanticMemory = require('./semantic-memory');
const guidelines = require('./learned-guidelines');
const vectorDb = require('./vector-db');
const sqliteStore = require('./sqlite-memory-store');
const memoryGovernance = require('./memory-governance');

const ALLOWED_ACTIONS = new Set([
    'set_fact',
    'delete_fact',
    'update_core',
    'update_guideline',
    'archive_memory',
    'pin_memory',
    'unpin_memory',
    'keep_memory',
    'delete_memory',
    'merge_memory',
    'upsert_model_observation'
]);

function normalizeAction(input = {}) {
    const action = String(input.action || '').trim();
    const memoryType = String(input.memoryType || input.memory_type || input.target?.type || 'memory').trim();
    const target = input.target || {};
    const after = input.after || input.after_json || input.patch || {};
    const before = input.before || input.before_json || {};
    return {
        title: String(input.title || action || 'Brain edit proposal').trim(),
        description: String(input.description || input.reason || '').trim(),
        action,
        memoryType,
        targetId: input.targetId || input.target_id || target.id || null,
        targetType: input.targetType || input.target_type || target.type || null,
        targetKey: input.targetKey || input.target_key || target.key || null,
        before,
        after,
        metadata: input.metadata || input.metadata_json || { actor: input.actor || 'system' },
        status: input.status || 'pending'
    };
}

function createBrainEditProposal(input = {}) {
    const proposal = normalizeAction(input);
    if (!ALLOWED_ACTIONS.has(proposal.action)) {
        throw new Error(`Unsupported brain edit action: ${proposal.action}`);
    }
    if (!proposal.title) throw new Error('title is required');
    if (!proposal.memoryType) throw new Error('memory_type is required');
    return sqliteStore.createMemoryProposal({
        title: proposal.title,
        description: proposal.description,
        action: proposal.action,
        memoryType: proposal.memoryType,
        targetId: proposal.targetId,
        targetType: proposal.targetType,
        targetKey: proposal.targetKey,
        before: proposal.before,
        after: proposal.after,
        metadata: {
            ...proposal.metadata,
            actor: proposal.metadata?.actor || input.actor || 'system',
            requestedAt: new Date().toISOString()
        },
        status: proposal.status
    });
}

function setAtPath(object, path, value) {
    const parts = String(path || '').split('.').filter(Boolean);
    if (parts.length === 0) return object;
    let cursor = object;
    for (const part of parts.slice(0, -1)) {
        cursor[part] = cursor[part] && typeof cursor[part] === 'object' ? cursor[part] : {};
        cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
    return object;
}

function updateCoreMemory(after, actor) {
    const memory = coreMemory.readAugustCoreMemory();
    if (after && typeof after === 'object' && after.memory) {
        const next = coreMemory.normalizeAugustCoreMemory({ ...memory, ...after.memory });
        coreMemory.writeAugustCoreMemory(next);
        return { changed: true, section: 'memory' };
    }
    if (after && typeof after === 'object' && after.section) {
        if (!(after.section in memory)) throw new Error(`Unknown core memory section: ${after.section}`);
        memory[after.section] = after.value;
        coreMemory.writeAugustCoreMemory(memory);
        return { changed: true, section: after.section };
    }
    if (after && typeof after === 'object' && after.patch) {
        const patch = after.patch;
        for (const [path, value] of Object.entries(patch)) setAtPath(memory, path, value);
        coreMemory.writeAugustCoreMemory(memory);
        return { changed: true, patch: Object.keys(patch) };
    }
    throw new Error('update_core requires after.memory, after.section/value, or after.patch');
}

function updateGuideline(after) {
    const text = after.text || after.value;
    const status = after.status || 'pending';
    const source = after.source || 'brain_edit';
    const confidence = after.confidence === undefined ? 0.75 : after.confidence;
    let item = guidelines.upsertLearnedGuideline(text, { source, confidence, status });
    if (!item) throw new Error('guideline text is required');
    if (after.id && after.id !== item.id) {
        item = guidelines.setLearnedGuidelineStatus(after.id, status, { reason: after.reason || 'brain edit', actor: after.actor || 'system' }) || item;
    }
    return { id: item.id, status: item.status, text: item.text };
}

function applyMemoryAction(actionName, proposal, actor) {
    const after = proposal.after || {};
    const target = proposal.targetType || proposal.memoryType;
    const targetId = proposal.targetId || after.id || null;
    const targetKey = proposal.targetKey || after.key || null;

    if (actionName === 'set_fact') {
        const fact = semanticMemory.setFact(
            after.key || targetKey,
            after.value || after.text || after.summary,
            after.category || 'user_preference',
            after.ttlDays ?? after.ttl_days ?? null,
            after.source || actor || 'brain_edit',
            { confidence: after.confidence ?? 0.75, ttl: after.ttl || null }
        );
        sqliteStore.recordRetentionDecision({ memoryType: 'semantic', targetKey: fact.key, score: Math.round((fact.confidence || 0.75) * 100), recommendation: 'keep', reasons: ['new durable fact'], metadata: { proposalId: proposal.id } });
        return { action: actionName, fact };
    }

    if (actionName === 'delete_fact') {
        const key = after.key || targetKey;
        const deleted = semanticMemory.deleteFact(key);
        sqliteStore.recordRetentionDecision({ memoryType: 'semantic', targetKey: key, score: 0, recommendation: 'remove', reasons: ['explicit delete_fact proposal'], metadata: { proposalId: proposal.id } });
        return { action: actionName, deleted, key };
    }

    if (actionName === 'update_core') {
        return { action: actionName, ...updateCoreMemory(after, actor) };
    }

    if (actionName === 'update_guideline') {
        return { action: actionName, ...updateGuideline({ ...after, actor }) };
    }

    if (actionName === 'archive_memory') {
        if (target === 'sqlite' || proposal.memoryType === 'sqlite') {
            const archived = sqliteStore.updateMemoryLifecycle(targetId, { lifecycleStatus: 'archived', metadata: { archivedBy: actor, proposalId: proposal.id } });
            return { action: actionName, archived, id: targetId };
        }
        if (target === 'vector' || proposal.memoryType === 'vector') {
            const deleted = vectorDb.deleteCheckpoint(targetId);
            return { action: actionName, deleted, id: targetId };
        }
        if (target === 'core' || proposal.memoryType === 'core') {
            const result = memoryGovernance.applyMemoryGovernance({ action: 'archive_core', type: after.type || proposal.targetType, key: targetKey });
            return { action: actionName, ...result };
        }
        throw new Error(`archive_memory unsupported memory_type: ${proposal.memoryType}`);
    }

    if (actionName === 'pin_memory') {
        if (target === 'core' || proposal.memoryType === 'core') {
            const result = memoryGovernance.applyMemoryGovernance({ action: 'pin_core', type: after.type || proposal.targetType, key: targetKey });
            return { action: actionName, ...result };
        }
        const pinned = sqliteStore.updateMemoryLifecycle(targetId, { lifecycleStatus: 'active', trust: 0.95, metadata: { pinned: true, pinnedBy: actor, proposalId: proposal.id } });
        return { action: actionName, pinned, id: targetId };
    }

    if (actionName === 'unpin_memory') {
        if (target === 'core' || proposal.memoryType === 'core') {
            const result = memoryGovernance.applyMemoryGovernance({ action: 'unpin_core', type: after.type || proposal.targetType, key: targetKey });
            return { action: actionName, ...result };
        }
        const unpinned = sqliteStore.updateMemoryLifecycle(targetId, { metadata: { pinned: false, unpinnedBy: actor, proposalId: proposal.id } });
        return { action: actionName, unpinned, id: targetId };
    }

    if (actionName === 'keep_memory') {
        sqliteStore.recordRetentionDecision({ memoryType: proposal.memoryType, targetId, targetKey, score: after.score ?? 85, recommendation: 'keep', reasons: after.reasons || ['explicit keep_memory proposal'], metadata: { proposalId: proposal.id } });
        if (proposal.memoryType === 'sqlite' && targetId) {
            sqliteStore.updateMemoryLifecycle(targetId, { lifecycleStatus: 'active', trust: 0.9, metadata: { keptBy: actor, proposalId: proposal.id } });
        }
        if (proposal.memoryType === 'core' && after.type && targetKey !== null && targetKey !== undefined) {
            memoryGovernance.applyMemoryGovernance({ action: 'pin_core', type: after.type, key: targetKey });
        }
        return { action: actionName, kept: true, memoryType: proposal.memoryType, targetId, targetKey };
    }

    if (actionName === 'delete_memory') {
        if (target === 'sqlite' || proposal.memoryType === 'sqlite') {
            const deleted = sqliteStore.deleteMemory(targetId);
            sqliteStore.recordRetentionDecision({ memoryType: 'sqlite', targetId, score: 0, recommendation: 'remove', reasons: ['explicit delete_memory proposal'], metadata: { proposalId: proposal.id } });
            return { action: actionName, deleted, id: targetId };
        }
        if (target === 'vector' || proposal.memoryType === 'vector') {
            const deleted = vectorDb.deleteCheckpoint(targetId);
            sqliteStore.recordRetentionDecision({ memoryType: 'vector', targetId, score: 0, recommendation: 'remove', reasons: ['explicit delete_memory proposal'], metadata: { proposalId: proposal.id } });
            return { action: actionName, deleted, id: targetId };
        }
        if (target === 'core' || proposal.memoryType === 'core') {
            const result = memoryGovernance.applyMemoryGovernance({ action: 'forget_core', type: after.type || proposal.targetType, key: targetKey });
            sqliteStore.recordRetentionDecision({ memoryType: 'core', targetKey, score: 0, recommendation: 'remove', reasons: ['explicit delete_memory proposal'], metadata: { proposalId: proposal.id } });
            return { action: actionName, ...result };
        }
        if (target === 'semantic' || proposal.memoryType === 'semantic') {
            const deleted = semanticMemory.deleteFact(after.key || targetKey);
            sqliteStore.recordRetentionDecision({ memoryType: 'semantic', targetKey, score: 0, recommendation: 'remove', reasons: ['explicit delete_memory proposal'], metadata: { proposalId: proposal.id } });
            return { action: actionName, deleted, key: after.key || targetKey };
        }
        throw new Error(`delete_memory unsupported memory_type: ${proposal.memoryType}`);
    }

    if (actionName === 'merge_memory') {
        sqliteStore.recordRetentionDecision({ memoryType: proposal.memoryType, targetId, targetKey, score: after.score ?? 70, recommendation: 'merge', reasons: after.reasons || ['duplicate or overlapping memory detected'], metadata: { proposalId: proposal.id, mergeTarget: after.mergeTarget || null } });
        if (proposal.memoryType === 'sqlite' && targetId) {
            sqliteStore.updateMemoryLifecycle(targetId, { lifecycleStatus: 'archived', metadata: { mergedBy: actor, proposalId: proposal.id, mergeTarget: after.mergeTarget || null } });
        }
        return { action: actionName, merged: true, memoryType: proposal.memoryType, targetId, targetKey, mergeTarget: after.mergeTarget || null };
    }

    if (actionName === 'upsert_model_observation') {
        const result = sqliteStore.recordModelObservation({
            modelId: after.modelId || after.model_id || proposal.metadata?.modelId,
            provider: after.provider || proposal.metadata?.provider,
            observationType: after.observationType || after.observation_type || 'brain_edit',
            summary: after.summary || after.observation,
            details: after.details || after.details_json || {},
            relatedMemory: after.relatedMemory || after.related_memory || { proposalId: proposal.id, memoryType: proposal.memoryType, targetId, targetKey },
            source: after.source || 'brain_edit'
        });
        return { action: actionName, ...result };
    }

    throw new Error(`Unsupported brain edit action: ${actionName}`);
}

function commitBrainEdit(proposalId, options = {}) {
    if (!proposalId) throw new Error('proposalId is required');
    const proposal = sqliteStore.getMemoryProposal(proposalId);
    if (!proposal) throw new Error(`Brain edit proposal not found: ${proposalId}`);
    if (!options.force && proposal.status !== 'pending') {
        throw new Error(`Brain edit proposal is not pending: ${proposal.status}`);
    }
    const actor = options.actor || proposal.metadata?.actor || 'system';
    const applied = applyMemoryAction(proposal.action, proposal, actor);
    const updated = sqliteStore.updateMemoryProposal(proposalId, {
        status: 'committed',
        metadata: {
            ...proposal.metadata,
            actor,
            committedAt: new Date().toISOString(),
            applied
        }
    });
    return { proposal: updated, applied };
}

function listBrainEditProposals(options = {}) {
    return sqliteStore.listMemoryProposals(options);
}

function getBrainEditProposal(proposalId) {
    return sqliteStore.getMemoryProposal(proposalId);
}

module.exports = {
    ALLOWED_ACTIONS,
    commitBrainEdit,
    createBrainEditProposal,
    getBrainEditProposal,
    listBrainEditProposals
};
