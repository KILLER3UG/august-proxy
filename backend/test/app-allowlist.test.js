const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    getAppPolicy,
    setAppPolicy,
    listAppPolicies,
    deleteAppPolicy,
    DEFAULT_POLICY,
    VALID_POLICIES,
    APPS_FILE
} = require('../services/computer/app-allowlist');

function clearAllowlist() {
    if (fs.existsSync(APPS_FILE)) fs.unlinkSync(APPS_FILE);
}

test.beforeEach(() => clearAllowlist());

test('default policy for unknown app is "ask"', () => {
    assert.equal(getAppPolicy('notepad.exe'), 'ask');
    assert.equal(getAppPolicy(null), 'ask');
    assert.equal(getAppPolicy(''), 'ask');
});

test('VALID_POLICIES contains allow, ask, deny', () => {
    assert.ok(VALID_POLICIES.has('allow'));
    assert.ok(VALID_POLICIES.has('ask'));
    assert.ok(VALID_POLICIES.has('deny'));
    assert.equal(VALID_POLICIES.size, 3);
});

test('setAppPolicy rejects invalid policy', () => {
    assert.throws(() => setAppPolicy('notepad.exe', 'maybe'), /policy must be one of/);
});

test('setAppPolicy rejects missing app', () => {
    assert.throws(() => setAppPolicy(null, 'allow'), /appName is required/);
});

test('setAppPolicy + getAppPolicy round-trip', () => {
    setAppPolicy('notepad.exe', 'deny');
    assert.equal(getAppPolicy('notepad.exe'), 'deny');
});

test('setAppPolicy overwrites previous policy', () => {
    setAppPolicy('chrome.exe', 'deny');
    setAppPolicy('chrome.exe', 'allow');
    assert.equal(getAppPolicy('chrome.exe'), 'allow');
});

test('deleteAppPolicy removes the entry', () => {
    setAppPolicy('vscode.exe', 'ask');
    assert.equal(getAppPolicy('vscode.exe'), 'ask');
    deleteAppPolicy('vscode.exe');
    assert.equal(getAppPolicy('vscode.exe'), DEFAULT_POLICY);
});

test('listAppPolicies returns all stored entries', () => {
    setAppPolicy('a.exe', 'allow');
    setAppPolicy('b.exe', 'deny');
    setAppPolicy('c.exe', 'ask');
    const policies = listAppPolicies();
    assert.equal(policies['a.exe'], 'allow');
    assert.equal(policies['b.exe'], 'deny');
    assert.equal(policies['c.exe'], 'ask');
});

test('august__app_policy tool exposes the allowlist', async () => {
    const { executeAugustToolCall } = require('../services/tools/august-tools');

    // get unknown
    const r1 = await executeAugustToolCall('august__app_policy', { action: 'get', app: 'unknown.exe' }, false);
    assert.equal(r1.ok, true);
    assert.equal(r1.policy, 'ask');

    // set without approval => preview
    const r2 = await executeAugustToolCall('august__app_policy', { action: 'set', app: 'unknown.exe', policy: 'deny' }, false);
    assert.equal(r2.ok, false);
    assert.equal(r2.requiresApproval, true);

    // set with approval => applied
    const r3 = await executeAugustToolCall('august__app_policy', { action: 'set', app: 'unknown.exe', policy: 'deny' }, true);
    assert.equal(r3.ok, true);

    // get reflects the change
    const r4 = await executeAugustToolCall('august__app_policy', { action: 'get', app: 'unknown.exe' }, false);
    assert.equal(r4.policy, 'deny');
});

test('executeHostAgentToolWithPolicy is exported from workbench', () => {
    const wb = require('../services/workbench/workbench');
    assert.equal(typeof wb.executeHostAgentToolWithPolicy, 'function');
});

test('executeHostAgentToolWithPolicy denies when policy is deny', async () => {
    const wb = require('../services/workbench/workbench');
    setAppPolicy('notepad.exe', 'deny');
    // For a tool that resolves focusedApp='notepad.exe' via launch
    const r = await wb.executeHostAgentToolWithPolicy('computer_launch', { path: 'C:/Windows/notepad.exe' }, {});
    // Either blocked or returns error (host agent may be unreachable in CI)
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
    assert.equal(r.app, 'notepad.exe');
});
