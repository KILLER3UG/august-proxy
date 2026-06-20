const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { Writable } = require('stream');
const path = require('path');

const { dataPath } = require('../lib/data-paths');
const { clearAuditLog, appendAuditEntry } = require('../services/audit/audit-log');
const { clearRollbacks, recordRollback } = require('../services/rollback/rollback-store');
const { handleObservabilityRoute, _internals } = require('../services/observability/observability-routes');

class MockHttpRes extends Writable {
    constructor() {
        super({});
        this.headers = {};
        this.statusCode = 200;
        this._chunks = [];
        this._ended = false;
    }
    _write(chunk, _enc, cb) {
        if (this._ended) return cb(new Error('write after end'));
        this._chunks.push(Buffer.from(chunk));
        cb();
    }
    writeHead(code, h) { this.statusCode = code; if (h) Object.assign(this.headers, h); return this; }
    end(s) {
        if (s !== undefined) this._chunks.push(Buffer.from(s));
        this._ended = true;
        this.body = Buffer.concat(this._chunks).toString('utf8');
        this.size = this._chunks.reduce((n, c) => n + c.length, 0);
        this.emit('finish');
        return this;
    }
}

function makeRes() {
    return new MockHttpRes();
}

function sendJson(res, payload) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return true;
}
function sendError(res, err, code) {
    if (!res) throw err;
    res.writeHead(code || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message || String(err) }));
    return true;
}

// ---------------------------------------------------------------------------
// audit filter
// ---------------------------------------------------------------------------

test('GET /ui/audit?category= filters by category', async () => {
    clearAuditLog();
    appendAuditEntry({ action: 'a.x', category: 'system' });
    appendAuditEntry({ action: 'b.y', category: 'ui' });
    const req = { method: 'GET', url: '/ui/audit?category=system&limit=10' };
    const res = makeRes();
    const handled = await handleObservabilityRoute(req, res, { url: req.url, method: req.method, sendJson, sendError });
    assert.equal(handled, true);
    const json = JSON.parse(res.body);
    assert.equal(json.total, 1);
    assert.equal(json.entries[0].category, 'system');
});

test('GET /ui/audit?summary=1 returns aggregate counts', async () => {
    clearAuditLog();
    appendAuditEntry({ action: 'a.x', category: 'system', result: 'ok', actor: 'august' });
    appendAuditEntry({ action: 'b.y', category: 'ui',     result: 'ok', actor: 'august' });
    const req = { method: 'GET', url: '/ui/audit?summary=1' };
    const res = makeRes();
    await handleObservabilityRoute(req, res, { url: req.url, method: req.method, sendJson, sendError });
    const json = JSON.parse(res.body);
    assert.equal(json.count, 2);
    assert.equal(json.byCategory.system, 1);
    assert.equal(json.byCategory.ui, 1);
    assert.equal(json.byActor.august, 2);
});

test('GET /ui/audit?summary=1 with empty log returns zeros and no byCategory keys', async () => {
    clearAuditLog();
    const req = { method: 'GET', url: '/ui/audit?summary=1' };
    const res = makeRes();
    await handleObservabilityRoute(req, res, { url: req.url, method: req.method, sendJson, sendError });
    const json = JSON.parse(res.body);
    assert.equal(json.count, 0);
    assert.deepEqual(json.byCategory, {});
});

// ---------------------------------------------------------------------------
// rollback filter
// ---------------------------------------------------------------------------

test('GET /ui/rollback?status=available filters by status', async () => {
    clearRollbacks();
    recordRollback({ type: 'delete_created_file', target: '/tmp/r1', before: null, after: {} });
    const req = { method: 'GET', url: '/ui/rollback?status=available' };
    const res = makeRes();
    const handled = await handleObservabilityRoute(req, res, { url: req.url, method: req.method, sendJson, sendError });
    assert.equal(handled, true);
    const json = JSON.parse(res.body);
    assert.equal(json.total, 1);
    assert.equal(json.items[0].status, 'available');
});

test('GET /ui/rollback?summary=1 returns counts', async () => {
    clearRollbacks();
    recordRollback({ type: 'delete_created_file', target: '/tmp/r1', before: null, after: {} });
    recordRollback({ type: 'delete_created_file', target: '/tmp/r2', before: null, after: {} });
    const req = { method: 'GET', url: '/ui/rollback?summary=1' };
    const res = makeRes();
    await handleObservabilityRoute(req, res, { url: req.url, method: req.method, sendJson, sendError });
    const json = JSON.parse(res.body);
    assert.equal(json.total, 2);
    assert.equal(json.available, 2);
    assert.equal(json.undone, 0);
});

// ---------------------------------------------------------------------------
// observations list + file
// ---------------------------------------------------------------------------

test('listObservationsSync returns observations joined with audit entries', () => {
    const dir = dataPath('computer-observations');
    fs.mkdirSync(dir, { recursive: true });
    const id = '11111111-2222-3333-4444-555555555555';
    const file = path.join(dir, `${id}.png`);
    fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    clearAuditLog();
    appendAuditEntry({
        action: 'computer.post_observation',
        category: 'computer',
        target: 'computer_type',
        postObservation: {
            screenshotPath: file,
            capturedAt: new Date().toISOString(),
            focusedApp: 'notepad.exe'
        }
    });
    const list = _internals.listObservationsSync({ limit: 5 });
    assert.ok(list.length >= 1);
    const found = list.find(o => o.id === id);
    assert.ok(found);
    assert.equal(found.focusedApp, 'notepad.exe');
    fs.unlinkSync(file);
    clearAuditLog();
});

