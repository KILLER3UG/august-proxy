const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    recordRollback,
    undoRollback,
    listRollbacks,
    clearRollbacks,
    TYPES
} = require('../services/rollback/rollback-store');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-test-'));
}

test('TYPES set contains all supported rollback types', () => {
    assert.ok(TYPES.has('restore_file'));
    assert.ok(TYPES.has('delete_created_file'));
    assert.ok(TYPES.has('restore_setting'));
    assert.ok(TYPES.has('restore_provider'));
    assert.ok(TYPES.has('restore_model_selection'));
    assert.ok(TYPES.has('restore_agent_config'));
    assert.ok(TYPES.has('restore_memory_item'));
});

test('recordRollback rejects unsupported type', () => {
    assert.throws(() => recordRollback({ type: 'unknown_type', target: '/x' }), /Unsupported rollback type/);
});

test('recordRollback rejects missing target', () => {
    assert.throws(() => recordRollback({ type: 'restore_file' }), /target is required/);
});

test('restore_file: write file, modify, undo restores original content', async () => {
    clearRollbacks();
    const dir = makeTempDir();
    const file = path.join(dir, 'doc.txt');
    const original = 'original content';
    fs.writeFileSync(file, original);

    // Mutation: write new content
    fs.writeFileSync(file, 'modified content');
    recordRollback({ type: 'restore_file', target: file, before: { content: original }, after: { content: 'modified content' } });

    // Confirm rollback was recorded
    const items = listRollbacks();
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'restore_file');
    assert.equal(items[0].status, 'available');

    // Undo
    await undoRollback(items[0].id);
    assert.equal(fs.readFileSync(file, 'utf8'), original);

    // Cleanup
    fs.rmSync(dir, { recursive: true });
    clearRollbacks();
});

test('delete_created_file: undo removes the file that did not exist before', async () => {
    clearRollbacks();
    const dir = makeTempDir();
    const file = path.join(dir, 'new.txt');
    // File did not exist before
    fs.writeFileSync(file, 'created');
    recordRollback({ type: 'delete_created_file', target: file, before: null, after: { content: 'created' } });

    const items = listRollbacks();
    await undoRollback(items[0].id);
    assert.ok(!fs.existsSync(file));

    fs.rmSync(dir, { recursive: true });
    clearRollbacks();
});

test('restore_setting: undo restores previous config value', async () => {
    clearRollbacks();
    const { saveComputerRoots, loadPermissionProfile } = require('../services/permissions/permission-profiles');
    const before = loadPermissionProfile();

    saveComputerRoots({ filesystemScope: 'root' });
    recordRollback({
        type: 'restore_setting',
        target: 'security.filesystemScope',
        before: { value: before.filesystemScope },
        after: { value: 'root' }
    });
    const items = listRollbacks();
    await undoRollback(items[0].id);
    const after = loadPermissionProfile();
    assert.equal(after.filesystemScope, before.filesystemScope);

    clearRollbacks();
});

test('undoRollback throws for unknown id', async () => {
    await assert.rejects(() => undoRollback('nonexistent-id'), /Rollback item not found/);
});

test('undoRollback returns alreadyUndone on second call', async () => {
    clearRollbacks();
    const dir = makeTempDir();
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'a');
    fs.writeFileSync(file, 'b');
    const rec = recordRollback({ type: 'restore_file', target: file, before: { content: 'a' }, after: { content: 'b' } });
    const first = await undoRollback(rec.id);
    assert.equal(first.status, 'undone');
    const second = await undoRollback(rec.id);
    assert.equal(second.alreadyUndone, true);

    fs.rmSync(dir, { recursive: true });
    clearRollbacks();
});

test('listRollbacks respects limit', () => {
    clearRollbacks();
    for (let i = 0; i < 5; i++) {
        recordRollback({ type: 'delete_created_file', target: `/tmp/r-${i}`, before: null, after: {} });
    }
    assert.equal(listRollbacks({ limit: 100 }).length, 5);
    assert.equal(listRollbacks({ limit: 2 }).length, 2);
    clearRollbacks();
});

// ----- filter coverage (Observability Task 5) -----

test('status filter narrows to available only', () => {
    clearRollbacks();
    recordRollback({ type: 'delete_created_file', target: '/tmp/s1', before: null, after: {} });
    recordRollback({ type: 'delete_created_file', target: '/tmp/s2', before: null, after: {} });
    const available = listRollbacks({ status: 'available' });
    assert.equal(available.length, 2);
    assert.ok(available.every(i => i.status === 'available'));
});

test('type filter narrows to a single rollback type', () => {
    clearRollbacks();
    recordRollback({ type: 'restore_file', target: '/tmp/t1', before: null, after: {} });
    recordRollback({ type: 'delete_created_file', target: '/tmp/t2', before: null, after: {} });
    recordRollback({ type: 'restore_setting', target: 'security.foo', before: null, after: {} });
    const restoreFile = listRollbacks({ type: 'restore_file' });
    assert.equal(restoreFile.length, 1);
    assert.equal(restoreFile[0].type, 'restore_file');
});

test('summary mode returns aggregate counts', () => {
    clearRollbacks();
    recordRollback({ type: 'restore_file', target: '/tmp/s1', before: null, after: {} });
    recordRollback({ type: 'restore_file', target: '/tmp/s2', before: null, after: {} });
    recordRollback({ type: 'delete_created_file', target: '/tmp/s3', before: null, after: {} });
    const s = listRollbacks({ summary: true });
    assert.equal(s.total, 3);
    assert.equal(s.available, 3);
    assert.equal(s.undone, 0);
    assert.equal(s.failed, 0);
    assert.equal(s.byType['restore_file'], 2);
    assert.equal(s.byType['delete_created_file'], 1);
});

test('combined status + type filters compose', () => {
    clearRollbacks();
    recordRollback({ type: 'restore_file', target: '/tmp/c1', before: null, after: {} });
    recordRollback({ type: 'delete_created_file', target: '/tmp/c2', before: null, after: {} });
    const f = listRollbacks({ status: 'available', type: 'restore_file' });
    assert.equal(f.length, 1);
    assert.equal(f[0].type, 'restore_file');
});

test('records are FIFO-capped at 100', () => {
    clearRollbacks();
    for (let i = 0; i < 110; i++) {
        recordRollback({ type: 'delete_created_file', target: `/tmp/r-${i}`, before: null, after: {} });
    }
    const items = listRollbacks({ limit: 200 });
    assert.equal(items.length, 100);
    // Oldest is i=10, newest is i=109
    assert.equal(items[0].target, '/tmp/r-10');
    assert.equal(items[99].target, '/tmp/r-109');
    clearRollbacks();
});
