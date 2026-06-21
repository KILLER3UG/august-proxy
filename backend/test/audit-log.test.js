const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    appendAuditEntry,
    readAuditEntries,
    clearAuditLog,
    AUDIT_LOG_PATH
} = require('../services/audit/audit-log');

test('appendAuditEntry persists and readAuditEntries returns entries', () => {
    clearAuditLog();
    const e1 = appendAuditEntry({
        actor: 'august',
        action: 'test.ping',
        target: 'unit-test',
        result: 'ok'
    });
    assert.ok(e1.id, 'entry should have an id');
    assert.ok(e1.at, 'entry should have an at timestamp');
    assert.equal(e1.action, 'test.ping');

    const e2 = appendAuditEntry({
        actor: 'august',
        action: 'test.pong',
        target: 'unit-test',
        result: 'ok'
    });
    const entries = readAuditEntries({ limit: 50 });
    assert.equal(entries.length, 2);
    assert.equal(entries[1].id, e2.id);
});

test('redacts sk-... secrets in inputSummary', () => {
    clearAuditLog();
    appendAuditEntry({
        action: 'secrets.test',
        inputSummary: 'My key is sk-abcdef1234567890xyz in this string'
    });
    const entries = readAuditEntries({ limit: 10 });
    assert.match(entries[0].inputSummary, /sk-\*\*\*REDACTED\*\*\*/);
    assert.doesNotMatch(entries[0].inputSummary, /sk-abcdef1234567890/);
});

test('redacts Bearer tokens in inputSummary', () => {
    clearAuditLog();
    appendAuditEntry({
        action: 'token.test',
        inputSummary: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature" https://api.example.com'
    });
    const entries = readAuditEntries({ limit: 10 });
    // Either the Authorization header or the Bearer substring must be redacted.
    // We don't assert which pattern wins first; we just assert no token leaks.
    assert.doesNotMatch(entries[0].inputSummary, /eyJhbGciOiJIUzI1NiJ9/);
    assert.match(entries[0].inputSummary, /REDACTED/);
});

test('redacts Authorization header and API_KEY in free text', () => {
    clearAuditLog();
    appendAuditEntry({
        action: 'header.test',
        inputSummary: 'Header was Authorization: secretvalue123 and env API_KEY=abc123def456'
    });
    const entries = readAuditEntries({ limit: 10 });
    assert.match(entries[0].inputSummary, /Authorization: \*\*\*REDACTED\*\*\*/);
    assert.match(entries[0].inputSummary, /API_KEY=\*\*\*REDACTED\*\*\*/);
    assert.doesNotMatch(entries[0].inputSummary, /secretvalue123/);
    assert.doesNotMatch(entries[0].inputSummary, /abc123def456/);
});

test('redacts apiKey field in structured inputSummary', () => {
    clearAuditLog();
    appendAuditEntry({
        action: 'structured.test',
        inputSummary: { apiKey: 'sk-supersecret123', name: 'demo' }
    });
    const entries = readAuditEntries({ limit: 10 });
    const s = entries[0].inputSummary;
    assert.equal(s.name, 'demo', 'non-sensitive keys should be preserved');
    assert.doesNotMatch(JSON.stringify(s), /supersecret123/);
});

test('preserves action, target, at, result fields', () => {
    clearAuditLog();
    const e = appendAuditEntry({
        action: 'preserve.test',
        target: 'unit-test-target',
        result: 'ok'
    });
    assert.equal(e.action, 'preserve.test');
    assert.equal(e.target, 'unit-test-target');
    assert.match(e.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(e.result, 'ok');
});

test('limit parameter caps returned entries', () => {
    clearAuditLog();
    for (let i = 0; i < 5; i++) {
        appendAuditEntry({ action: `bulk.${i}` });
    }
    const all = readAuditEntries({ limit: 100 });
    assert.equal(all.length, 5);
    const capped = readAuditEntries({ limit: 2 });
    assert.equal(capped.length, 2);
    // Last two
    assert.equal(capped[0].action, 'bulk.3');
    assert.equal(capped[1].action, 'bulk.4');
});

test("clearAuditLog removes this worker's entries", () => {
    clearAuditLog();
    appendAuditEntry({ action: 'transient.test' });
    assert.ok(fs.existsSync(AUDIT_LOG_PATH));
    clearAuditLog();
    const remaining = readAuditEntries({ limit: 10 });
    assert.equal(remaining.length, 0, 'no entries from this worker should remain after clearAuditLog');
});

// ----- filter coverage (Observability Task 5) -----

test('category filter narrows results', () => {
    clearAuditLog();
    // Use a unique action prefix so this test's entries can be told apart
    // from other workers' entries in the shared audit log under parallel
    // `node --test` runs. The filter asserts *our* two 'system' entries
    // survive, not an absolute count (which is racy across workers).
    appendAuditEntry({ action: 'unit-test-catfilter.a.x', category: 'system' });
    appendAuditEntry({ action: 'unit-test-catfilter.b.y', category: 'ui' });
    appendAuditEntry({ action: 'unit-test-catfilter.c.z', category: 'system' });
    const filtered = readAuditEntries({ category: 'system' }).filter(
        e => e.action && e.action.startsWith('unit-test-catfilter.')
    );
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every(e => e.category === 'system'));
});