test('listObservationsSync returns [] when audit log is empty', () => {
    clearAuditLog();
    const list = _internals.listObservationsSync({ limit: 5 });
    assert.deepEqual(list, []);
});

test('listObservationsSync respects limit', () => {
    const dir = dataPath('computer-observations');
    fs.mkdirSync(dir, { recursive: true });
    clearAuditLog();
    const ids = [];
    for (let i = 0; i < 5; i++) {
        const id = `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`;
        ids.push(id);
        const file = path.join(dir, `${id}.png`);
        fs.writeFileSync(file, Buffer.from([0x89, 0x50]));
        appendAuditEntry({
            action: 'computer.post_observation',
            category: 'computer',
            target: 'computer_type',
            postObservation: { screenshotPath: file, capturedAt: new Date().toISOString() }
        });
    }
    const list = _internals.listObservationsSync({ limit: 3 });
    assert.equal(list.length, 3);
    for (const id of ids) {
        try { fs.unlinkSync(path.join(dir, `${id}.png`)); } catch (_) {}
    }
    clearAuditLog();
});

test('GET /ui/observations?limit= returns list with joined audit', async () => {
    const dir = dataPath('computer-observations');
    fs.mkdirSync(dir, { recursive: true });
    const id = '99999999-2222-3333-4444-555555555555';
    const file = path.join(dir, `${id}.png`);
    fs.writeFileSync(file, Buffer.from([0x89, 0x50]));
    clearAuditLog();
    appendAuditEntry({
        action: 'computer.post_observation',
        category: 'computer',
        target: 'computer_type',
        postObservation: { screenshotPath: file, capturedAt: new Date().toISOString() }
    });
    const req = { method: 'GET', url: '/ui/observations?limit=5' };
    const res = makeRes();
    const handled = await handleObservabilityRoute(req, res, { url: req.url, method: req.method, sendJson, sendError });
    assert.equal(handled, true);
    const json = JSON.parse(res.body);
    assert.ok(json.items.find(o => o.id === id));
    fs.unlinkSync(file);
    clearAuditLog();
});

test('GET /ui/observations/bad-id rejects non-UUID with 400', async () => {
    const req = { method: 'GET', url: '/ui/observations/not-a-uuid.png' };
    const res = makeRes();
    const handled = await handleObservabilityRoute(req, res, { url: req.url, method: req.method, sendJson, sendError });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
});

test('GET /ui/observations/<uuid>.png serves PNG content-type', async () => {
    const dir = dataPath('computer-observations');
    fs.mkdirSync(dir, { recursive: true });
    const id = '77777777-2222-3333-4444-555555555555';
    const file = path.join(dir, `${id}.png`);
    const payload = Buffer.from('89504e470d0a1a0a', 'hex');
    fs.writeFileSync(file, payload);
    const req = { method: 'GET', url: `/ui/observations/${id}.png` };
    const res = makeRes();
    const handled = await handleObservabilityRoute(req, res, { url: req.url, method: req.method, sendJson, sendError });
    // Wait for the pipe to finish streaming the file
    await new Promise(resolve => res.on('finish', resolve));
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
    assert.ok(res.headers['Cache-Control'].includes('private'));
    assert.equal(res.size, payload.length);
    assert.equal(res.body, payload.toString('utf8'));
    fs.unlinkSync(file);
});

test('GET /ui/observations/<missing>.png returns 404', async () => {
    const id = '66666666-2222-3333-4444-555555555555';
    const req = { method: 'GET', url: `/ui/observations/${id}.png` };
    const res = makeRes();
    const handled = await handleObservabilityRoute(req, res, { url: req.url, method: req.method, sendJson, sendError });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 404);
});

test('GET /ui/observations/<bad>.png with traversal-shaped id is rejected by regex', async () => {
    const req = { method: 'GET', url: '/ui/observations/..%2F..%2Fconfig.png' };
    const res = makeRes();
    await handleObservabilityRoute(req, res, { url: req.url, method: req.method, sendJson, sendError });
    assert.equal(res.statusCode, 400);
});

// ---------------------------------------------------------------------------
// security write-back + overview
// ---------------------------------------------------------------------------

test('PUT /ui/security body-validation: helper applies valid input', () => {
    const { saveComputerRoots, loadPermissionProfile } = require('../services/permissions/permission-profiles');
    const before = loadPermissionProfile();
    saveComputerRoots({ filesystemScope: 'root' });
    const after = loadPermissionProfile();
    assert.equal(after.filesystemScope, 'root');
    saveComputerRoots({ filesystemScope: before.filesystemScope });
});

test('GET /ui/observability/overview returns combined payload', async () => {
    clearAuditLog();
    clearRollbacks();
    appendAuditEntry({ action: 'a.x', category: 'system' });
    const req = { method: 'GET', url: '/ui/observability/overview?range=30d' };
    const res = makeRes();
    const handled = await handleObservabilityRoute(req, res, { url: req.url, method: req.method, sendJson, sendError });
    assert.equal(handled, true);
    const json = JSON.parse(res.body);
    assert.equal(json.range, '30d');
    assert.ok(json.audit);
    assert.ok(json.rollback);
    assert.ok(json.appPolicy);
    assert.equal(json.appPolicy.defaultPolicy, 'ask');
    assert.ok(json.hostAgent);
});

test('unhandled URL returns null from the dispatcher', async () => {
    const req = { method: 'GET', url: '/not-our-route' };
    const res = makeRes();
    const handled = await handleObservabilityRoute(req, res, { url: req.url, method: req.method, sendJson, sendError });
    assert.equal(handled, null);
});
