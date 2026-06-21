/**
 * agent-tree.js — durable sub-agent tree stored in august-brain.sqlite.
 *
 * Schema (see sqlite-memory-store.js migration):
 *   CREATE TABLE agent_tree (
 *     id TEXT PRIMARY KEY,
 *     parent_id TEXT REFERENCES agent_tree(id),
 *     session_id TEXT,
 *     parent_session_id TEXT,
 *     agent_id TEXT NOT NULL,
 *     parent_agent_id TEXT,
 *     depth INTEGER NOT NULL DEFAULT 0,
 *     task TEXT,
 *     status TEXT NOT NULL,
 *     scope TEXT,
 *     started_at TEXT NOT NULL,
 *     updated_at TEXT NOT NULL,
 *     completed_at TEXT,
 *     result_summary TEXT,
 *     metadata_json TEXT
 *   );
 *
 * The JSON-file storage in agent-jobs.js continues to receive writes during
 * the transition window so older clients (and the UI's existing agent log)
 * keep working. The SQLite tree is the new source of truth for the UI's
 * tree view.
 */

const crypto = require('crypto');

const { runPrepared, allSql } = (() => {
    try {
        return require('../memory/sqlite-memory-store');
    } catch (_) {
        return { runPrepared: () => false, allSql: () => [] };
    }
})();

const VALID_STATUSES = new Set(['running', 'completed', 'failed', 'blocked']);

function nowIso() {
    return new Date().toISOString();
}

function newId() {
    return `atree_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeStatus(status, fallback = 'running') {
    const s = String(status || '').trim().toLowerCase();
    return VALID_STATUSES.has(s) ? s : fallback;
}

function summarizeText(value, max = 2400) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeJson(value, fallback = {}) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch (_) {
        return fallback;
    }
}

function recordSpawn(input = {}) {
    const id = String(input.id || newId());
    const status = normalizeStatus(input.status);
    const now = nowIso();
    const task = summarizeText(input.task || '');
    runPrepared(
        `INSERT INTO agent_tree
            (id, parent_id, session_id, parent_session_id, agent_id, parent_agent_id,
             depth, task, status, scope, started_at, updated_at, completed_at,
             result_summary, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            parent_id=excluded.parent_id,
            session_id=excluded.session_id,
            parent_session_id=excluded.parent_session_id,
            agent_id=excluded.agent_id,
            parent_agent_id=excluded.parent_agent_id,
            depth=excluded.depth,
            task=excluded.task,
            status=excluded.status,
            scope=excluded.scope,
            updated_at=excluded.updated_at,
            completed_at=excluded.completed_at,
            result_summary=excluded.result_summary,
            metadata_json=excluded.metadata_json`,
        [
            id,
            input.parentId || null,
            input.sessionId || null,
            input.parentSessionId || null,
            String(input.agentId || 'general'),
            input.parentAgentId || null,
            Math.max(0, Number(input.depth) || 0),
            task,
            status,
            input.scope || null,
            input.startedAt || now,
            now,
            input.completedAt || null,
            input.resultSummary || null,
            JSON.stringify(input.metadata || {})
        ]
    );
    return getById(id);
}

function recordResult(id, { status, resultSummary } = {}) {
    if (!id) return null;
    const fields = ['updated_at = ?'];
    const params = [nowIso()];
    if (status) {
        fields.push('status = ?');
        params.push(normalizeStatus(status));
    }
    if (resultSummary !== undefined) {
        fields.push('result_summary = ?');
        params.push(summarizeText(resultSummary, 4000));
    }
    if (status && normalizeStatus(status) !== 'running') {
        fields.push('completed_at = ?');
        params.push(nowIso());
    }
    params.push(id);
    runPrepared(`UPDATE agent_tree SET ${fields.join(', ')} WHERE id = ?`, params);
    return getById(id);
}

function getById(id) {
    if (!id) return null;
    const rows = allSql(`SELECT * FROM agent_tree WHERE id = ?`, [id]);
    return rows && rows[0] ? normalizeRow(rows[0]) : null;
}

/**
 * Return the full sub-agent tree rooted at `rootId`. Builds a nested object:
 *   { root: Node, children: { <childId>: { root: Node, children: { ... } } } }
 */
function getTree(rootId, { maxDepth = 4 } = {}) {
    if (!rootId) return null;
    const root = getById(rootId);
    if (!root) return null;
    return buildSubtree(root, 0, maxDepth);
}

function buildSubtree(node, depth, maxDepth) {
    const children = allSql(
        `SELECT * FROM agent_tree WHERE parent_id = ? ORDER BY started_at ASC`,
        [node.id]
    );
    const out = {
        root: node,
        children: {}
    };
    if (depth >= maxDepth) return out;
    for (const row of children || []) {
        const child = normalizeRow(row);
        out.children[child.id] = buildSubtree(child, depth + 1, maxDepth);
    }
    return out;
}

/**
 * List the top-level rows (no parent) — i.e. the roots users see in the
 * Agents tab.
 */
function listRoots({ limit = 50, status = null, sessionId = null } = {}) {
    const params = [];
    const filters = ['parent_id IS NULL'];
    if (status) { filters.push('status = ?'); params.push(normalizeStatus(status)); }
    if (sessionId) { filters.push('session_id = ?'); params.push(sessionId); }
    params.push(Math.max(1, Math.min(500, Number(limit) || 50)));
    const rows = allSql(
        `SELECT * FROM agent_tree WHERE ${filters.join(' AND ')} ORDER BY started_at DESC LIMIT ?`,
        params
    );
    return (rows || []).map(normalizeRow);
}

function listChildren(parentId, { maxDepth = 1 } = {}) {
    if (!parentId) return [];
    const out = [];
    const rows = allSql(
        `SELECT * FROM agent_tree WHERE parent_id = ? ORDER BY started_at ASC`,
        [parentId]
    );
    for (const row of rows || []) {
        const child = normalizeRow(row);
        out.push(child);
        if (maxDepth > 1) {
            const sub = listChildren(child.id, { maxDepth: maxDepth - 1 });
            for (const s of sub) out.push(s);
        }
    }
    return out;
}

function pruneOlderThan(days = 30) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const rows = allSql(
        `SELECT id FROM agent_tree
         WHERE status IN ('completed', 'failed', 'blocked') AND completed_at IS NOT NULL AND completed_at < ?`,
        [cutoff]
    );
    const ids = (rows || []).map(r => r.id);
    for (const id of ids) {
        runPrepared(`DELETE FROM agent_tree WHERE id = ?`, [id]);
    }
    return ids.length;
}

function count() {
    const rows = allSql(`SELECT COUNT(*) AS count FROM agent_tree`, []);
    return rows && rows[0] ? Number(rows[0].count) || 0 : 0;
}

function normalizeRow(row) {
    return {
        id: row.id,
        parentId: row.parent_id || null,
        sessionId: row.session_id || null,
        parentSessionId: row.parent_session_id || null,
        agentId: row.agent_id,
        parentAgentId: row.parent_agent_id || null,
        depth: Number(row.depth) || 0,
        task: row.task || '',
        status: normalizeStatus(row.status, 'running'),
        scope: row.scope || null,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at || null,
        resultSummary: row.result_summary || null,
        metadata: safeJson(row.metadata_json, {})
    };
}

module.exports = {
    VALID_STATUSES,
    recordSpawn,
    recordResult,
    getById,
    getTree,
    listRoots,
    listChildren,
    pruneOlderThan,
    count,
    _normalizeRow: normalizeRow
};