const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
    SCOPE_ALLOWLIST,
    SCOPE_ROOT,
    loadPermissionProfile,
    resolveAllowedRoots,
    checkAugustPathPermission,
    checkCommandPermission,
    saveComputerRoots
} = require('../services/permissions/permission-profiles');

// Note: this test relies on config.security defaults set by config.js's
// applySecurityDefaults(). We don't need to write to disk; we can override
// the in-memory cache via the saveComputerRoots helper which calls saveConfig.

test('loadPermissionProfile defaults to allowlist scope with empty roots', () => {
    // Reset to a known state — prior tests may have left scope=root on disk.
    saveComputerRoots({ filesystemScope: 'allowlist', allowedRoots: [] });
    const profile = loadPermissionProfile();
    assert.equal(profile.filesystemScope, SCOPE_ALLOWLIST);
    assert.ok(Array.isArray(profile.allowedRoots));
});

test('resolveAllowedRoots returns null when filesystemScope is root', () => {
    // Use the in-memory setter through saveComputerRoots (writes to disk).
    // Restore after to keep other tests deterministic.
    const before = loadPermissionProfile();
    saveComputerRoots({ filesystemScope: 'root' });
    try {
        const roots = resolveAllowedRoots();
        assert.equal(roots, null);
    } finally {
        saveComputerRoots({ filesystemScope: before.filesystemScope });
    }
});

test('resolveAllowedRoots returns deduped array when scope is allowlist', () => {
    const before = loadPermissionProfile();
    saveComputerRoots({ filesystemScope: 'allowlist', allowedRoots: [] });
    try {
        const roots = resolveAllowedRoots();
        assert.ok(Array.isArray(roots));
        // Must contain process.cwd() at minimum.
        const cwd = path.resolve(process.cwd());
        assert.ok(roots.includes(cwd), 'roots should include process.cwd()');
        // No duplicates.
        const set = new Set(roots);
        assert.equal(set.size, roots.length, 'roots should be deduplicated');
    } finally {
        saveComputerRoots({ filesystemScope: before.filesystemScope, allowedRoots: before.allowedRoots });
    }
});

test('checkAugustPathPermission allows cwd path under allowlist', () => {
    const before = loadPermissionProfile();
    saveComputerRoots({ filesystemScope: 'allowlist', allowedRoots: [] });
    try {
        const r = checkAugustPathPermission(path.join(process.cwd(), 'foo.txt'));
        assert.equal(r.allowed, true);
        assert.equal(r.scope, SCOPE_ALLOWLIST);
    } finally {
        saveComputerRoots({ filesystemScope: before.filesystemScope, allowedRoots: before.allowedRoots });
    }
});

test('checkAugustPathPermission rejects /etc/passwd under allowlist', () => {
    const before = loadPermissionProfile();
    saveComputerRoots({ filesystemScope: 'allowlist', allowedRoots: [] });
    try {
        const r = checkAugustPathPermission('/etc/passwd');
        assert.equal(r.allowed, false);
        assert.match(r.reason, /Permission Denied/);
    } finally {
        saveComputerRoots({ filesystemScope: before.filesystemScope, allowedRoots: before.allowedRoots });
    }
});

test('checkAugustPathPermission allows /etc/passwd when filesystemScope=root', () => {
    const before = loadPermissionProfile();
    saveComputerRoots({ filesystemScope: 'root' });
    try {
        const r = checkAugustPathPermission('/etc/passwd');
        assert.equal(r.allowed, true);
        assert.equal(r.scope, SCOPE_ROOT);
    } finally {
        saveComputerRoots({ filesystemScope: before.filesystemScope, allowedRoots: before.allowedRoots });
    }
});

test('checkCommandPermission blocks destructive command containing /etc path', () => {
    const before = loadPermissionProfile();
    saveComputerRoots({ filesystemScope: 'allowlist', allowedRoots: [] });
    try {
        const r = checkCommandPermission('cat /etc/shadow');
        assert.equal(r.allowed, false);
        assert.ok(r.blockedPaths.includes('/etc/shadow'));
    } finally {
        saveComputerRoots({ filesystemScope: before.filesystemScope, allowedRoots: before.allowedRoots });
    }
});

test('checkCommandPermission allows benign command in cwd', () => {
    const before = loadPermissionProfile();
    saveComputerRoots({ filesystemScope: 'allowlist', allowedRoots: [] });
    try {
        const r = checkCommandPermission('dir');
        assert.equal(r.allowed, true);
        assert.deepEqual(r.blockedPaths, []);
    } finally {
        saveComputerRoots({ filesystemScope: before.filesystemScope, allowedRoots: before.allowedRoots });
    }
});
