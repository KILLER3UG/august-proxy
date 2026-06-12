const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SQLITE_MEMORY_FILE = process.env.AUGUST_BRAIN_SQLITE_FILE || path.join(__dirname, '..', '..', '..', 'data', 'august_brain.sqlite');
const SQLITE_TIMEOUT_MS = 10000;
const SQLITE_BUSY_RETRIES = 2;

let nodeDb = null;
let nodeSqliteAvailable = null;
let sqliteCliAvailable = null;
let sqliteUnavailableUntil = 0;
let sqliteLastError = '';

function q(value) {
    if (value === undefined || value === null) return 'NULL';
    return `'${String(value).replace(/'/g, "''")}'`;
}

function json(value) {
    return JSON.stringify(value === undefined ? null : value);
}

function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (e) {}
}

function sqliteErrorMessage(error) {
    return String(error?.stderr || error?.message || error || '');
}

function isSqliteCorruption(error) {
    return /database disk image is malformed|file is not a database|not a database|disk I\/O error/i.test(sqliteErrorMessage(error));
}

function isSqliteLocked(error) {
    return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(sqliteErrorMessage(error));
}

function quarantineSqliteStore(reason = 'corrupt') {
    try {
        if (nodeDb && typeof nodeDb.close === 'function') nodeDb.close();
    } catch (e) {}
    nodeDb = null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const filePath of [SQLITE_MEMORY_FILE, `${SQLITE_MEMORY_FILE}-wal`, `${SQLITE_MEMORY_FILE}-shm`]) {
        try {
            if (fs.existsSync(filePath)) {
                fs.renameSync(filePath, `${filePath}.${stamp}.${reason}`);
            }
        } catch (e) {
            try { fs.unlinkSync(filePath); } catch (ignore) {}
        }
    }
    return true;
}

function markSqliteUnavailable(error, ms = 30000) {
    sqliteLastError = sqliteErrorMessage(error).split(/\r?\n/)[0].slice(0, 240);
    sqliteUnavailableUntil = Date.now() + ms;
}

function detectNodeSqlite() {
    if (nodeSqliteAvailable !== null) return nodeSqliteAvailable;
    try {
        require('node:sqlite');
        nodeSqliteAvailable = true;
    } catch (e) {
        nodeSqliteAvailable = false;
    }
    return nodeSqliteAvailable;
}

function detectSqliteCli() {
    if (sqliteCliAvailable !== null) return sqliteCliAvailable;
    try {
        execFileSync('sqlite3', ['--version'], { stdio: 'ignore', timeout: SQLITE_TIMEOUT_MS });
        sqliteCliAvailable = true;
    } catch (e) {
        sqliteCliAvailable = false;
    }
    return sqliteCliAvailable;
}

function getDriverName() {
    if (Date.now() < sqliteUnavailableUntil) return 'unavailable';
    if (detectNodeSqlite()) return 'node:sqlite';
    if (detectSqliteCli()) return 'sqlite3-cli';
    return 'unavailable';
}

function openNodeDb() {
    if (!detectNodeSqlite()) return null;
    if (nodeDb) return nodeDb;
    const { DatabaseSync } = require('node:sqlite');
    nodeDb = new DatabaseSync(SQLITE_MEMORY_FILE);
    nodeDb.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    return nodeDb;
}

function runSqliteCli(script, { jsonOutput = false } = {}) {
    const input = [
        '.bail on',
        '.timeout 5000',
        jsonOutput ? '.mode json' : '',
        jsonOutput ? '' : 'PRAGMA busy_timeout = 5000;',
        jsonOutput ? '' : 'PRAGMA journal_mode = WAL;',
        jsonOutput ? '' : 'PRAGMA synchronous = NORMAL;',
        jsonOutput ? '' : 'PRAGMA foreign_keys = ON;',
        script
    ].filter(Boolean).join('\n');
    for (let attempt = 0; attempt < SQLITE_BUSY_RETRIES; attempt++) {
        try {
            const output = execFileSync('sqlite3', [SQLITE_MEMORY_FILE], {
                input,
                encoding: 'utf8',
                timeout: SQLITE_TIMEOUT_MS
            });
            if (!jsonOutput) return output;
            const trimmed = output.trim();
            return trimmed ? JSON.parse(trimmed) : [];
        } catch (error) {
            if (isSqliteCorruption(error)) {
                quarantineSqliteStore('corrupt');
                if (attempt < SQLITE_BUSY_RETRIES - 1) continue;
                markSqliteUnavailable(error);
            }
            if (isSqliteLocked(error) && attempt < SQLITE_BUSY_RETRIES - 1) {
                sleepSync(250 * (attempt + 1));
                continue;
            }
            if (isSqliteLocked(error)) markSqliteUnavailable(error, 10000);
            throw error;
        }
    }
    return jsonOutput ? [] : '';
}

function execSql(script) {
    const driver = getDriverName();
    if (driver === 'node:sqlite') {
        openNodeDb().exec(script);
        return true;
    }
    if (driver === 'sqlite3-cli') {
        runSqliteCli(script);
        return true;
    }
    return false;
}

