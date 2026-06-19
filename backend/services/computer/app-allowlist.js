/**
 * Computer-use app allowlist (Lift L1).
 *
 * Stores per-app policy (`allow` | `ask` | `deny`) at data/computer_apps.json.
 * Default for unknown apps: `'ask'`.
 *
 * The policy lookup is invoked from Workbench's executeHostAgentToolWithPolicy
 * helper — NOT from host-agent-tools.js (Review #2). host-agent-tools.js is
 * read-only / decision logic only.
 *
 * Focused-app detection (Review #4): uses computer_list_windows and finds the
 * window with isForeground === true. NEVER calls computer_focus_window from the
 * policy check (it mutates focus).
 *
 * Special cases:
 *   computer_launch      — target app = basename(path)
 *   computer_clipboard_set — global mutating; uses last-known foreground app;
 *                            if unknown, treats as 'ask'
 */

const fs = require('fs');
const path = require('path');
const { dataPath } = require('../../lib/data-paths');

const APPS_FILE = dataPath('computer_apps.json');
const VALID_POLICIES = new Set(['allow', 'ask', 'deny']);
const DEFAULT_POLICY = 'ask';

function ensureLoaded() {
    if (!fs.existsSync(APPS_FILE)) {
        return { policies: {}, version: 1 };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
        return parsed && typeof parsed === 'object'
            ? { policies: parsed.policies || {}, version: parsed.version || 1 }
            : { policies: {}, version: 1 };
    } catch (_) {
        return { policies: {}, version: 1 };
    }
}

function save(data) {
    fs.mkdirSync(path.dirname(APPS_FILE), { recursive: true });
    fs.writeFileSync(APPS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getAppPolicy(appName) {
    if (!appName) return DEFAULT_POLICY;
    const data = ensureLoaded();
    const v = data.policies[String(appName)];
    return VALID_POLICIES.has(v) ? v : DEFAULT_POLICY;
}

function setAppPolicy(appName, policy) {
    if (!appName) throw new Error('appName is required');
    if (!VALID_POLICIES.has(policy)) {
        throw new Error(`policy must be one of: ${Array.from(VALID_POLICIES).join(', ')}`);
    }
    const data = ensureLoaded();
    data.policies[String(appName)] = policy;
    save(data);
    return { ok: true, app: appName, policy };
}

function listAppPolicies() {
    const data = ensureLoaded();
    return { ...data.policies };
}

function deleteAppPolicy(appName) {
    const data = ensureLoaded();
    delete data.policies[String(appName)];
    save(data);
    return { ok: true, app: appName };
}

module.exports = {
    APPS_FILE,
    DEFAULT_POLICY,
    VALID_POLICIES,
    getAppPolicy,
    setAppPolicy,
    listAppPolicies,
    deleteAppPolicy
};
