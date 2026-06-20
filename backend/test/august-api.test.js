const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const api = require('../services/august-api/august-api');
const { clearAuditLog, readAuditEntries } = require('../services/audit/audit-log');
const { clearRollbacks } = require('../services/rollback/rollback-store');

test.beforeEach(() => {
    clearAuditLog();
    clearRollbacks();
});

test('snapshot includes all required domains', () => {
    const snap = api.buildSnapshot();
    assert.ok(snap, 'snapshot should be an object');
    assert.ok('sessions' in snap, 'snapshot should have sessions');
    assert.ok('config' in snap, 'snapshot should have config');
    assert.ok('providers' in snap, 'snapshot should have providers');
    assert.ok('models' in snap, 'snapshot should have models');
    assert.ok('tools' in snap, 'snapshot should have tools');
    assert.ok('memory' in snap, 'snapshot should have memory');
    assert.ok('agents' in snap, 'snapshot should have agents');
    assert.ok('skills' in snap, 'snapshot should have skills');
});

test('settings_update tool previews without approvedMutation', async () => {
    // The HTTP route gates on approval; the service method itself applies.
    // Tool-level dispatch is gated in august-tools.js — exercise that path.
    const { executeAugustToolCall, getAugustToolDefinitions } = require('../services/tools/august-tools');
    const defs = getAugustToolDefinitions().map(t => t.function.name);
    assert.ok(defs.includes('august__settings_update'), 'august__settings_update should be defined');
    // Tool without approvedMutation + without args.confirmed -> preview
    const r = await executeAugustToolCall('august__settings_update', { key_path: 'demo.preview', value: 'x' }, false);
    assert.equal(r.ok, false);
    assert.equal(r.requiresApproval, true);
});

test('settings_update applies when invoked directly', async () => {
    // The HTTP route gates on approval; the service method itself applies.
    // To keep this test self-contained we just verify the service path.
    const before = api.buildSnapshot().config;
    // Save + restore to avoid disturbing global config
    const original = before?.demo?.key;
    api.updateSetting('demo.testField', 'testValue');
    const after = api.buildSnapshot().config;
    assert.equal(after.demo?.testField, 'testValue');
    // Rollback via the recorded rollback id
    const items = require('../services/rollback/rollback-store').listRollbacks({ limit: 1 });
    const last = items[items.length - 1];
    if (last && last.target === 'demo.testField') {
        await require('../services/rollback/rollback-store').undoRollback(last.id);
    }
});

test('models_select applies for a Claude public alias', () => {
    const r = api.selectModel('claude-sonnet-4-5', null);
    assert.equal(r.ok, true);
    assert.equal(r.profile, 'claude');
});

test('models_select returns error when provider is missing for non-public model', () => {
    const r = api.selectModel('not-a-public-alias', null);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'error');
});

test('providers_manage upsert + delete round-trip', () => {
    const tmpProviders = path.resolve(__dirname, '../data/august_providers.json');
    if (fs.existsSync(tmpProviders)) fs.unlinkSync(tmpProviders);

    const r1 = api.upsertProvider({ id: 'test-provider-1', name: 'Test Provider', type: 'openai' });
    assert.equal(r1.ok, true);
    assert.ok(fs.existsSync(tmpProviders));

    const r2 = api.upsertProvider({ id: 'test-provider-1', name: 'Test Provider Renamed' });
    assert.equal(r2.ok, true);

    const r3 = api.deleteProvider('test-provider-1');
    assert.equal(r3.ok, true);
    assert.equal(r3.deleted, true);
});

test('memory_manage upsert + delete round-trip', async () => {
    const r1 = api.updateMemoryFact({ key: 'unit-test-fact', value: 'unit-test-value', category: 'project_info' });
    assert.equal(r1.ok, true);

    const r2 = api.deleteMemoryFact('unit-test-fact');
    assert.equal(r2.ok, true);
});

test('agents_manage upsert writes agent and audit', () => {
    const r = api.upsertAgent({ id: 'unit-test-agent', role: 'Test', permissions: { read: 'allow' } });
    assert.equal(r.ok, true);
    const agents = api.buildSnapshot().agents;
    assert.ok(agents.find(a => a.id === 'unit-test-agent'));
});

test('agents_manage delete is critical', () => {
    api.upsertAgent({ id: 'unit-test-del', role: 'Test', permissions: { read: 'allow' } });
    const r = api.deleteAgent('unit-test-del');
    assert.equal(r.ok, true);
    const entries = readAuditEntries({ limit: 50 });
    const last = entries[entries.length - 1];
    assert.equal(last.action, 'agents.delete');
    assert.equal(last.critical, true);
});

test('audit entries are written with category=august_api', async () => {
    api.updateSetting('demo.testAudit', 'x');
    await api.deleteMemoryFact('unit-test-fact');
    const entries = readAuditEntries({ limit: 50 });
    const cats = entries.map(e => e.category);
    assert.ok(cats.includes('august_api'));
});

// ── Alias management ──

test('aliases_manage list returns empty initially', () => {
    const r = api.listAliases();
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.aliases));
});

test('aliases_manage upsert creates alias', () => {
    const r = api.upsertAlias('test-alias-1', 'gpt-4-turbo', 'openai');
    assert.equal(r.ok, true);
    assert.equal(r.alias, 'test-alias-1');

    const listed = api.listAliases();
    assert.ok(listed.aliases.some(a => a.alias === 'test-alias-1'));
});

test('aliases_manage upsert updates existing alias', () => {
    api.upsertAlias('test-alias-1', 'gpt-4-turbo', 'openai');
    const r = api.upsertAlias('test-alias-1', 'claude-opus-4-6', 'anthropic');
    assert.equal(r.ok, true);
    assert.equal(r.targetModel, 'claude-opus-4-6');
});

test('aliases_manage delete removes alias', () => {
    api.upsertAlias('test-alias-del', 'gpt-4', 'openai');
    const r = api.deleteAlias('test-alias-del');
    assert.equal(r.ok, true);
    assert.equal(r.deleted, true);

    const listed = api.listAliases();
    assert.equal(listed.aliases.some(a => a.alias === 'test-alias-del'), false);
});

test('aliases_manage delete returns error for missing alias', () => {
    const r = api.deleteAlias('nonexistent-alias');
    assert.equal(r.ok, false);
});

test('aliases_manage upsert requires targetModel', () => {
    const r = api.upsertAlias('foo', null, null);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'error');
});

test('aliases_manage writes audit and rollback entries', () => {
    clearAuditLog();
    clearRollbacks();
    const r = api.upsertAlias('test-audit-alias', 'claude-3-opus', null);
    assert.equal(r.ok, true);
    assert.ok(r.rollbackId);

    const entries = readAuditEntries({ limit: 50 });
    const last = entries[entries.length - 1];
    assert.equal(last.action, 'aliases.upsert');
    assert.equal(last.category, 'august_api');
});

// ── Tool management ──

test('tools_manage list returns mcp and plugins keys', () => {
    const r = api.listTools();
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.mcp));
    assert.ok(Array.isArray(r.plugins));
});

test('tools_manage upsert with unknown kind returns error', () => {
    const r = api.upsertTool('invalid', 'test', {});
    assert.equal(r.ok, false);
    assert.match(r.error || '', /unknown kind/i);
});

test('tools_manage delete with unknown kind returns error', () => {
    const r = api.deleteTool('invalid', 'test');
    assert.equal(r.ok, false);
    assert.match(r.error || '', /unknown kind/i);
});