function allSql(sql, params = []) {
    const driver = getDriverName();
    if (driver === 'node:sqlite') {
        return openNodeDb().prepare(sql).all(...params);
    }
    if (driver === 'sqlite3-cli') {
        let index = 0;
        const rendered = sql.replace(/\?/g, () => q(params[index++]));
        return runSqliteCli(rendered, { jsonOutput: true });
    }
    return [];
}

function runPrepared(sql, params = []) {
    const driver = getDriverName();
    if (driver === 'node:sqlite') {
        openNodeDb().prepare(sql).run(...params);
        return true;
    }
    if (driver === 'sqlite3-cli') {
        let index = 0;
        const rendered = sql.replace(/\?/g, () => q(params[index++]));
        runSqliteCli(rendered);
        return true;
    }
    return false;
}

function ensureMemorySchema() {
    try {
        return execSql(`
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    summary TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    embedding_source TEXT,
    metadata_json TEXT,
    tags_json TEXT,
    content TEXT NOT NULL,
    lifecycle_status TEXT DEFAULT 'active',
    trust REAL DEFAULT 0.75,
    updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    id UNINDEXED,
    topic,
    summary,
    metadata,
    tags,
    content
);
CREATE TABLE IF NOT EXISTS memory_provider_events (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    hook TEXT NOT NULL,
    session_id TEXT,
    payload_json TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL,
    output TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_facts (
    id TEXT PRIMARY KEY,
    fact_key TEXT NOT NULL,
    value TEXT NOT NULL,
    category TEXT NOT NULL,
    source TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ttl TEXT,
    confidence REAL DEFAULT 0.75,
    metadata_json TEXT,
    lifecycle_status TEXT DEFAULT 'active',
    trust REAL DEFAULT 0.75,
    provenance_json TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
    id UNINDEXED,
    fact_key,
    value,
    category,
    metadata,
    content
);
CREATE TABLE IF NOT EXISTS memory_proposals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    action TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    target_id TEXT,
    target_type TEXT,
    target_key TEXT,
    before_json TEXT,
    after_json TEXT,
    metadata_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_retention_decisions (
    id TEXT PRIMARY KEY,
    memory_type TEXT NOT NULL,
    target_id TEXT,
    target_key TEXT,
    score INTEGER,
    recommendation TEXT NOT NULL,
    reasons_json TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_observations (
    id TEXT PRIMARY KEY,
    model_id TEXT,
    provider TEXT,
    observation_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    details_json TEXT,
    related_memory_json TEXT,
    source TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_usage (
    id TEXT PRIMARY KEY,
    memory_type TEXT NOT NULL,
    target_id TEXT,
    target_key TEXT,
    access_count INTEGER NOT NULL DEFAULT 1,
    last_accessed_at TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_lifecycle ON memories(lifecycle_status, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_facts_category ON memory_facts(category, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_memory_proposals_status ON memory_proposals(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_model_observations_model ON model_observations(model_id, created_at);
`);
    } catch (error) {
        if (isSqliteCorruption(error)) {
            quarantineSqliteStore('corrupt');
            try {
                return execSql(`
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    summary TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    embedding_source TEXT,
    metadata_json TEXT,
    tags_json TEXT,
    content TEXT NOT NULL,
    lifecycle_status TEXT DEFAULT 'active',
    trust REAL DEFAULT 0.75,
    updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    id UNINDEXED,
    topic,
    summary,
    metadata,
    tags,
    content
);
CREATE TABLE IF NOT EXISTS memory_provider_events (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    hook TEXT NOT NULL,
    session_id TEXT,
    payload_json TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL,
    output TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_facts (
    id TEXT PRIMARY KEY,
    fact_key TEXT NOT NULL,
    value TEXT NOT NULL,
    category TEXT NOT NULL,
    source TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ttl TEXT,
    confidence REAL DEFAULT 0.75,
    metadata_json TEXT,
    lifecycle_status TEXT DEFAULT 'active',
    trust REAL DEFAULT 0.75,
    provenance_json TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
    id UNINDEXED,
    fact_key,
    value,
    category,
    metadata,
    content
);
CREATE TABLE IF NOT EXISTS memory_proposals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    action TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    target_id TEXT,
    target_type TEXT,
    target_key TEXT,
    before_json TEXT,
    after_json TEXT,
    metadata_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_retention_decisions (
    id TEXT PRIMARY KEY,
    memory_type TEXT NOT NULL,
    target_id TEXT,
    target_key TEXT,
    score INTEGER,
    recommendation TEXT NOT NULL,
    reasons_json TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_observations (
    id TEXT PRIMARY KEY,
    model_id TEXT,
    provider TEXT,
    observation_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    details_json TEXT,
    related_memory_json TEXT,
    source TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_usage (
    id TEXT PRIMARY KEY,
    memory_type TEXT NOT NULL,
    target_id TEXT,
    target_key TEXT,
    access_count INTEGER NOT NULL DEFAULT 1,
    last_accessed_at TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_lifecycle ON memories(lifecycle_status, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_facts_category ON memory_facts(category, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_memory_proposals_status ON memory_proposals(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_model_observations_model ON model_observations(model_id, created_at);
`);
            } catch (retryError) {
                return false;
            }
        }
        return false;
    }
}

