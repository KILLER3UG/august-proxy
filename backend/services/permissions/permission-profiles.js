/**
 * Permission profiles for August self-management and host computer access.
 *
 * Wraps existing path-permission helpers and adds a config-driven layer that
 * reads `security.allowedRoots`, `security.filesystemScope`, and the data
 * directory from config + data-paths.
 *
 * Locked decision 1: filesystem scope defaults to allowlist (project cwd +
 * security.allowedRoots + augustDataDir + tmp). Setting
 * `security.filesystemScope = 'root'` disables the scope check and allows
 * the full machine (still subject to confirm-mutation for critical ops).
 */

const path = require('path');
const os = require('os');
const pathPerms = require('../../lib/path-permissions');

const SCOPE_ALLOWLIST = 'allowlist';
const SCOPE_ROOT = 'root';

function loadPermissionProfile() {
    let cfg = {};
    try {
        const { getConfig } = require('../../lib/config');
        cfg = getConfig() || {};
    } catch (_) { /* config not ready yet */ }

    const sec = cfg.security || {};
    return {
        allowedRoots: Array.isArray(sec.allowedRoots) ? sec.allowedRoots.slice() : [],
        filesystemScope: sec.filesystemScope === SCOPE_ROOT ? SCOPE_ROOT : SCOPE_ALLOWLIST,
        deniedPatterns: []
    };
}

/**
 * Returns the merged list of allowed base paths for the current profile.
 * Returns `null` when `filesystemScope === 'root'` (scope check disabled).
 */
function resolveAllowedRoots(extraRoots) {
    const profile = loadPermissionProfile();
    if (profile.filesystemScope === SCOPE_ROOT) return null;

    const roots = [];
    try {
        const { getDataDir } = require('../../lib/data-paths');
        const dataDir = getDataDir();
        if (dataDir) roots.push(dataDir);
    } catch (_) { /* data-paths not ready */ }

    try {
        const tmp = os.tmpdir();
        if (tmp) roots.push(tmp);
    } catch (_) { /* shouldn't happen */ }

    if (process.cwd()) roots.push(process.cwd());

    roots.push(...profile.allowedRoots);
    if (Array.isArray(extraRoots)) roots.push(...extraRoots);

    const seen = new Set();
    const out = [];
    for (const r of roots) {
        if (!r) continue;
        const norm = path.resolve(String(r));
        if (seen.has(norm)) continue;
        seen.add(norm);
        out.push(norm);
    }
    return out;
}

/**
 * Check whether `filePath` is allowed under the current profile + extra roots.
 * Returns `{ allowed: boolean, reason?: string, scope: 'allowlist'|'root' }`.
 */
function checkAugustPathPermission(filePath, options = {}) {
    const profile = loadPermissionProfile();
    if (profile.filesystemScope === SCOPE_ROOT) {
        return { allowed: true, scope: SCOPE_ROOT };
    }

    const extra = Array.isArray(options.extraRoots) ? options.extraRoots : [];
    const baseReason = pathPerms.checkPathPermission(filePath, extra);
    if (baseReason) return { allowed: false, reason: baseReason, scope: SCOPE_ALLOWLIST };

    return { allowed: true, scope: SCOPE_ALLOWLIST };
}

/**
 * Extract paths from a shell command and check each against the profile.
 * Returns `{ allowed: boolean, blockedPaths: string[], reason?: string }`.
 */
function checkCommandPermission(command, options = {}) {
    const profile = loadPermissionProfile();
    if (profile.filesystemScope === SCOPE_ROOT) {
        return { allowed: true, blockedPaths: [], scope: SCOPE_ROOT };
    }

    const extra = Array.isArray(options.extraRoots) ? options.extraRoots : [];
    const paths = pathPerms.extractPathsFromCommand(command || '');
    const blocked = [];
    for (const p of paths) {
        const r = checkAugustPathPermission(p, { extraRoots: extra });
        if (!r.allowed) blocked.push(p);
    }
    if (blocked.length > 0) {
        return {
            allowed: false,
            blockedPaths: blocked,
            scope: SCOPE_ALLOWLIST,
            reason: `[August Permission Denied]\nCommand references path(s) outside the permitted workspace: ${blocked.join(', ')}.`
        };
    }
    return { allowed: true, blockedPaths: [], scope: SCOPE_ALLOWLIST };
}

/**
 * Convenience: write security config (used by the Settings UI).
 * Preserves existing config + collapses env vars via existing saveConfig.
 */
function saveComputerRoots(opts = {}) {
    const { allowedRoots, filesystemScope, postObservationScreenshot } = opts || {};
    const { getConfig, saveConfig } = require('../../lib/config');
    const cfg = getConfig() || {};
    cfg.security = cfg.security || {};
    if (Array.isArray(allowedRoots)) cfg.security.allowedRoots = allowedRoots.slice();
    if (filesystemScope === SCOPE_ROOT || filesystemScope === SCOPE_ALLOWLIST) {
        cfg.security.filesystemScope = filesystemScope;
    }
    if (typeof postObservationScreenshot === 'boolean') {
        cfg.security.postObservationScreenshot = postObservationScreenshot;
    }
    saveConfig(cfg);
    return loadPermissionProfile();
}

module.exports = {
    SCOPE_ALLOWLIST,
    SCOPE_ROOT,
    loadPermissionProfile,
    resolveAllowedRoots,
    checkAugustPathPermission,
    checkCommandPermission,
    saveComputerRoots
};
