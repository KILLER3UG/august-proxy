const { readAugustCoreMemory, writeAugustCoreMemory } = require('./core-memory');
const { deleteFact } = require('./semantic-memory');
const { deleteCheckpoint, readVectorEntries } = require('./vector-db');
const { deleteMemory: deleteSqliteMemory } = require('./sqlite-memory-store');
const { searchMemory, updateMemoryItem } = require('./memory-lifecycle');

function searchGovernanceTargets(query) {
    const results = searchMemory(query || '');
    return {
        query,
        ...results,
        actions: [
            'archive_core',
            'pin_core',
            'unpin_core',
            'forget_core',
            'forget_semantic',
            'forget_vector'
        ]
    };
}

function removeCoreItem(memory, type, key) {
    const target = String(key);
    if (type === 'project') {
        const index = Number(target);
        memory.active_projects = (memory.active_projects || []).filter((_, i) => i !== index);
        return true;
    }
    if (type === 'integration') {
        if (!memory.integrations || !memory.integrations[target]) return false;
        delete memory.integrations[target];
        return true;
    }
    if (type === 'event') {
        const index = Number(target);
        memory.recent_events = (memory.recent_events || []).filter((_, i) => i !== index);
        return true;
    }
    if (type === 'checkpoint') {
        const index = Number(target);
        memory.conversation_checkpoints = (memory.conversation_checkpoints || []).filter((_, i) => i !== index);
        return true;
    }
    return false;
}

function applyMemoryGovernance(action) {
    const payload = action || {};
    const name = payload.action;
    if (!name) throw new Error('action is required');

    if (name === 'forget_semantic') {
        const deleted = deleteFact(payload.key);
        return { action: name, deleted, key: payload.key };
    }

    if (name === 'forget_vector') {
        const id = payload.id || readVectorEntries().find(entry =>
            String(entry.topic || '').toLowerCase() === String(payload.topic || '').toLowerCase()
        )?.id;
        if (!id) return { action: name, deleted: false, reason: 'vector memory not found' };
        const deleted = deleteCheckpoint(id);
        try { deleteSqliteMemory(id); } catch (e) {}
        return { action: name, deleted, id };
    }

    if (['archive_core', 'pin_core', 'unpin_core'].includes(name)) {
        const updates = {};
        if (name === 'archive_core') updates.status = 'archived';
        if (name === 'pin_core') updates.pinned = true;
        if (name === 'unpin_core') updates.pinned = false;
        return { action: name, ...updateMemoryItem({ type: payload.type, key: payload.key, updates }) };
    }

    if (name === 'forget_core') {
        const memory = readAugustCoreMemory();
        const deleted = removeCoreItem(memory, payload.type, payload.key);
        if (deleted) writeAugustCoreMemory(memory);
        return { action: name, deleted, type: payload.type, key: payload.key };
    }

    throw new Error(`Unsupported governance action: ${name}`);
}

module.exports = {
    applyMemoryGovernance,
    searchGovernanceTargets
};