function normalizeEntry(entry = {}) {
    const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
    const tags = Array.isArray(entry.tags)
        ? entry.tags
        : (Array.isArray(metadata.tags) ? metadata.tags : []);
    const timestamp = entry.timestamp || new Date().toISOString();
    const updatedAt = entry.updated_at || entry.updatedAt || metadata.updatedAt || timestamp;
    const id = entry.id || `mem_${Buffer.from(`${entry.topic || ''}\n${entry.summary || ''}\n${timestamp}`).toString('base64url').slice(0, 28)}`;
    return {
        id,
        topic: String(entry.topic || 'Untitled checkpoint').trim(),
        summary: String(entry.summary || '').trim(),
        timestamp,
        embeddingSource: entry.embeddingSource || metadata.embeddingSource || '',
        metadata: {
            ...metadata,
            updatedAt,
            lastUsedAt: metadata.lastUsedAt || '',
            ttl: metadata.ttl || null,
            sourceSessionId: metadata.sourceSessionId || '',
            sourceMessageId: metadata.sourceMessageId || '',
            sourceType: metadata.sourceType || '',
            pinned: metadata.pinned === true,
        },
        tags,
        content: [
            entry.topic,
            entry.summary,
            metadata.type,
            metadata.project,
            metadata.task,
            metadata.outcome,
            tags.join(' ')
        ].filter(Boolean).join('\n'),
        lifecycleStatus: entry.lifecycleStatus || metadata.lifecycleStatus || 'active',
        trust: Number.isFinite(Number(entry.trust ?? metadata.trust)) ? Number(entry.trust ?? metadata.trust) : 0.75,
        updatedAt,
        lastUsedAt: metadata.lastUsedAt || '',
        ttl: metadata.ttl || null,
        provenance: {
            source: metadata.source || entry.embeddingSource || '',
            sourceSessionId: metadata.sourceSessionId || '',
            sourceMessageId: metadata.sourceMessageId || '',
            sourceType: metadata.sourceType || '',
            confidence: Number.isFinite(Number(metadata.confidence)) ? Number(metadata.confidence) : 0.75,
            pinned: metadata.pinned === true,
            updatedAt,
            lastUsedAt: metadata.lastUsedAt || '',
            ttl: metadata.ttl || null,
        }
    };
}

function factIdFor(category, key) {
    return `fact_${Buffer.from(`${category || 'unknown'}:${key || ''}`).toString('base64url').slice(0, 36)}`;
}

function normalizeFact(fact = {}) {
    const metadata = fact.metadata && typeof fact.metadata === 'object' ? fact.metadata : {};
    const provenance = fact.provenance && typeof fact.provenance === 'object' ? fact.provenance : {};
    const key = String(fact.key || fact.factKey || fact.fact_key || 'unknown').trim();
    const category = String(fact.category || metadata.category || 'user_preference').trim();
    const createdAt = fact.created_at || fact.createdAt || provenance.createdAt || fact.created || new Date().toISOString();
    const updatedAt = fact.updated_at || fact.updatedAt || provenance.updatedAt || fact.updated || new Date().toISOString();
    return {
        id: fact.id || factIdFor(category, key),
        factKey: key,
        value: String(fact.value || ''),
        category,
        source: fact.source || provenance.source || metadata.source || '',
        createdAt,
        updatedAt,
        ttl: fact.ttl || provenance.ttl || null,
        confidence: Number.isFinite(Number(fact.confidence ?? provenance.confidence ?? metadata.confidence)) ? Number(fact.confidence ?? provenance.confidence ?? metadata.confidence) : 0.75,
        metadata,
        lifecycleStatus: fact.lifecycleStatus || fact.lifecycle_status || metadata.lifecycleStatus || 'active',
        trust: Number.isFinite(Number(fact.trust ?? metadata.trust)) ? Number(fact.trust ?? metadata.trust) : 0.75,
        provenance: {
            ...provenance,
            source: fact.source || provenance.source || metadata.source || '',
            createdAt,
            updatedAt,
            confidence: Number.isFinite(Number(provenance.confidence ?? metadata.confidence)) ? Number(provenance.confidence ?? metadata.confidence) : 0.75,
            pinned: metadata.pinned === true,
            ttl: fact.ttl || provenance.ttl || null,
        }
    };
}

function normalizeFactRow(row) {
    return {
        id: row.id,
        key: row.fact_key,
        factKey: row.fact_key,
        value: row.value,
        category: row.category,
        source: row.source,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ttl: row.ttl,
        confidence: row.confidence,
        metadata: safeJson(row.metadata_json, {}),
        lifecycleStatus: row.lifecycle_status,
        trust: row.trust,
        provenance: safeJson(row.provenance_json, {})
    };
}

