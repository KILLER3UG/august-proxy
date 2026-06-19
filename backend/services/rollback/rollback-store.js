/**
 * Declarative rollback store.
 *
 * Rollback records are declarative (no stored JS closures — Review #3 fix).
 * Each record carries a `type` discriminator and structured `before`/`after`
 * payloads. `undoRollback(id)` dispatches on `type` to a registered handler.
 *
 * Types:
 *   restore_file          — restore `before.content` to `target` (path)
 *   delete_created_file   — delete `target` (path that didn't exist before)
 *   restore_setting       — restore `before.value` at `target` (dotted key path)
 *   restore_provider      — re-upsert provider record from `before`
 *   restore_model_selection — re-select model+provider from `before`
 *   restore_agent_config  — re-save agent from `before`
 *   restore_memory_item   — re-set memory fact from `before`
 *
 * Storage: data/august_rollback.json, FIFO capped at 100 entries.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataPath } = require('../../lib/data-paths');

const ROLLBACK_PATH = dataPath('august_rollback.json');
const MAX_ENTRIES = 100;

const TYPES = new Set([
    'restore_file',
    'delete_created_file',
    'restore_setting',
    'restore_provider',
    'restore_model_selection',
    'restore_agent_config',
    'restore_memory_item'
]);

function ensureDirExists(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function load() {
    if (!fs.existsSync(ROLLBACK_PATH)) return [];
    try {
        const raw = fs.readFileSync(ROLLBACK_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function save(items) {
    ensureDirExists(ROLLBACK_PATH);
    fs.writeFileSync(ROLLBACK_PATH, JSON.stringify(items, null, 2), 'utf8');
}

/**
 * Record a rollback entry. `before` should be the pre-mutation state (null
 * if the target did not exist), `after` should be the post-mutation state.
 * Returns the stored record.
 */
function recordRollback({ type, target, before, after } = {}) {
    if (!type || !TYPES.has(type)) {
        throw new Error(`Unsupported rollback type: ${type}`);
    }
    if (!target) {
        throw new Error('rollback target is required');
    }
    const items = load();
    const entry = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        type,
        target: String(target),
        before: before === undefined ? null : before,
        after: after === undefined ? null : after,
        status: 'available'
    };
    items.push(entry);
    // FIFO cap
    const trimmed = items.length > MAX_ENTRIES ? items.slice(-MAX_ENTRIES) : items;
    save(trimmed);
    return entry;
}

/**
 * Undo a recorded rollback. Dispatches on `type`. Returns the updated entry.
 * Throws if the entry is not found or the dispatch fails.
 */
async function undoRollback(id) {
    if (!id) throw new Error('rollback id is required');
    const items = load();
    const idx = items.findIndex(it => it.id === id);
    if (idx === -1) throw new Error(`Rollback item not found: ${id}`);
    const entry = items[idx];
    if (entry.status === 'undone') {
        return { ...entry, alreadyUndone: true };
    }

    try {
        await dispatchUndo(entry);
        entry.status = 'undone';
        entry.undoneAt = new Date().toISOString();
        items[idx] = entry;
        save(items);
        return entry;
    } catch (err) {
        entry.status = 'failed';
        entry.error = String(err && err.message || err);
        items[idx] = entry;
        save(items);
        throw err;
    }
}

async function dispatchUndo(entry) {
    switch (entry.type) {
        case 'restore_file':
            return undoRestoreFile(entry);
        case 'delete_created_file':
            return undoDeleteCreatedFile(entry);
        case 'restore_setting':
            return undoRestoreSetting(entry);
        case 'restore_provider':
            return undoRestoreProvider(entry);
        case 'restore_model_selection':
            return undoRestoreModelSelection(entry);
        case 'restore_agent_config':
            return undoRestoreAgentConfig(entry);
        case 'restore_memory_item':
            return undoRestoreMemoryItem(entry);
        default:
            throw new Error(`No undo handler for type: ${entry.type}`);
    }
}

function undoRestoreFile(entry) {
    const fsPromises = require('fs').promises;
    if (entry.before === null || entry.before === undefined) {
        // File did not exist before — delete it
        return fsPromises.rm(entry.target, { force: true });
    }
    // File existed — restore prior content
    return fsPromises.mkdir(path.dirname(entry.target), { recursive: true })
        .then(() => fsPromises.writeFile(entry.target, entry.before.content || '', 'utf8'));
}

function undoDeleteCreatedFile(entry) {
    const fsPromises = require('fs').promises;
    return fsPromises.rm(entry.target, { force: true });
}

async function undoRestoreSetting(entry) {
    const { getConfig, saveConfig } = require('../../lib/config');
    const cfg = getConfig() || {};
    const parts = String(entry.target).split('.');
    let cursor = cfg;
    for (const part of parts.slice(0, -1)) {
        if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
        cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = entry.before === null ? undefined : entry.before.value;
    saveConfig(cfg);
    return true;
}

async function undoRestoreProvider(entry) {
    const providersRoutes = require('../providers/providers-routes');
    if (entry.before === null) {
        if (typeof providersRoutes.deleteProvider === 'function') {
            return providersRoutes.deleteProvider(entry.target);
        }
        return false;
    }
    if (typeof providersRoutes.upsertProvider === 'function') {
        return providersRoutes.upsertProvider(entry.before);
    }
    return false;
}

async function undoRestoreModelSelection(entry) {
    if (!entry.before) throw new Error('restore_model_selection requires before payload');
    const { syncClaudePublicAlias, syncGptPublicAlias, saveProfile, getProfile } = require('../../lib/config');
    const { model, provider } = entry.before;
    if (!model) throw new Error('restore_model_selection missing model');
    if (syncClaudePublicAlias(model)) return { ok: true, profile: 'claude', model };
    if (syncGptPublicAlias(model)) return { ok: true, profile: 'codex', model };
    if (!provider) throw new Error('restore_model_selection requires provider for non-public model');
    const profile = getProfile(provider) || {};
    saveProfile(provider, { ...profile, currentModel: model });
    return { ok: true, provider, model };
}

async function undoRestoreAgentConfig(entry) {
    if (!entry.before) throw new Error('restore_agent_config requires before payload');
    const { saveAgent } = require('../tools/agent-registry');
    return saveAgent(entry.before);
}

async function undoRestoreMemoryItem(entry) {
    if (!entry.before) throw new Error('restore_memory_item requires before payload');
    const semantic = require('../memory/semantic-memory');
    if (entry.before.deleted) {
        if (typeof semantic.setFact === 'function') {
            return semantic.setFact(entry.before.key, entry.before.value, entry.before.category, entry.before.ttl_days);
        }
        return false;
    }
    if (typeof semantic.deleteFact === 'function' && entry.before.value === undefined) {
        return semantic.deleteFact(entry.target);
    }
    return false;
}

function listRollbacks({ limit = 100 } = {}) {
    const items = load();
    return items.slice(-Math.max(1, Number(limit) || 100));
}

function clearRollbacks() {
    if (fs.existsSync(ROLLBACK_PATH)) fs.unlinkSync(ROLLBACK_PATH);
}

module.exports = {
    TYPES,
    recordRollback,
    undoRollback,
    listRollbacks,
    clearRollbacks,
    ROLLBACK_PATH
};
