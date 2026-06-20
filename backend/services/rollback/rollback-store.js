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
 *   restore_array_entry   — splice a single entry back into a top-level cfg
 *                           array (modelAliases, mcpServers, customPlugins, …).
 *                           `meta` carries { arrayKey, matchField, entryKey }.
 *                           `before.value` is the prior entry (or null for an
 *                           add); `after.value` is the new entry (or null for
 *                           a delete).
 *
 * Storage: data/august_rollback.json, FIFO capped at 100 entries.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataPath } = require('../../lib/data-paths');

const ROLLBACK_PATH = dataPath('august_rollback.json');
const MAX_ENTRIES = 100;
const TEST_WORKER_ID = process.env.NODE_TEST_CONTEXT ? `${process.pid}-${crypto.randomUUID()}` : null;

const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

const TYPES = new Set([
    'restore_file',
    'delete_created_file',
    'restore_setting',
    'restore_provider',
    'restore_model_selection',
    'restore_agent_config',
    'restore_memory_item',
    'restore_array_entry'
]);

function ensureDirExists(filePath) {
    retryOnTransient(() => fs.mkdirSync(path.dirname(filePath), { recursive: true }));
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
    withFileLock(() => writeRollbackFile(items));
}

function writeRollbackFile(items) {
    ensureDirExists(ROLLBACK_PATH);
    // Atomic write: write to a unique tmp file (random UUID) then rename over
    // the real path. renameSync is atomic on the same filesystem on Windows
    // and Unix. The UUID suffix is what saves us under `node --test`'s
    // parallel workers — a fixed `.tmp` name lets one writer's `clearRollbacks`
    // delete another writer's tmp mid-save.
    const tmpPath = `${ROLLBACK_PATH}.${crypto.randomUUID()}.tmp`;
    retryOnTransient(() => fs.writeFileSync(tmpPath, JSON.stringify(items, null, 2), 'utf8'));
    try {
        retryOnTransient(() => fs.renameSync(tmpPath, ROLLBACK_PATH));
    } catch (e) {
        // Best-effort cleanup of our own tmp on rename failure.
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        throw e;
    }
}

/**
 * Record a rollback entry. `before` should be the pre-mutation state (null
 * if the target did not exist), `after` should be the post-mutation state.
 * `meta` is an optional pass-through payload for types that need extra
 * context (e.g. `restore_array_entry` carries { arrayKey, matchField,
 * entryKey }).
 * Returns the stored record.
 */
function recordRollback({ type, target, before, after, meta } = {}) {
    if (!type || !TYPES.has(type)) {
        throw new Error(`Unsupported rollback type: ${type}`);
    }
    if (!target) {
        throw new Error('rollback target is required');
    }

    return withFileLock(() => {
        const items = load();
        const entry = {
            id: crypto.randomUUID(),
            at: new Date().toISOString(),
            type,
            target: String(target),
            before: before === undefined ? null : before,
            after: after === undefined ? null : after,
            meta: meta === undefined ? null : meta,
            status: 'available',
            workerId: TEST_WORKER_ID
        };
        let currentItems = items;
        if (TEST_WORKER_ID) {
            const others = items.filter(i => i.workerId !== TEST_WORKER_ID);
            currentItems = items.filter(i => i.workerId === TEST_WORKER_ID);
            currentItems.push(entry);
            const trimmed = currentItems.length > MAX_ENTRIES ? currentItems.slice(-MAX_ENTRIES) : currentItems;
            writeRollbackFile([...others, ...trimmed]);
        } else {
            currentItems.push(entry);
            const trimmed = currentItems.length > MAX_ENTRIES ? currentItems.slice(-MAX_ENTRIES) : currentItems;
            writeRollbackFile(trimmed);
        }
        return entry;
    });
}

/**
 * Undo a recorded rollback. Dispatches on `type`. Returns the updated entry.
 * Throws if the entry is not found or the dispatch fails.
 *
 * The entire lookup + dispatch + save runs inside the cross-process file
 * lock so that a concurrent `clearRollbacks` (or any other writer) can't
 * race between the read and the write — a TOCTOU window that would let
 * the lookup succeed but the save write into a file the other worker
 * already truncated.
 */