function upsertMemoryFact(fact = {}) {
    if (!ensureMemorySchema()) return { ok: false, driver: getDriverName() };
    const item = normalizeFact(fact);
    const now = new Date().toISOString();
    const writeItem = () => {
        runPrepared(
            `INSERT INTO memory_facts
                (id, fact_key, value, category, source, created_at, updated_at, ttl, confidence, metadata_json, lifecycle_status, trust, provenance_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                fact_key=excluded.fact_key,
                value=excluded.value,
                category=excluded.category,
                source=excluded.source,
                updated_at=excluded.updated_at,
                ttl=excluded.ttl,
                confidence=excluded.confidence,
                metadata_json=excluded.metadata_json,
                lifecycle_status=excluded.lifecycle_status,
                trust=excluded.trust,
                provenance_json=excluded.provenance_json`,
            [
                item.id,
                item.factKey,
                item.value,
                item.category,
                item.source,
                item.createdAt,
                now,
                item.ttl,
                item.confidence,
                json(item.metadata),
                item.lifecycleStatus,
                item.trust,
                json(item.provenance)
            ]
        );
        runPrepared('DELETE FROM memory_facts_fts WHERE id = ?', [item.id]);
        runPrepared(
            'INSERT INTO memory_facts_fts (id, fact_key, value, category, metadata, content) VALUES (?, ?, ?, ?, ?, ?)',
            [item.id, item.factKey, item.value, item.category, json(item.metadata), `${item.factKey}\n${item.value}\n${item.category}\n${item.source}`]
        );
    };
    try {
        writeItem();
        return { ok: true, driver: getDriverName(), id: item.id };
    } catch (error) {
        if (isSqliteCorruption(error)) {
            quarantineSqliteStore('corrupt');
            if (ensureMemorySchema()) {
                try {
                    writeItem();
                    return { ok: true, driver: getDriverName(), id: item.id, repaired: true };
                } catch (retryError) {
                    return { ok: false, driver: getDriverName(), id: item.id, error: sqliteErrorMessage(retryError) };
                }
            }
        }
        return { ok: false, driver: getDriverName(), id: item.id, error: sqliteErrorMessage(error) };
    }
}

function listMemoryFacts({ limit = 100 } = {}) {
    if (!ensureMemorySchema()) return [];
    try {
        return allSql(
            `SELECT id, fact_key, value, category, source, created_at, updated_at, ttl, confidence, metadata_json, lifecycle_status, trust, provenance_json
             FROM memory_facts
             ORDER BY updated_at DESC
             LIMIT ?`,
            [Math.max(1, Math.min(500, Number(limit) || 100))]
        ).map(normalizeFactRow);
    } catch (error) {
        if (isSqliteCorruption(error)) {
            quarantineSqliteStore('corrupt');
            ensureMemorySchema();
        }
        return [];
    }
}

function searchMemoryFacts(query, { limit = 50 } = {}) {
    if (!ensureMemorySchema()) return [];
    const q = String(query || '').trim();
    if (!q) return listMemoryFacts({ limit });
    const match = buildFtsQuery(q);
    if (!match) return [];
    try {
        const rows = allSql(
            `SELECT memory_facts_fts.id AS id,
                    memory_facts.fact_key AS fact_key,
                    memory_facts.value AS value,
                    memory_facts.category AS category,
                    memory_facts.source AS source,
                    memory_facts.created_at AS created_at,
                    memory_facts.updated_at AS updated_at,
                    memory_facts.ttl AS ttl,
                    memory_facts.confidence AS confidence,
                    memory_facts.metadata_json AS metadata_json,
                    memory_facts.lifecycle_status AS lifecycle_status,
                    memory_facts.trust AS trust,
                    memory_facts.provenance_json AS provenance_json,
                    bm25(memory_facts_fts) AS rank
             FROM memory_facts_fts
             JOIN memory_facts ON memory_facts.id = memory_facts_fts.id
             WHERE memory_facts_fts MATCH ?
             ORDER BY rank
             LIMIT ?`,
            [match, Math.max(1, Math.min(200, Number(limit) || 50))]
        );
        return rows.map(normalizeFactRow);
    } catch (error) {
        if (isSqliteCorruption(error)) {
            quarantineSqliteStore('corrupt');
            ensureMemorySchema();
        }
        return [];
    }
}

function deleteMemoryFact(idOrKey) {
    if (!idOrKey || !ensureMemorySchema()) return false;
    try {
        const rows = allSql('SELECT id FROM memory_facts WHERE id = ? OR fact_key = ?', [idOrKey, idOrKey]);
        let deleted = 0;
        for (const row of rows) {
            runPrepared('DELETE FROM memory_facts_fts WHERE id = ?', [row.id]);
            runPrepared('DELETE FROM memory_facts WHERE id = ?', [row.id]);
            deleted++;
        }
        return deleted > 0;
    } catch (error) {
        if (isSqliteCorruption(error)) {
            quarantineSqliteStore('corrupt');
            ensureMemorySchema();
        }
        return false;
    }
}

function updateMemoryLifecycle(id, updates = {}) {
    if (!id || !ensureMemorySchema()) return false;
    const assignments = [];
    const params = [];
    if (updates.lifecycleStatus !== undefined) {
        assignments.push('lifecycle_status = ?');
        params.push(String(updates.lifecycleStatus));
    }
    if (updates.trust !== undefined) {
        assignments.push('trust = ?');
        params.push(Math.max(0, Math.min(1, Number(updates.trust) || 0.75)));
    }
    if (updates.metadata !== undefined) {
        assignments.push('metadata_json = ?');
        params.push(json(updates.metadata));
    }
    assignments.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    try {
        runPrepared(`UPDATE memories SET ${assignments.join(', ')} WHERE id = ?`, params);
        return true;
    } catch (error) {
        if (isSqliteCorruption(error)) {
            quarantineSqliteStore('corrupt');
            ensureMemorySchema();
        }
        return false;
    }
}

