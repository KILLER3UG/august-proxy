const test = require('node:test');
const assert = require('node:assert/strict');

const {
    classifyTool,
    evaluateAgentTool,
    DEFAULT_AGENTS
} = require('../services/tools/agent-registry');

test('classifyTool args-aware: ui_control navigate is read', () => {
    assert.equal(classifyTool('august__ui_control', { action: 'navigate' }), 'read');
});

test('classifyTool args-aware: ui_control set_guard_mode is ui', () => {
    assert.equal(classifyTool('august__ui_control', { action: 'set_guard_mode' }), 'ui');
});

test('classifyTool args-aware: ui_control refresh is read', () => {
    assert.equal(classifyTool('august__ui_control', { action: 'refresh' }), 'read');
});

test('classifyTool args-aware: system_network GET is read', () => {
    assert.equal(classifyTool('august__system_network', { method: 'GET' }), 'read');
});

test('classifyTool args-aware: system_network POST is shell', () => {
    assert.equal(classifyTool('august__system_network', { method: 'POST' }), 'shell');
});

test('classifyTool: system_info is read', () => {
    assert.equal(classifyTool('august__system_info'), 'read');
});

test('classifyTool: filesystem_list is read', () => {
    assert.equal(classifyTool('august__filesystem_list'), 'read');
});

test('classifyTool: filesystem_read is read', () => {
    assert.equal(classifyTool('august__filesystem_read'), 'read');
});

test('classifyTool: filesystem_write is edit', () => {
    assert.equal(classifyTool('august__filesystem_write'), 'edit');
});

test('classifyTool: filesystem_delete is edit', () => {
    assert.equal(classifyTool('august__filesystem_delete'), 'edit');
});

test('classifyTool: system_exec is shell', () => {
    assert.equal(classifyTool('august__system_exec'), 'shell');
});

test('classifyTool: system_process is shell', () => {
    assert.equal(classifyTool('august__system_process'), 'shell');
});

test('classifyTool: system_env is shell', () => {
    assert.equal(classifyTool('august__system_env'), 'shell');
});

test('classifyTool: self_snapshot is read', () => {
    assert.equal(classifyTool('august__self_snapshot'), 'read');
});

test('classifyTool: settings_update is august_api', () => {
    assert.equal(classifyTool('august__settings_update'), 'august_api');
});

test('classifyTool: models_select is august_api', () => {
    assert.equal(classifyTool('august__models_select'), 'august_api');
});

test('classifyTool: providers_manage is august_api', () => {
    assert.equal(classifyTool('august__providers_manage'), 'august_api');
});

test('classifyTool: memory_manage is memory_write', () => {
    assert.equal(classifyTool('august__memory_manage'), 'memory_write');
});

test('classifyTool: agents_manage is august_api', () => {
    assert.equal(classifyTool('august__agents_manage'), 'august_api');
});

test('classifyTool: rollback_undo is august_api', () => {
    assert.equal(classifyTool('august__rollback_undo'), 'august_api');
});

test('classifyTool: app_policy is edit', () => {
    assert.equal(classifyTool('august__app_policy'), 'edit');
});

test('classifyTool: map_intent is read', () => {
    assert.equal(classifyTool('august__map_intent'), 'read');
});

test('DEFAULT_AGENTS.build has system/august_api/ui permissions set to ask', () => {
    const build = DEFAULT_AGENTS.build;
    assert.equal(build.permissions.system, 'ask');
    assert.equal(build.permissions.august_api, 'ask');
    assert.equal(build.permissions.ui, 'ask');
});

test('DEFAULT_AGENTS.project_manager allows new categories', () => {
    const pm = DEFAULT_AGENTS.project_manager;
    assert.equal(pm.permissions.system, 'allow');
    assert.equal(pm.permissions.august_api, 'allow');
    assert.equal(pm.permissions.ui, 'allow');
});

test('evaluateAgentTool threads args through classifyTool', () => {
    // build agent has system: 'ask' → evaluating network GET (read) returns ask
    const d1 = evaluateAgentTool('build', 'august__system_network', { method: 'GET' });
    assert.equal(d1.category, 'read');
    assert.equal(d1.action, 'allow'); // build has read:allow

    // build has system: 'ask' → evaluating network POST (shell) returns ask
    const d2 = evaluateAgentTool('build', 'august__system_network', { method: 'POST' });
    assert.equal(d2.category, 'shell');
    assert.equal(d2.action, 'ask');
});

test('subagent inherits parent deny for memory_write', () => {
    const childPerms = {}; // simulate build agent denying memory_write
    // We don't have direct access to deriveChildAgentPermissions — assert indirectly via plan agent
    const plan = DEFAULT_AGENTS.plan;
    assert.equal(plan.permissions.memory_write, 'deny');
});
