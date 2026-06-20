/**
 * August self-management API service.
 *
 * Composes existing services into a single governance surface so the LLM
 * (via august__* tools) and the frontend (via /ui/august/* routes) can:
 *   - read the full August state (snapshot)
 *   - manage sessions, settings, providers, models/aliases, tools, memory,
 *     agents
 *   - roll back supported changes
 *
 * All mutating actions:
 *   - flow through MUTATING_WORKBENCH_TOOLS (gated by Workbench)
 *   - write audit entries with category='august_api'
 *   - record declarative rollback entries when applicable
 */

const crypto = require('crypto');

function ok(data) { return { ok: true, ...data }; }
function errResult(error, code = 'error') { return { ok: false, error, code }; }

// ---------- Snapshot ----------
function buildSnapshot() {
    const sessions = require('../storage/session-store');
    const config = require('../../lib/config');
    const providers = require('../providers/providers-routes');
    const modelCatalog = require('../catalog/model-catalog');
    const toolRegistry = require('../tools/tool-registry');
    const semanticMemory = require('../memory/semantic-memory');
    const agentRegistry = require('../tools/agent-registry');
    const skills = require('../tools/skills');

    return {
        sessions: (() => { try { return sessions.listSessions({ limit: 100 }); } catch { return []; } })(),
        config: (() => { try { return config.getConfig(); } catch { return {}; } })(),
        providers: (() => { try { return providers.listPublicProviders(); } catch { return []; } })(),
        models: (() => { try { return modelCatalog.list({}); } catch { return []; } })(),
        tools: (() => { try { return (toolRegistry.listAvailable ? toolRegistry.listAvailable() : toolRegistry.list()); } catch { return []; } })().map(t => ({ name: t.name || t.function?.name, toolset: t.toolset, description: t.description || t.function?.description })),
        memory: (() => { try { return semanticMemory.getAllFacts(); } catch { return []; } })(),
        agents: (() => { try { return agentRegistry.getAgents(); } catch { return []; } })(),
        skills: (() => { try { return skills.getTeamSkills(); } catch { return []; } })()
    };
}

// ---------- Sessions ----------
async function listSessions(opts = {}) {
    const store = require('../storage/session-store');
    await store.init();
    return store.listSessions(opts);
}

async function createSession(input = {}) {
    const store = require('../storage/session-store');
    await store.init();
    const id = input.id || crypto.randomUUID();
    store.createSession({ id, ...input });
    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'sessions.create',
        target: id,
        category: 'august_api',
        inputSummary: { title: input.title, agent_type: input.agent_type }
    });
    return store.getSession(id);
}

async function updateSession(id, updates = {}) {
    const store = require('../storage/session-store');
    await store.init();
    const before = store.getSession(id);
    store.updateSession(id, updates);
    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'sessions.update',
        target: id,
        category: 'august_api',
        beforeSummary: before,
        afterSummary: updates
    });
    return store.getSession(id);
}

async function renameSession(id, title) {
    return updateSession(id, { title });
}

async function deleteSession(id) {
    const store = require('../storage/session-store');
    await store.init();
    const before = store.getSession(id);
    store.deleteSession(id);
    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'sessions.delete',
        target: id,
        category: 'august_api',
        beforeSummary: before,
        result: before ? 'ok' : 'error',
        error: before ? null : 'session not found'
    });
    return { deleted: !!before };
}

async function archiveSession(id) {
    return updateSession(id, { archived: true });
}

async function restoreSession(id) {
    return updateSession(id, { archived: false });
}

// ---------- Settings ----------
function updateSetting(keyPath, value) {
    const config = require('../../lib/config');
    const cfg = config.getConfig();
    const parts = String(keyPath || '').split('.');
    if (!parts[0]) return errResult('key_path is required');
    let cursor = cfg;
    for (const part of parts.slice(0, -1)) {
        if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
        cursor = cursor[part];
    }
    const beforeValue = cursor[parts[parts.length - 1]];
    cursor[parts[parts.length - 1]] = value;
    config.saveConfig(cfg);

    const { recordRollback } = require('../rollback/rollback-store');
    const rb = recordRollback({
        type: 'restore_setting',
        target: keyPath,
        before: { value: beforeValue },
        after: { value }
    });

    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'settings.update',
        target: keyPath,
        category: 'august_api',
        inputSummary: { keyPath, valueType: typeof value },
        beforeSummary: { value: beforeValue },
        afterSummary: { value },
        rollbackId: rb.id
    });
    return ok({ keyPath, value, rollbackId: rb.id });
}