function setSchemaMeta(key, value) {
    if (!key || !ensureMemorySchema()) return false;
    const now = new Date().toISOString();
    runPrepared(
        'INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        [key, JSON.stringify(value), now]
    );
    return true;
}

function getSchemaMeta(key) {
    if (!key || !ensureMemorySchema()) return null;
    const row = allSql('SELECT value FROM schema_meta WHERE key = ?', [key])[0];
    if (!row) return null;
    try {
        return JSON.parse(row.value);
    } catch (e) {
        return row.value;
    }
}

function listSchemaMeta() {
    if (!ensureMemorySchema()) return {};
    return allSql('SELECT key, value, updated_at FROM schema_meta ORDER BY key').reduce((acc, row) => {
        try {
            acc[row.key] = { value: JSON.parse(row.value), updatedAt: row.updated_at };
        } catch (e) {
            acc[row.key] = { value: row.value, updatedAt: row.updated_at };
        }
        return acc;
    }, {});
}

function createMemoryProposal(input = {}) {
    if (!ensureMemorySchema()) return null;
    const now = new Date().toISOString();
    const id = `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const title = String(input.title || input.action || 'Brain edit proposal').trim();
    const action = String(input.action || 'update_memory').trim();
    const memoryType = String(input.memoryType || input.memory_type || 'memory').trim();
    if (!title || !action || !memoryType) throw new Error('title, action, and memory_type are required');
    runPrepared(
        `INSERT INTO memory_proposals
            (id, title, description, action, memory_type, target_id, target_type, target_key, before_json, after_json, metadata_json, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            title,
            input.description || '',
            action,
            memoryType,
            input.targetId || input.target_id || null,
            input.targetType || input.target_type || null,
            input.targetKey || input.target_key || null,
            json(input.before || input.before_json || {}),
            json(input.after || input.after_json || {}),
            json(input.metadata || input.metadata_json || {}),
            input.status || 'pending',
            input.createdBy || input.created_by || 'system',
            now,
            now
        ]
    );
    return getMemoryProposal(id);
}

function normalizeProposal(row) {
    return {
        ...row,
        before: safeJson(row.before_json, {}),
        after: safeJson(row.after_json, {}),
        metadata: safeJson(row.metadata_json, {})
    };
}

function getMemoryProposal(id) {
    if (!id || !ensureMemorySchema()) return null;
    const row = allSql('SELECT * FROM memory_proposals WHERE id = ?', [id])[0];
    return row ? normalizeProposal(row) : null;
}

function listMemoryProposals({ status = 'pending', limit = 100 } = {}) {
    if (!ensureMemorySchema()) return [];
    const params = [];
    const where = status && status !== 'all' ? 'WHERE status = ?' : '';
    if (status && status !== 'all') params.push(status);
    params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
    return allSql(
        `SELECT * FROM memory_proposals ${where} ORDER BY updated_at DESC LIMIT ?`,
        params
    ).map(normalizeProposal);
}

function updateMemoryProposal(id, updates = {}) {
    if (!id || !ensureMemorySchema()) return null;
    const assignments = [];
    const params = [];
    for (const key of ['status', 'description', 'metadata_json']) {
        if (updates[key] !== undefined) {
            assignments.push(`${key} = ?`);
            params.push(key === 'metadata_json' ? json(updates[key]) : updates[key]);
        }
    }
    if (updates.after !== undefined) {
        assignments.push('after_json = ?');
        params.push(json(updates.after));
    }
    assignments.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    runPrepared(`UPDATE memory_proposals SET ${assignments.join(', ')} WHERE id = ?`, params);
    return getMemoryProposal(id);
}

function recordModelObservation(input = {}) {
    if (!ensureMemorySchema()) return { ok: false, driver: getDriverName() };
    const now = new Date().toISOString();
    const id = `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const summary = String(input.summary || input.observation || '').trim();
    if (!summary) throw new Error('summary is required');
    try {
        runPrepared(
            `INSERT INTO model_observations
                (id, model_id, provider, observation_type, summary, details_json, related_memory_json, source, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                input.modelId || input.model_id || '',
                input.provider || '',
                input.observationType || input.observation_type || 'note',
                summary,
                json(input.details || input.details_json || {}),
                json(input.relatedMemory || input.related_memory || {}),
                input.source || 'model',
                now,
                now
            ]
        );
        return { ok: true, id, driver: getDriverName() };
    } catch (error) {
        return { ok: false, id, driver: getDriverName(), error: sqliteErrorMessage(error) };
    }
}

function listModelObservations({ limit = 50, modelId } = {}) {
    if (!ensureMemorySchema()) return [];
    const params = [];
    const where = modelId ? 'WHERE model_id = ?' : '';
    if (modelId) params.push(modelId);
    params.push(Math.max(1, Math.min(500, Number(limit) || 50)));
    return allSql(
        `SELECT id, model_id, provider, observation_type, summary, details_json, related_memory_json, source, created_at, updated_at
         FROM model_observations
         ${where}
         ORDER BY created_at DESC
         LIMIT ?`,
        params
    ).map(row => ({
        id: row.id,
        modelId: row.model_id,
        provider: row.provider,
        observationType: row.observation_type,
        summary: row.summary,
        details: safeJson(row.details_json, {}),
        relatedMemory: safeJson(row.related_memory_json, {}),
        source: row.source,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }));
}