async function undoRollback(id) {
    if (!id) throw new Error('rollback id is required');
    return withFileLockAsync(async () => {
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
            writeRollbackFile(items);
            return entry;
        } catch (err) {
            entry.status = 'failed';
            entry.error = String((err && err.message) || err);
            items[idx] = entry;
            writeRollbackFile(items);
            throw err;
        }
    });
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
        case 'restore_array_entry':
            return undoRestoreArrayEntry(entry);
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

/**
 * Splice a single entry back into a top-level cfg array.
 *
 * `meta` must carry { arrayKey, matchField, entryKey }.
 * - Add (`before.value` null, `after.value` non-null): undo by removing
 *   the added entry.
 * - Delete (`before.value` non-null, `after.value` null): undo by
 *   re-inserting `entry.before.value` at the end of the array.
 * - Update (`before.value` and `after.value` non-null): undo by replacing
 *   the current entry with `entry.before.value`, or pushing it if missing.
 *
 * The `restore_setting` type is unfit for arrays because dotted-path
 * property assignment creates an expando on the array object instead of
 * modifying the array contents — hence this dedicated type.
 */
async function undoRestoreArrayEntry(entry) {
    const meta = entry.meta || {};
    const { arrayKey, matchField, entryKey } = meta;
    if (!arrayKey || !matchField || !entryKey) {
        throw new Error('restore_array_entry requires meta.arrayKey, meta.matchField, meta.entryKey');
    }
    const { getConfig, saveConfig } = require('../../lib/config');
    const cfg = getConfig() || {};
    const arr = Array.isArray(cfg[arrayKey]) ? cfg[arrayKey] : [];
    const idx = arr.findIndex(e => e && e[matchField] === entryKey);
    const beforeValue = entry.before && typeof entry.before === 'object' && 'value' in entry.before
        ? entry.before.value
        : entry.before;
    const afterValue = entry.after && typeof entry.after === 'object' && 'value' in entry.after
        ? entry.after.value
        : entry.after;
    const wasDeleted = afterValue === null || afterValue === undefined;
    const wasAdded = beforeValue === null || beforeValue === undefined;

    if (wasDeleted) {
        // Operation removed the entry — undo by re-inserting the prior value.
        if (idx === -1 && beforeValue !== null && beforeValue !== undefined) {
            arr.push(beforeValue);
        }
    } else if (wasAdded) {
        // Operation added the entry — undo by removing it.
        if (idx >= 0) arr.splice(idx, 1);
    } else {
        // Operation updated the entry — undo by restoring the prior value.
        if (idx >= 0) arr[idx] = beforeValue;
        else if (beforeValue !== null && beforeValue !== undefined) arr.push(beforeValue);
    }

    cfg[arrayKey] = arr;
    saveConfig(cfg);
    return true;
}

/**
 * List rollback entries with optional filters.
 *
 * Filters (all optional):
 *   limit, status ('available' | 'undone' | 'failed'), type
 *
 * When `summary: true`, returns aggregate counts:
 *   { available, undone, failed, total, byType, at }
 */
function listRollbacks({ limit = 100, status, type, summary } = {}) {
    let items = [];
    withFileLock(() => {
        items = load();
    });
    if (TEST_WORKER_ID) items = items.filter(i => i.workerId === TEST_WORKER_ID);
    if (status) items = items.filter(i => i.status === status);
    if (type)   items = items.filter(i => i.type === type);

    if (summary) {
        const byType = {};
        for (const i of items) inc(byType, i.type || '(unknown)');
        return {
            available: items.filter(i => i.status === 'available').length,
            undone:    items.filter(i => i.status === 'undone').length,
            failed:    items.filter(i => i.status === 'failed').length,
            total:     items.length,
            byType,
            at:        new Date().toISOString()
        };
    }
    return items.slice(-Math.max(1, Number(limit) || 100));
}

function inc(map, key) {
    map[key] = (map[key] || 0) + 1;
}