// ---------- Models ----------
function selectModel(model, provider) {
    const config = require('../../lib/config');
    if (!model) return errResult('model is required');
    if (config.syncClaudePublicAlias && config.syncClaudePublicAlias(model)) {
        return ok({ profile: 'claude', model });
    }
    if (config.syncGptPublicAlias && config.syncGptPublicAlias(model)) {
        return ok({ profile: 'codex', model });
    }
    if (!provider) return errResult('provider is required when model is not a public Claude/GPT alias');
    const profile = config.getProfile(provider) || {};
    const beforeModel = profile.currentModel;
    config.saveProfile(provider, { ...profile, currentModel: model });
    const { recordRollback } = require('../rollback/rollback-store');
    const rb = recordRollback({
        type: 'restore_model_selection',
        target: model,
        before: { model: beforeModel, provider },
        after: { model, provider }
    });
    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'models.select',
        target: model,
        category: 'august_api',
        beforeSummary: { model: beforeModel, provider },
        afterSummary: { model, provider },
        rollbackId: rb.id
    });
    return ok({ provider, model, rollbackId: rb.id });
}

// ---------- Providers ----------
function upsertProvider(provider) {
    if (!provider || (!provider.id && !provider.name)) {
        return errResult('provider.id or provider.name is required');
    }
    // providers-routes doesn't currently export a mutating helper; write through
    // the existing JSON-backed store via a small inline implementation.
    const fs = require('fs');
    const path = require('path');
    const providersFile = path.resolve(__dirname, '../../data/august_providers.json');
    let list = [];
    try {
        if (fs.existsSync(providersFile)) list = JSON.parse(fs.readFileSync(providersFile, 'utf8'));
    } catch (_) { list = []; }
    const idx = list.findIndex(p => (provider.id && p.id === provider.id) || (provider.name && p.name === provider.name));
    if (idx >= 0) list[idx] = { ...list[idx], ...provider };
    else list.push(provider);
    fs.mkdirSync(path.dirname(providersFile), { recursive: true });
    fs.writeFileSync(providersFile, JSON.stringify(list, null, 2), 'utf8');
    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'providers.upsert',
        target: provider.id || provider.name,
        category: 'august_api',
        inputSummary: provider
    });
    return ok({ provider });
}

function deleteProvider(id) {
    if (!id) return errResult('provider id is required');
    const fs = require('fs');
    const path = require('path');
    const providersFile = path.resolve(__dirname, '../../data/august_providers.json');
    let list = [];
    try {
        if (fs.existsSync(providersFile)) list = JSON.parse(fs.readFileSync(providersFile, 'utf8'));
    } catch (_) { list = []; }
    const before = list.find(p => p.id === id || p.name === id);
    list = list.filter(p => p.id !== id && p.name !== id);
    fs.mkdirSync(path.dirname(providersFile), { recursive: true });
    fs.writeFileSync(providersFile, JSON.stringify(list, null, 2), 'utf8');
    const { recordRollback } = require('../rollback/rollback-store');
    const rb = recordRollback({
        type: 'restore_provider',
        target: id,
        before: before || null,
        after: null
    });
    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'providers.delete',
        target: id,
        category: 'august_api',
        beforeSummary: before,
        rollbackId: rb.id
    });
    return ok({ id, deleted: !!before, rollbackId: rb.id });
}

// ---------- Agents ----------
function upsertAgent(agent) {
    if (!agent || !agent.id) return errResult('agent.id is required');
    const agentRegistry = require('../tools/agent-registry');
    const result = agentRegistry.saveAgent(agent);
    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'agents.upsert',
        target: agent.id,
        category: 'august_api',
        inputSummary: agent
    });
    return ok({ agent: result });
}

function deleteAgent(id) {
    if (!id) return errResult('agent id is required');
    const agentRegistry = require('../tools/agent-registry');
    let removed = null;
    if (typeof agentRegistry.deleteAgent === 'function') {
        removed = agentRegistry.deleteAgent(id);
    } else if (typeof agentRegistry.removeAgent === 'function') {
        removed = agentRegistry.removeAgent(id);
    } else {
        // Fallback: rewrite custom agents file with id removed.
        const fs = require('fs');
        const path = require('path');
        const f = path.resolve(__dirname, '../../data/august_agents.json');
        let customs = {};
        try { if (fs.existsSync(f)) customs = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { customs = {}; }
        if (customs[id]) {
            removed = customs[id];
            delete customs[id];
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, JSON.stringify(customs, null, 2), 'utf8');
        }
    }
    const { recordRollback } = require('../rollback/rollback-store');
    const rb = recordRollback({
        type: 'restore_agent_config',
        target: id,
        before: removed || null,
        after: null
    });
    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'agents.delete',
        target: id,
        category: 'august_api',
        critical: true,
        beforeSummary: removed,
        rollbackId: rb.id
    });
    return ok({ id, deleted: !!removed, rollbackId: rb.id });
}