function recordMemoryUsage(input = {}) {
    if (!ensureMemorySchema()) return { ok: false, driver: getDriverName() };
    const memoryType = String(input.memoryType || input.memory_type || 'memory').trim();
    const targetId = input.targetId || input.target_id || '';
    const targetKey = input.targetKey || input.target_key || '';
    if (!memoryType) throw new Error('memory_type is required');
    const id = `usage_${Buffer.from(`${memoryType}:${targetId || targetKey || 'global'}`).toString('base64url').slice(0, 36)}`;
    const now = new Date().toISOString();
    try {
        runPrepared(
            `INSERT INTO memory_usage
                (id, memory_type, target_id, target_key, access_count, last_accessed_at, metadata_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                access_count = access_count + 1,
                last_accessed_at = excluded.last_accessed_at,
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at`,
            [id, memoryType, targetId || null, targetKey || null, 1, now, json(input.metadata || input.metadata_json || {}), now, now]
        );
        return { ok: true, id, driver: getDriverName() };
    } catch (error) {
        return { ok: false, id, driver: getDriverName(), error: sqliteErrorMessage(error) };
    }
}

function listMemoryUsage({ limit = 100 } = {}) {
    if (!ensureMemorySchema()) return [];
    return allSql(
        `SELECT id, memory_type, target_id, target_key, access_count, last_accessed_at, metadata_json, created_at, updated_at
         FROM memory_usage
         ORDER BY last_accessed_at DESC
         LIMIT ?`,
        [Math.max(1, Math.min(500, Number(limit) || 100))]
    ).map(row => ({
        id: row.id,
        memoryType: row.memory_type,
        targetId: row.target_id,
        targetKey: row.target_key,
        accessCount: row.access_count,
        lastAccessedAt: row.last_accessed_at,
        metadata: safeJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }));
}

function listRetentionDecisions({ limit = 100 } = {}) {
    if (!ensureMemorySchema()) return [];
    return allSql(
        `SELECT id, memory_type, target_id, target_key, score, recommendation, reasons_json, metadata_json, created_at
         FROM memory_retention_decisions
         ORDER BY created_at DESC
         LIMIT ?`,
        [Math.max(1, Math.min(500, Number(limit) || 100))]
    ).map(row => ({
        id: row.id,
        memoryType: row.memory_type,
        targetId: row.target_id,
        targetKey: row.target_key,
        score: row.score,
        recommendation: row.recommendation,
        reasons: safeJson(row.reasons_json, []),
        metadata: safeJson(row.metadata_json, {})
    }));
}

function recordRetentionDecision(input = {}) {
    if (!ensureMemorySchema()) return { ok: false, driver: getDriverName() };
    const id = `ret_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    runPrepared(
        `INSERT INTO memory_retention_decisions
            (id, memory_type, target_id, target_key, score, recommendation, reasons_json, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            input.memoryType || input.memory_type || 'memory',
            input.targetId || input.target_id || null,
            input.targetKey || input.target_key || null,
            Number.isFinite(Number(input.score)) ? Math.round(Number(input.score)) : null,
            input.recommendation || 'review',
            json(Array.isArray(input.reasons) ? input.reasons : []),
            json(input.metadata || input.metadata_json || {}),
            new Date().toISOString()
        ]
    );
    return { ok: true, id, driver: getDriverName() };
}

function upsertMemory(entry) {
    if (!ensureMemorySchema()) return { ok: false, driver: getDriverName() };
    const item = normalizeEntry(entry);
    const now = new Date().toISOString();
    const writeItem = () => {
        runPrepared(
            `INSERT INTO memories
                (id, topic, summary, timestamp, embedding_source, metadata_json, tags_json, content, lifecycle_status, trust, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                topic=excluded.topic,
                summary=excluded.summary,
                timestamp=excluded.timestamp,
                embedding_source=excluded.embedding_source,
                metadata_json=excluded.metadata_json,
                tags_json=excluded.tags_json,
                content=excluded.content,
                lifecycle_status=excluded.lifecycle_status,
                trust=excluded.trust,
                updated_at=excluded.updated_at`,
            [
                item.id,
                item.topic,
                item.summary,
                item.timestamp,
                item.embeddingSource,
                json(item.metadata),
                json(item.tags),
                item.content,
                item.lifecycleStatus,
                item.trust,
                now
            ]
        );
        runPrepared('DELETE FROM memory_fts WHERE id = ?', [item.id]);
        runPrepared(
            'INSERT INTO memory_fts (id, topic, summary, metadata, tags, content) VALUES (?, ?, ?, ?, ?, ?)',
            [item.id, item.topic, item.summary, json(item.metadata), item.tags.join(' '), item.content]
        );
    };
    try {
        writeItem();
        return { ok: true, driver: getDriverName(), id: item.id };
    } catch (error) {
        if (isSqliteCorruption(error)) {
            quarantineSqliteStore('corrupt');
            if (ensureMemorySchema()) {
                try {
                    writeItem();
                    return { ok: true, driver: getDriverName(), id: item.id, repaired: true };
                } catch (retryError) {
                    return { ok: false, driver: getDriverName(), id: item.id, error: sqliteErrorMessage(retryError) };
                }
            }
        }
        return { ok: false, driver: getDriverName(), id: item.id, error: sqliteErrorMessage(error) };
    }
}