test('actor filter narrows results', () => {
    clearAuditLog();
    appendAuditEntry({ action: 'a.x', actor: 'august' });
    appendAuditEntry({ action: 'b.y', actor: 'user' });
    const filtered = readAuditEntries({ actor: 'user' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].actor, 'user');
});

test('action filter narrows results', () => {
    clearAuditLog();
    appendAuditEntry({ action: 'august__bash' });
    appendAuditEntry({ action: 'august__write_file' });
    const filtered = readAuditEntries({ action: 'august__bash' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].action, 'august__bash');
});

test('since filter excludes older entries', () => {
    const tag = `unittest-since-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    appendAuditEntry({ action: `${tag}.a.x`, at: '2024-01-01T00:00:00.000Z' });
    appendAuditEntry({ action: `${tag}.b.y`, at: '2025-06-01T00:00:00.000Z' });
    const filtered = readAuditEntries({ since: '2025-01-01T00:00:00.000Z' })
        .filter(e => e.action && e.action.startsWith(`${tag}.`));
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].action, `${tag}.b.y`);
});

test('until filter excludes newer entries', () => {
    const tag = `unittest-until-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    appendAuditEntry({ action: `${tag}.a.x`, at: '2024-01-01T00:00:00.000Z' });
    appendAuditEntry({ action: `${tag}.b.y`, at: '2025-06-01T00:00:00.000Z' });
    const filtered = readAuditEntries({ until: '2024-12-31T23:59:59.000Z' })
        .filter(e => e.action && e.action.startsWith(`${tag}.`));
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].action, `${tag}.a.x`);
});

test('summary mode returns aggregate counts', () => {
    clearAuditLog();
    appendAuditEntry({ action: 'a.x', category: 'system', result: 'ok', actor: 'august', critical: true });
    appendAuditEntry({ action: 'b.y', category: 'ui', result: 'ok', actor: 'august', critical: false });
    appendAuditEntry({ action: 'c.z', category: 'ui', result: 'error', actor: 'user', critical: null });
    const s = readAuditEntries({ summary: true });
    assert.equal(s.count, 3);
    assert.equal(s.byCategory.system, 1);
    assert.equal(s.byCategory.ui, 2);
    assert.equal(s.byResult.ok, 2);
    assert.equal(s.byResult.error, 1);
    assert.equal(s.byActor.august, 2);
    assert.equal(s.byActor.user, 1);
    assert.equal(s.byCritical.true, 1);
    assert.equal(s.byCritical.false, 1);
    assert.equal(s.byCritical.null, 1);
});

test('combined filters compose', () => {
    clearAuditLog();
    appendAuditEntry({ action: 'a.x', category: 'system', actor: 'august' });
    appendAuditEntry({ action: 'b.y', category: 'system', actor: 'user' });
    appendAuditEntry({ action: 'c.z', category: 'ui',     actor: 'august' });
    const filtered = readAuditEntries({ category: 'system', actor: 'august' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].action, 'a.x');
});

test('structured fields without sensitive keys preserve object shape on round-trip', () => {
    clearAuditLog();
    // postObservation, inputSummary (object), and other structured fields
    // should round-trip as objects, not as JSON strings. The prior redactValue
    // fell back to JSON.stringify for objects without a sensitive key, which
    // broke consumers like listObservationsSync that read .screenshotPath.
    appendAuditEntry({
        action: 'computer.post_observation',
        category: 'computer',
        target: 'computer_type',
        postObservation: {
            screenshotPath: 'C:/tmp/obs.png',
            capturedAt: '2026-06-21T00:00:00.000Z',
            focusedApp: 'notepad.exe',
        },
        inputSummary: {
            step: 'click',
            coordinates: { x: 100, y: 200 },
            notes: 'plain text',
        },
    });
    const entries = readAuditEntries({ action: 'computer.post_observation' });
    assert.equal(entries.length, 1);
    // postObservation must be an object, not a stringified JSON.
    assert.equal(typeof entries[0].postObservation, 'object');
    assert.ok(entries[0].postObservation);
    assert.equal(entries[0].postObservation.screenshotPath, 'C:/tmp/obs.png');
    assert.equal(entries[0].postObservation.focusedApp, 'notepad.exe');
    // inputSummary must also be an object with nested structure preserved.
    assert.equal(typeof entries[0].inputSummary, 'object');
    assert.equal(entries[0].inputSummary.step, 'click');
    assert.equal(entries[0].inputSummary.coordinates.x, 100);
    assert.equal(entries[0].inputSummary.coordinates.y, 200);
});

test('structured fields with sensitive keys still use redactForDisplay', () => {
    clearAuditLog();
    appendAuditEntry({
        action: 'secrets.test',
        inputSummary: {
            apiKey: 'sk-1234567890abcdefghij',
            step: 'auth',
        },
    });
    const entries = readAuditEntries({ action: 'secrets.test' });
    assert.equal(entries.length, 1);
    const input = entries[0].inputSummary;
    assert.equal(typeof input, 'object');
    assert.equal(input.step, 'auth');
    // The secret value should be redacted to maskSecretValue's
    // "<first 6>...<last 4>" form, not the whole object stringified.
    assert.notEqual(input.apiKey, 'sk-1234567890abcdefghij');
    assert.equal(input.apiKey, 'sk-123...ghij');
});