// ---------- Memory ----------
function updateMemoryFact({ key, value, category, ttl_days }) {
    if (!key) return errResult('key is required');
    const semantic = require('../memory/semantic-memory');
    const before = (() => { try { return semantic.getFact(key); } catch { return null; } })();
    semantic.setFact(key, value, category, ttl_days);
    const { recordRollback } = require('../rollback/rollback-store');
    const rb = recordRollback({
        type: 'restore_memory_item',
        target: key,
        before: before ? { key, value: before.value, category: before.category } : { deleted: true, key, value, category },
        after: { key, value, category }
    });
    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'memory.fact.upsert',
        target: key,
        category: 'august_api',
        inputSummary: { key, valueType: typeof value, category, ttl_days },
        rollbackId: rb.id
    });
    return ok({ key, value, rollbackId: rb.id });
}

function deleteMemoryFact(key) {
    if (!key) return errResult('key is required');
    const semantic = require('../memory/semantic-memory');
    const before = (() => { try { return semantic.getFact(key); } catch { return null; } })();
    semantic.deleteFact(key);
    const { recordRollback } = require('../rollback/rollback-store');
    const rb = recordRollback({
        type: 'restore_memory_item',
        target: key,
        before: before ? { key, value: before.value, category: before.category } : null,
        after: { deleted: true }
    });
    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'memory.fact.delete',
        target: key,
        category: 'august_api',
        rollbackId: rb.id
    });
    return ok({ key, deleted: true, rollbackId: rb.id });
}

// ---------- Aliases ----------
function listAliases() {
    const config = require('../../lib/config');
    const cfg = config.getConfig();
    return ok({ aliases: cfg.modelAliases || [] });
}

function upsertAlias(alias, targetModel, targetProvider) {
    if (!alias) return errResult('alias is required');
    if (!targetModel) return errResult('targetModel is required');
    const config = require('../../lib/config');
    const cfg = config.getConfig();
    const aliases = Array.isArray(cfg.modelAliases) ? [...cfg.modelAliases] : [];
    const idx = aliases.findIndex(a => a && a.alias === alias);
    const before = idx >= 0 ? { ...aliases[idx] } : null;
    const entry = { alias, targetModel, targetProvider: targetProvider || null };
    if (idx >= 0) aliases[idx] = entry;
    else aliases.push(entry);
    cfg.modelAliases = aliases;
    config.saveConfig(cfg);

    const { recordRollback } = require('../rollback/rollback-store');
    const rb = recordRollback({
        type: 'restore_array_entry',
        target: alias,
        meta: { arrayKey: 'modelAliases', matchField: 'alias', entryKey: alias },
        before: { value: before },
        after: { value: entry }
    });

    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'aliases.upsert',
        target: alias,
        category: 'august_api',
        beforeSummary: before,
        afterSummary: entry,
        rollbackId: rb.id
    });
    return ok({ alias, targetModel, rollbackId: rb.id });
}

function deleteAlias(alias) {
    if (!alias) return errResult('alias is required');
    const config = require('../../lib/config');
    const cfg = config.getConfig();
    const aliases = Array.isArray(cfg.modelAliases) ? [...cfg.modelAliases] : [];
    const idx = aliases.findIndex(a => a && a.alias === alias);
    if (idx === -1) return errResult(`alias not found: ${alias}`);
    const before = aliases[idx];
    aliases.splice(idx, 1);
    cfg.modelAliases = aliases;
    config.saveConfig(cfg);

    const { recordRollback } = require('../rollback/rollback-store');
    const rb = recordRollback({
        type: 'restore_array_entry',
        target: alias,
        meta: { arrayKey: 'modelAliases', matchField: 'alias', entryKey: alias },
        before: { value: before },
        after: { value: null }
    });

    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'aliases.delete',
        target: alias,
        category: 'august_api',
        beforeSummary: before,
        rollbackId: rb.id
    });
    return ok({ alias, deleted: true, rollbackId: rb.id });
}