function upsertMemoryScript(item, now) {
    return `
INSERT INTO memories
    (id, topic, summary, timestamp, embedding_source, metadata_json, tags_json, content, lifecycle_status, trust, updated_at)
VALUES (${q(item.id)}, ${q(item.topic)}, ${q(item.summary)}, ${q(item.timestamp)}, ${q(item.embeddingSource)}, ${q(json(item.metadata))}, ${q(json(item.tags))}, ${q(item.content)}, ${q(item.lifecycleStatus)}, ${q(item.trust)}, ${q(now)})
ON CONFLICT(id) DO UPDATE SET
    topic=excluded.topic,
    summary=excluded.summary,
    timestamp=excluded.timestamp,
    embedding_source=excluded.embedding_source,
    metadata_json=excluded.metadata_json,
    tags_json=excluded.tags_json,
    content=excluded.content,
    lifecycle_status=excluded.lifecycle_status,
    trust=excluded.trust,
    updated_at=excluded.updated_at;
DELETE FROM memory_fts WHERE id = ${q(item.id)};
INSERT INTO memory_fts (id, topic, summary, metadata, tags, content)
VALUES (${q(item.id)}, ${q(item.topic)}, ${q(item.summary)}, ${q(json(item.metadata))}, ${q(item.tags.join(' '))}, ${q(item.content)});
`;
}

function syncVectorEntries(entries = []) {
    if (!ensureMemorySchema()) return { ok: false, driver: getDriverName(), synced: 0 };
    const driver = getDriverName();
    const items = (entries || []).map(normalizeEntry);
    if (driver === 'sqlite3-cli') {
        try {
            const now = new Date().toISOString();
            runSqliteCli([
                'BEGIN IMMEDIATE;',
                ...items.map(item => upsertMemoryScript(item, now)),
                'COMMIT;'
            ].join('\n'));
            return { ok: true, driver, synced: items.length, batched: true };
        } catch (error) {
            if (isSqliteCorruption(error)) {
                quarantineSqliteStore('corrupt');
                if (ensureMemorySchema()) {
                    try {
                        const now = new Date().toISOString();
                        runSqliteCli([
                            'BEGIN IMMEDIATE;',
                            ...items.map(item => upsertMemoryScript(item, now)),
                            'COMMIT;'
                        ].join('\n'));
                        return { ok: true, driver: getDriverName(), synced: items.length, batched: true, repaired: true };
                    } catch (retryError) {
                        return { ok: false, driver: getDriverName(), synced: 0, error: sqliteErrorMessage(retryError) };
                    }
                }
            }
            return { ok: false, driver, synced: 0, error: sqliteErrorMessage(error) };
        }
    }
    let synced = 0;
    for (const entry of items) {
        const result = upsertMemory(entry);
        if (result.ok) synced++;
    }
    return { ok: true, driver, synced };
}

function buildFtsQuery(query) {
    const tokens = String(query || '').toLowerCase().match(/[a-z0-9_:-]+/g) || [];
    return [...new Set(tokens)]
        .slice(0, 12)
        .map(token => `"${token.replace(/"/g, '""')}"`)
        .join(' OR ');
}

function searchMemoryFts(query, { limit = 20 } = {}) {
    if (!ensureMemorySchema()) return [];
    const match = buildFtsQuery(query);
    if (!match) return [];
    let rows = [];
    try {
        rows = allSql(
            `SELECT memory_fts.id AS id,
                    memories.topic AS topic,
                    memories.summary AS summary,
                    memories.timestamp AS timestamp,
                    memories.embedding_source AS embedding_source,
                    memories.metadata_json AS metadata_json,
                    memories.tags_json AS tags_json,
                    bm25(memory_fts) AS rank
             FROM memory_fts
             JOIN memories ON memories.id = memory_fts.id
             WHERE memory_fts MATCH ?
             ORDER BY rank
             LIMIT ?`,
            [match, Math.max(1, Math.min(100, Number(limit) || 20))]
        );
    } catch (error) {
        if (isSqliteCorruption(error)) {
            quarantineSqliteStore('corrupt');
            ensureMemorySchema();
        }
        return [];
    }
    return rows.map((row, index) => ({
        id: row.id,
        topic: row.topic,
        summary: row.summary,
        timestamp: row.timestamp,
        embeddingSource: row.embedding_source,
        metadata: safeJson(row.metadata_json, {}),
        tags: safeJson(row.tags_json, []),
        ftsRank: index + 1,
        ftsScore: Number(row.rank)
    }));
}

function safeJson(value, fallback) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch (e) {
        return fallback;
    }
}