function retryOnTransient(fn, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return fn();
        } catch (e) {
            if (TRANSIENT_FS_CODES.has(e.code) && attempt < maxRetries) {
                const delay = Math.min(10 * Math.pow(2, attempt - 1), 200);
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
                continue;
            }
            throw e;
        }
    }
}

// Back-compat alias. Older callers / test files keep working.
const retryOnEperm = retryOnTransient;

/**
 * Cross-process file lock used to serialize concurrent workers (e.g.
 * `node --test` parallel workers) that touch the same on-disk file.
 *
 * Distinct lock path from audit-log so the two stores don't contend.
 */
const ROLLBACK_LOCK_PATH = `${ROLLBACK_PATH}.lock`;

function withFileLock(fn) {
    ensureDirExists(ROLLBACK_PATH);
    for (let i = 0; i < 100; i++) {
        let fd;
        try {
            // Wrap the open itself in retryOnTransient to absorb the
            // Windows-specific case where the open fails with EPERM/EBUSY/
            // EACCES (rather than EEXIST) because another worker still has
            // the lock file open with shared access. EEXIST is the normal
            // "lock held" case and falls through to the outer wait loop.
            fd = retryOnTransient(() => fs.openSync(ROLLBACK_LOCK_PATH, 'wx'));
        } catch (e) {
            if (e.code === 'EEXIST') {
                const delay = Math.min(5 * Math.pow(1.5, i), 50);
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
                continue;
            }
            throw e;
        }
        try {
            return fn();
        } finally {
            try { fs.closeSync(fd); } catch (_) { /* ignore */ }
            try { fs.unlinkSync(ROLLBACK_LOCK_PATH); } catch (_) { /* ignore */ }
        }
    }
    throw new Error(`File lock timeout: ${ROLLBACK_LOCK_PATH}`);
}

async function withFileLockAsync(fn) {
    ensureDirExists(ROLLBACK_PATH);
    for (let i = 0; i < 100; i++) {
        let fd;
        try {
            fd = retryOnTransient(() => fs.openSync(ROLLBACK_LOCK_PATH, 'wx'));
        } catch (e) {
            if (e.code === 'EEXIST') {
                const delay = Math.min(5 * Math.pow(1.5, i), 50);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw e;
        }
        try {
            return await fn();
        } finally {
            try { fs.closeSync(fd); } catch (_) { /* ignore */ }
            try { fs.unlinkSync(ROLLBACK_LOCK_PATH); } catch (_) { /* ignore */ }
        }
    }
    throw new Error(`File lock timeout: ${ROLLBACK_LOCK_PATH}`);
}

function clearRollbacks() {
    withFileLock(() => {
        if (!fs.existsSync(ROLLBACK_PATH)) {
            // Best-effort: clean up any leftover *.tmp files from a crashed save.
        } else if (!TEST_WORKER_ID) {
            retryOnTransient(() => fs.unlinkSync(ROLLBACK_PATH));
        } else {
            const items = load();
            const kept = items.filter(i => i.workerId !== TEST_WORKER_ID);
            if (kept.length === 0) {
                retryOnTransient(() => fs.unlinkSync(ROLLBACK_PATH));
            } else {
                writeRollbackFile(kept);
            }
        }
        // Best-effort: clean up any leftover *.tmp files from a crashed save.
        // Use a sibling-glob via fs.readdirSync so we don't need extra deps.
        try {
            const dir = path.dirname(ROLLBACK_PATH);
            const base = path.basename(ROLLBACK_PATH);
            if (fs.existsSync(dir)) {
                for (const name of fs.readdirSync(dir)) {
                    if (name.startsWith(`${base}.`) && name.endsWith('.tmp')) {
                        retryOnTransient(() => fs.unlinkSync(path.join(dir, name)));
                    }
                }
            }
        } catch (_) { /* best effort */ }
    });
}

module.exports = {
    TYPES,
    recordRollback,
    undoRollback,
    listRollbacks,
    clearRollbacks,
    ROLLBACK_PATH
};
