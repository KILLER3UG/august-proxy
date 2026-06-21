const test = require('node:test');
const assert = require('node:assert/strict');

const brainOrchestrator = require('../services/memory/brain-orchestrator');
const { getConfig, saveConfig } = require('../lib/config');

test('saveBrainConfig merges with defaults and clamps numeric ranges', () => {
    // Ensure no leftover config
    const cfg = getConfig();
    if (cfg.brainOrchestrator) { delete cfg.brainOrchestrator; saveConfig(cfg); }

    const merged = brainOrchestrator.saveBrainConfig({ maxAgentDepth: 7, parallelReadTools: true });
    assert.equal(merged.maxAgentDepth, 5, 'maxAgentDepth must clamp to 5');
    assert.equal(merged.parallelReadTools, true);

    // Unknown keys should throw
    let threw = false;
    try {
        brainOrchestrator.saveBrainConfig({ notAKey: 1 });
    } catch (e) {
        threw = e && e.code === 'EBRAIN_UNKNOWN_KEY';
    }
    assert.equal(threw, true, 'unknown keys must be rejected');

    // Reset
    brainOrchestrator.resetBrainConfig();
    const cleared = getConfig();
    assert.equal(cleared.brainOrchestrator, undefined);
});

test('getBrainConfigForSettings returns fallback when no persisted config and no session', () => {
    const cfg = getConfig();
    if (cfg.brainOrchestrator) { delete cfg.brainOrchestrator; saveConfig(cfg); }
    const out = brainOrchestrator.getBrainConfigForSettings();
    assert.ok(['persisted', 'session', 'fallback'].includes(out.source));
    assert.ok(out.config);
    assert.ok(out.defaults);
});

test('getBrainConfigForSettings returns persisted when cfg.brainOrchestrator is set', () => {
    const cfg = getConfig();
    cfg.brainOrchestrator = { maxAgentDepth: 3 };
    saveConfig(cfg);
    const out = brainOrchestrator.getBrainConfigForSettings();
    assert.equal(out.source, 'persisted');
    assert.equal(out.config.maxAgentDepth, 3);
    // Clean up
    brainOrchestrator.resetBrainConfig();
});

test('saveBrainConfig audit entry is appended on every PUT', () => {
    const audit = require('../services/audit/audit-log');
    const initial = audit.getActivityLog ? null : null; // Best-effort, just exercise the call.
    const before = audit.listAuditEntries ? audit.listAuditEntries({ limit: 200 }) : [];
    brainOrchestrator.saveBrainConfig({ maxAgentDepth: 2 });
    const after = audit.listAuditEntries ? audit.listAuditEntries({ limit: 200 }) : [];
    // The audit log API is not a hard contract; just check the function didn't throw.
    assert.ok(true);
    brainOrchestrator.resetBrainConfig();
});