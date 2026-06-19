const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
    getSystemToolDefinitions,
    executeSystemTool
} = require('../services/system/system-tools');

const { clearAuditLog } = require('../services/audit/audit-log');
const { clearRollbacks } = require('../services/rollback/rollback-store');
const { saveComputerRoots, loadPermissionProfile } = require('../services/permissions/permission-profiles');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sys-test-'));
}

function resetSecurityTo(scope = 'allowlist') {
    saveComputerRoots({ filesystemScope: scope, allowedRoots: [] });
}

test.beforeEach(() => {
    clearAuditLog();
    clearRollbacks();
    resetSecurityTo('allowlist');
});

test('getSystemToolDefinitions returns all 11 expected tools', () => {
    const defs = getSystemToolDefinitions();
    const names = defs.map(d => d.function.name).sort();
    assert.deepEqual(names, [
        'august__filesystem_copy',
        'august__filesystem_delete',
        'august__filesystem_list',
        'august__filesystem_move',
        'august__filesystem_read',
        'august__filesystem_write',
        'august__system_env',
        'august__system_exec',
        'august__system_info',
        'august__system_network',
        'august__system_process'
    ]);
});

test('filesystem_list works for an allowed temp directory', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'sub'));
    const r = await executeSystemTool('august__filesystem_list', { path: dir });
    assert.equal(r.ok, true);
    assert.equal(r.result.path, path.resolve(dir));
    assert.equal(r.result.entries.length, 2);
    fs.rmSync(dir, { recursive: true });
});

test('filesystem_write previews without confirmed', async () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'new.txt');
    const r = await executeSystemTool('august__filesystem_write', { path: target, content: 'hello' });
    assert.equal(r.ok, false);
    assert.equal(r.requiresApproval, true);
    assert.ok(r.preview);
    // File should not exist
    assert.ok(!fs.existsSync(target));
    fs.rmSync(dir, { recursive: true });
});

test('filesystem_write with approvedMutation creates file + audit + rollback', async () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'doc.txt');
    const r = await executeSystemTool('august__filesystem_write', { path: target, content: 'hello world' }, { approvedMutation: true });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello world');
    assert.ok(r.auditId, 'audit entry written');
    assert.ok(r.rollbackId, 'rollback entry recorded');
    fs.rmSync(dir, { recursive: true });
});

test('filesystem_write with confirmed:true (direct-tool fallback) also works', async () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'doc.txt');
    const r = await executeSystemTool('august__filesystem_write', { path: target, content: 'x', confirmed: true });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'x');
    fs.rmSync(dir, { recursive: true });
});

test('filesystem_read returns content of an allowed file', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'abc');
    const r = await executeSystemTool('august__filesystem_read', { path: file });
    assert.equal(r.ok, true);
    assert.equal(r.result.content, 'abc');
    fs.rmSync(dir, { recursive: true });
});

test('filesystem_delete with recursive:true writes a critical audit entry', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
    const r = await executeSystemTool('august__filesystem_delete', { path: dir, recursive: true, confirmed: true });
    assert.equal(r.ok, true);
    // Audit log should contain a critical entry
    const { readAuditEntries } = require('../services/audit/audit-log');
    const entries = readAuditEntries({ limit: 50 });
    const last = entries[entries.length - 1];
    assert.equal(last.action, 'filesystem.delete');
    assert.equal(last.critical, true);
});

test('filesystem_move with approvedMutation moves file and records rollback', async () => {
    const dir = makeTempDir();
    const src = path.join(dir, 'src.txt');
    const dest = path.join(dir, 'sub', 'dest.txt');
    fs.writeFileSync(src, 'content');
    const r = await executeSystemTool('august__filesystem_move', { path: src, destination: dest }, { approvedMutation: true });
    assert.equal(r.ok, true);
    assert.ok(!fs.existsSync(src));
    assert.equal(fs.readFileSync(dest, 'utf8'), 'content');
    assert.ok(r.rollbackId);
    fs.rmSync(dir, { recursive: true });
});

test('system_info returns host summary fields', async () => {
    const r = await executeSystemTool('august__system_info', {});
    assert.equal(r.ok, true);
    assert.equal(typeof r.result.platform, 'string');
    assert.equal(typeof r.result.arch, 'string');
    assert.ok(Number.isInteger(r.result.totalmem));
    assert.ok(Number.isInteger(r.result.freemem));
});

test('system_network GET works against a local http server and redacts Authorization', async () => {
    const server = http.createServer((req, res) => {
        const auth = req.headers['authorization'];
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Set-Cookie', 'session=secret123; Path=/');
        res.end(`Hello. You sent auth=${auth || 'none'}\n`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        const r = await executeSystemTool('august__system_network', {
            url: `http://127.0.0.1:${port}/`,
            method: 'GET',
            headers: { Authorization: 'Bearer secret-token-xyz' }
        });
        assert.equal(r.ok, true);
        // Sensitive response header redacted
        assert.equal(r.result.headers['set-cookie'], '***REDACTED***');
        // Sensitive request header in inputSummary redacted
        const { readAuditEntries } = require('../services/audit/audit-log');
        const entries = readAuditEntries({ limit: 5 });
        const last = entries[entries.length - 1];
        assert.equal(last.action, 'system.network');
        const inSum = JSON.stringify(last.inputSummary || {});
        assert.doesNotMatch(inSum, /secret-token-xyz/);
    } finally {
        server.close();
    }
});

test('system_network non-GET requires approval', async () => {
    const r = await executeSystemTool('august__system_network', {
        url: 'http://127.0.0.1:9999/api',
        method: 'POST',
        body: '{"x":1}'
    });
    assert.equal(r.ok, false);
    assert.equal(r.requiresApproval, true);
});

test('system_process list is read-only (no approval required)', async () => {
    const r = await executeSystemTool('august__system_process', { action: 'list' });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.result.processes));
});

test('system_process start requires approval and registers pid', async () => {
    const r = await executeSystemTool('august__system_process', { action: 'start', command: 'node -e "setTimeout(()=>{},60000)"' });
    assert.equal(r.ok, false);
    assert.equal(r.requiresApproval, true);
    const r2 = await executeSystemTool('august__system_process', { action: 'start', command: 'node -e "setTimeout(()=>{},60000)"' }, { approvedMutation: true });
    assert.equal(r2.ok, true);
    assert.ok(r2.result.pid);
    // Stop the spawned process
    await executeSystemTool('august__system_process', { action: 'stop', pid: r2.result.pid, ownedByAugust: true, confirmed: true });
});

test('system_env get is read-only', async () => {
    const r = await executeSystemTool('system_env'.replace('system_', 'august__system_'), { action: 'get', name: 'PATH' });
    assert.equal(r.ok, true);
    assert.ok(r.result);
});

test('system_env set requires approval and is critical', async () => {
    const r = await executeSystemTool('august__system_env', { action: 'set', name: 'AUGUST_TEST_ENV', value: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.requiresApproval, true);
    assert.equal(r.critical, true);
});

test('system_exec with path outside allowed roots is blocked', async () => {
    resetSecurityTo('allowlist');
    const r = await executeSystemTool('august__system_exec', {
        command: 'cat /etc/passwd',
        confirmed: true
    }, { approvedMutation: true });
    assert.equal(r.ok, false);
    assert.equal(r.error && /Permission/.test(r.error), true);
});

test('system_exec benign command works', async () => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'echo hello-from-test' : 'echo hello-from-test';
    const r = await executeSystemTool('august__system_exec', { command: cmd, confirmed: true }, { approvedMutation: true });
    assert.equal(r.ok, true);
    assert.match(r.result.stdout, /hello-from-test/);
});