function listSqliteMemories({ limit = 100 } = {}) {
    if (!ensureMemorySchema()) return [];
    let rows = [];
    try {
        rows = allSql(
            `SELECT id, topic, summary, timestamp, embedding_source, metadata_json, tags_json, lifecycle_status, trust, updated_at
             FROM memories
             ORDER BY timestamp DESC
             LIMIT ?`,
            [Math.max(1, Math.min(500, Number(limit) || 100))]
        );
    } catch (error) {
        if (isSqliteCorruption(error)) {
            quarantineSqliteStore('corrupt');
            ensureMemorySchema();
        }
        return [];
    }
    return rows.map(row => ({
        id: row.id,
        topic: row.topic,
        summary: row.summary,
        timestamp: row.timestamp,
        embeddingSource: row.embedding_source,
        metadata: safeJson(row.metadata_json, {}),
        tags: safeJson(row.tags_json, []),
        lifecycleStatus: row.lifecycle_status,
        trust: row.trust,
        updatedAt: row.updated_at
    }));
}

function deleteMemory(id) {
    if (!id || !ensureMemorySchema()) return false;
    try {
        runPrepared('DELETE FROM memory_fts WHERE id = ?', [id]);
        runPrepared('DELETE FROM memories WHERE id = ?', [id]);
        return true;
    } catch (error) {
        if (isSqliteCorruption(error)) {
            quarantineSqliteStore('corrupt');
            ensureMemorySchema();
        }
        return false;
    }
}

function recordProviderEvent(providerId, hook, payload = {}) {
    if (!ensureMemorySchema()) return { ok: false, driver: getDriverName() };
    const id = `mpe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    try {
        runPrepared(
            'INSERT INTO memory_provider_events (id, provider_id, hook, session_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [id, providerId, hook, payload.session_id || payload.sessionId || '', json(payload), new Date().toISOString()]
        );
        return { ok: true, id, driver: getDriverName() };
    } catch (error) {
        if (isSqliteCorruption(error)) {
            quarantineSqliteStore('corrupt');
            if (ensureMemorySchema()) {
                try {
                    runPrepared(
                        'INSERT INTO memory_provider_events (id, provider_id, hook, session_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                        [id, providerId, hook, payload.session_id || payload.sessionId || '', json(payload), new Date().toISOString()]
                    );
                    return { ok: true, id, driver: getDriverName(), repaired: true };
                } catch (retryError) {
                    return { ok: false, id, driver: getDriverName(), error: sqliteErrorMessage(retryError) };
                }
            }
        }
        return { ok: false, id, driver: getDriverName(), error: sqliteErrorMessage(error) };
    }
}

function deleteProviderEvent(id) {
    if (!id || !ensureMemorySchema()) return false;
    try {
        runPrepared('DELETE FROM memory_provider_events WHERE id = ?', [id]);
        return true;
    } catch (error) {
        if (isSqliteCorruption(error)) {
            quarantineSqliteStore('corrupt');
            ensureMemorySchema();
        }
        return false;
    }
}

function listProviderEvents({ limit = 50 } = {}) {
    if (!ensureMemorySchema()) return [];
    let rows = [];
    try {
        rows = allSql(
            `SELECT id, provider_id, hook, session_id, payload_json, created_at
             FROM memory_provider_events
             ORDER BY created_at DESC
             LIMIT ?`,
            [Math.max(1, Math.min(200, Number(limit) || 50))]
        );
    } catch (error) {
        if (isSqliteCorruption(error)) {
            quarantineSqliteStore('corrupt');
            ensureMemorySchema();
        }
        return [];
    }
    return rows.map(row => ({
        id: row.id,
        providerId: row.provider_id,
        hook: row.hook,
        sessionId: row.session_id,
        payload: safeJson(row.payload_json, {}),
        createdAt: row.created_at
    }));
}

function getMemoryStoreStatus() {
    const driver = getDriverName();
    const exists = fs.existsSync(SQLITE_MEMORY_FILE);
    const schemaReady = driver !== 'unavailable' ? ensureMemorySchema() : false;
    let count = 0;
    if (schemaReady) {
        try {
            count = allSql('SELECT COUNT(*) AS count FROM memories')[0]?.count || 0;
        } catch (error) {
            if (isSqliteCorruption(error)) {
                quarantineSqliteStore('corrupt');
                ensureMemorySchema();
            }
            count = 0;
        }
    }
    return {
        driver,
        available: schemaReady,
        path: SQLITE_MEMORY_FILE,
        exists,
        count: Number(count) || 0,
        lastError: sqliteLastError,
        unavailableUntil: sqliteUnavailableUntil ? new Date(sqliteUnavailableUntil).toISOString() : ''
    };
}

module.exports = {
    SQLITE_MEMORY_FILE,
    createMemoryProposal,
    deleteMemory,
    deleteMemoryFact,
    deleteProviderEvent,
    getMemoryProposal,
    getMemoryStoreStatus,
    getSchemaMeta,
    listMemoryFacts,
    listMemoryProposals,
    listMemoryUsage,
    listModelObservations,
    listProviderEvents,
    listRetentionDecisions,
    listSchemaMeta,
    listSqliteMemories,
    recordMemoryUsage,
    recordModelObservation,
    recordProviderEvent,
    recordRetentionDecision,
    searchMemoryFacts,
    searchMemoryFts,
    setSchemaMeta,
    syncVectorEntries,
    updateMemoryLifecycle,
    updateMemoryProposal,
    upsertMemory,
    upsertMemoryFact
};
