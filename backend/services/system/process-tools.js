/**
 * August-owned process registry.
 *
 * Tracks PIDs that August itself started (via august__system_process start).
 * Used by august__system_process stop to refuse non-August PIDs without
 * explicit confirmation (locked decision 2 + reviewer #2 critical action).
 *
 * Augment with host-agent process tracking in Task 6.
 */

const _ownedPids = new Set();

function registerOwned(pid) {
    if (Number.isInteger(pid) && pid > 0) _ownedPids.add(pid);
}

function unregisterOwned(pid) {
    _ownedPids.delete(pid);
}

function isOwned(pid) {
    return Number.isInteger(pid) && _ownedPids.has(pid);
}

function listOwned() {
    return Array.from(_ownedPids);
}

function clearOwned() {
    _ownedPids.clear();
}

module.exports = {
    registerOwned,
    unregisterOwned,
    isOwned,
    listOwned,
    clearOwned
};
