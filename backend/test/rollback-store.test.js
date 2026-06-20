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
    assert.ok(TYPES.has('restore_array_entry'));
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
    const rec = recordRollback({
        type: 'restore_setting',
        target: 'security.filesystemScope',
        before: { value: before.filesystemScope },
        after: { value: 'root' }
    });
    await undoRollback(rec.id);
    const after = loadPermissionProfile();
    assert.equal(after.filesystemScope, before.filesystemScope);
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
    const tag = `unittest-limit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < 5; i++) {
        recordRollback({ type: 'delete_created_file', target: `${tag}/r-${i}`, before: null, after: {} });
    }
    const all = listRollbacks({ limit: 100 }).filter(it => it.target && it.target.startsWith(`${tag}/`));
    assert.equal(all.length, 5);
    const capped = listRollbacks({ limit: 2 }).filter(it => it.target && it.target.startsWith(`${tag}/`));
    assert.equal(capped.length, 2);
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

// ----- restore_array_entry: array-backed config rollback -----

test('restore_array_entry: undo removes a freshly added entry', async () => {
    clearRollbacks();
    const { getConfig, saveConfig } = require('../lib/config');
    const cfg = getConfig();
    const original = Array.isArray(cfg.modelAliases) ? [...cfg.modelAliases] : [];
    cfg.modelAliases = [...original, { alias: 'unit-test-add', targetModel: 'gpt-4', targetProvider: null }];
    saveConfig(cfg);

    const rec = recordRollback({
        type: 'restore_array_entry',
        target: 'unit-test-add',
        meta: { arrayKey: 'modelAliases', matchField: 'alias', entryKey: 'unit-test-add' },
        before: { value: null },
        after: { value: { alias: 'unit-test-add', targetModel: 'gpt-4', targetProvider: null } }
    });

    await undoRollback(rec.id);

    const after = getConfig();
    const present = (after.modelAliases || []).some(a => a.alias === 'unit-test-add');
    assert.equal(present, false, 'undo should remove the added alias');

    // Restore prior state
    cfg.modelAliases = original;
    saveConfig(cfg);
    clearRollbacks();
});

test('restore_array_entry: undo re-inserts a previously deleted entry', async () => {
    clearRollbacks();
    const { getConfig, saveConfig } = require('../lib/config');
    const cfg = getConfig();
    const prior = { alias: 'unit-test-del', targetModel: 'gpt-4', targetProvider: 'openai' };
    const original = Array.isArray(cfg.modelAliases) ? [...cfg.modelAliases] : [];
    cfg.modelAliases = [...original.filter(a => a.alias !== 'unit-test-del')];
    saveConfig(cfg);

    const rec = recordRollback({
        type: 'restore_array_entry',
        target: 'unit-test-del',
        meta: { arrayKey: 'modelAliases', matchField: 'alias', entryKey: 'unit-test-del' },
        before: { value: prior },
        after: { value: null }
    });

    await undoRollback(rec.id);

    const after = getConfig();
    const present = (after.modelAliases || []).find(a => a.alias === 'unit-test-del');
    assert.ok(present, 'undo should re-insert the deleted alias');
    assert.equal(present.targetModel, 'gpt-4');

    // Restore prior state
    cfg.modelAliases = original;
    saveConfig(cfg);
    clearRollbacks();
});

test('restore_array_entry: undo restores a previously updated entry', async () => {
    clearRollbacks();
    const { getConfig, saveConfig } = require('../lib/config');
    const cfg = getConfig();
    const before = { alias: 'unit-test-update', targetModel: 'gpt-4', targetProvider: 'openai' };
    const after = { alias: 'unit-test-update', targetModel: 'claude-opus-4-6', targetProvider: 'anthropic' };
    const original = Array.isArray(cfg.modelAliases) ? [...cfg.modelAliases] : [];
    cfg.modelAliases = [...original.filter(a => a.alias !== 'unit-test-update'), after];
    saveConfig(cfg);

    const rec = recordRollback({
        type: 'restore_array_entry',
        target: 'unit-test-update',
        meta: { arrayKey: 'modelAliases', matchField: 'alias', entryKey: 'unit-test-update' },
        before: { value: before },
        after: { value: after }
    });

    await undoRollback(rec.id);

    const restored = getConfig().modelAliases.find(a => a.alias === 'unit-test-update');
    assert.ok(restored, 'undo should restore the updated alias');
    assert.equal(restored.targetModel, 'gpt-4');
    assert.equal(restored.targetProvider, 'openai');

    // Restore prior state
    cfg.modelAliases = original;
    saveConfig(cfg);
    clearRollbacks();
});

test('restore_array_entry: throws when meta is missing required fields', async () => {
    clearRollbacks();
    const rec = recordRollback({
        type: 'restore_array_entry',
        target: 'x',
        meta: { arrayKey: 'modelAliases' }, // missing matchField, entryKey
        before: { value: null },
        after: { value: null }
    });
    await assert.rejects(() => undoRollback(rec.id), /meta\./);
    clearRollbacks();
});