// ---------- Tool Management (MCP + plugins) ----------
function listTools() {
    const { getMcpServersForUi } = require('../tools/mcp-registry');
    const { getPlugins } = require('../tools/plugins');
    return ok({ mcp: getMcpServersForUi(), plugins: getPlugins() });
}

function upsertTool(kind, name, configData) {
    if (kind === 'mcp') {
        if (!name) return errResult('name is required for MCP tools');
        const { saveCustomMcpServer } = require('../tools/mcp-registry');
        const result = saveCustomMcpServer({ name, ...(configData || {}) });
        const { recordRollback } = require('../rollback/rollback-store');
        const rb = recordRollback({
            type: 'restore_array_entry',
            target: name,
            meta: { arrayKey: 'mcpServers', matchField: 'name', entryKey: name },
            before: { value: null },
            after: { value: { name } }
        });
        const { appendAuditEntry } = require('../audit/audit-log');
        appendAuditEntry({
            action: 'tools.upsert_mcp',
            target: name,
            category: 'august_api',
            inputSummary: { kind, name },
            rollbackId: rb.id
        });
        return ok({ tool: result, rollbackId: rb.id });
    }
    if (kind === 'plugin') {
        if (!name) return errResult('name is required for plugins');
        const { savePlugin } = require('../tools/plugins');
        const result = savePlugin({ name, ...(configData || {}) });
        const { recordRollback } = require('../rollback/rollback-store');
        const rb = recordRollback({
            type: 'restore_array_entry',
            target: name,
            meta: { arrayKey: 'customPlugins', matchField: 'name', entryKey: name },
            before: { value: null },
            after: { value: { name } }
        });
        const { appendAuditEntry } = require('../audit/audit-log');
        appendAuditEntry({
            action: 'tools.upsert_plugin',
            target: name,
            category: 'august_api',
            inputSummary: { kind, name },
            rollbackId: rb.id
        });
        return ok({ tool: result, rollbackId: rb.id });
    }
    return errResult(`unknown kind: ${kind}. Use 'mcp' or 'plugin'.`);
}

function deleteTool(kind, name) {
    if (kind === 'mcp') {
        if (!name) return errResult('name is required for MCP tools');
        const { deleteMcpServer } = require('../tools/mcp-registry');
        deleteMcpServer(name);
        const { recordRollback } = require('../rollback/rollback-store');
        const rb = recordRollback({
            type: 'restore_array_entry',
            target: name,
            meta: { arrayKey: 'mcpServers', matchField: 'name', entryKey: name },
            before: { value: { name } },
            after: { value: null }
        });
        const { appendAuditEntry } = require('../audit/audit-log');
        appendAuditEntry({
            action: 'tools.delete_mcp',
            target: name,
            category: 'august_api',
            rollbackId: rb.id
        });
        return ok({ name, deleted: true, rollbackId: rb.id });
    }
    if (kind === 'plugin') {
        if (!name) return errResult('name is required for plugins');
        const { deletePlugin } = require('../tools/plugins');
        deletePlugin(name);
        const { recordRollback } = require('../rollback/rollback-store');
        const rb = recordRollback({
            type: 'restore_array_entry',
            target: name,
            meta: { arrayKey: 'customPlugins', matchField: 'name', entryKey: name },
            before: { value: { name } },
            after: { value: null }
        });
        const { appendAuditEntry } = require('../audit/audit-log');
        appendAuditEntry({
            action: 'tools.delete_plugin',
            target: name,
            category: 'august_api',
            rollbackId: rb.id
        });
        return ok({ name, deleted: true, rollbackId: rb.id });
    }
    return errResult(`unknown kind: ${kind}. Use 'mcp' or 'plugin'.`);
}

// ---------- Rollback ----------
async function rollbackUndo(id) {
    const { undoRollback } = require('../rollback/rollback-store');
    const entry = await undoRollback(id);
    const { appendAuditEntry } = require('../audit/audit-log');
    appendAuditEntry({
        action: 'rollback.undo',
        target: id,
        category: 'august_api',
        afterSummary: entry
    });
    return entry;
}

module.exports = {
    buildSnapshot,
    listSessions,
    createSession,
    updateSession,
    renameSession,
    deleteSession,
    archiveSession,
    restoreSession,
    updateSetting,
    selectModel,
    upsertProvider,
    deleteProvider,
    upsertAgent,
    deleteAgent,
    updateMemoryFact,
    deleteMemoryFact,
    listAliases,
    upsertAlias,
    deleteAlias,
    listTools,
    upsertTool,
    deleteTool,
    rollbackUndo
};
