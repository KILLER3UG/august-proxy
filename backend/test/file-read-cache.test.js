const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const fileReadCache = require('../services/tools/file-read-cache');
const fileHistory = require('../services/audit/file-history');

function tmpFile(suffix = '.txt') {
    return path.join(os.tmpdir(), `august_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${suffix}`);
}

test('recordRead caches content hash and detectStale returns no_cache on first check', () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'hello world', 'utf8');
    fileReadCache.clear();
    fileReadCache.recordRead(file, 'hello world');
    const result = fileReadCache.detectStale(file);
    assert.equal(result.stale, false);
    assert.equal(result.reason, 'unchanged');
    fs.unlinkSync(file);
});

test('detectStale catches mtime change', () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'hello world', 'utf8');
    fileReadCache.clear();
    fileReadCache.recordRead(file, 'hello world');
    // Bump mtime without changing content
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    const result = fileReadCache.detectStale(file);
    assert.equal(result.stale, true);
    assert.equal(result.reason, 'mtime_changed');
    fs.unlinkSync(file);
});

test('detectStale catches content change', () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'hello world', 'utf8');
    fileReadCache.clear();
    fileReadCache.recordRead(file, 'hello world');
    // Overwrite content (size and mtime will both differ; either flag is fine)
    fs.writeFileSync(file, 'completely different content here', 'utf8');
    const result = fileReadCache.detectStale(file);
    assert.equal(result.stale, true);
    assert.ok(['size_changed', 'mtime_changed'].includes(result.reason));
    fs.unlinkSync(file);
});

test('invalidate drops the cached entry', () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'content A', 'utf8');
    fileReadCache.clear();
    fileReadCache.recordRead(file, 'content A');
    fileReadCache.invalidate(file);
    // After invalidation, a fresh detectStale returns no_cache
    const result = fileReadCache.detectStale(file);
    assert.equal(result.stale, false);
    assert.equal(result.reason, 'no_cache');
    fs.unlinkSync(file);
});

test('detectStale returns file_missing when path is gone', () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'some content', 'utf8');
    fileReadCache.clear();
    fileReadCache.recordRead(file, 'some content');
    fs.unlinkSync(file);
    const result = fileReadCache.detectStale(file);
    assert.equal(result.stale, true);
    assert.equal(result.reason, 'file_missing');
});

test('file-history returns newest-first audit entries for a path', () => {
    const file = tmpFile();
    const audit = require('../services/audit/audit-log');
    fs.writeFileSync(file, 'A', 'utf8');
    audit.appendAuditEntry({ actor: 'user', action: 'write', target: file, result: 'ok', at: '2024-01-01T00:00:01.000Z' });
    audit.appendAuditEntry({ actor: 'user', action: 'write', target: file, result: 'ok', at: '2024-01-02T00:00:01.000Z' });
    audit.appendAuditEntry({ actor: 'user', action: 'write', target: file, result: 'ok', at: '2024-01-03T00:00:01.000Z' });
    const history = fileHistory.getFileHistory(file, { limit: 10 });
    assert.ok(history.length >= 3, 'expected at least 3 entries');
    const dates = history.map(h => h.at).filter(Boolean);
    for (let i = 1; i < dates.length; i++) {
        assert.ok(new Date(dates[i - 1]) >= new Date(dates[i]), 'history must be newest first');
    }
    fs.unlinkSync(file);
});

test('file-history countFileHistory matches entry count for a path', () => {
    const file = tmpFile();
    const audit = require('../services/audit/audit-log');
    fs.writeFileSync(file, 'A', 'utf8');
    const before = fileHistory.countFileHistory(file);
    audit.appendAuditEntry({ actor: 'user', action: 'write', target: file, result: 'ok' });
    audit.appendAuditEntry({ actor: 'user', action: 'write', target: file, result: 'ok' });
    const after = fileHistory.countFileHistory(file);
    assert.equal(after, before + 2);
    fs.unlinkSync(file);
});