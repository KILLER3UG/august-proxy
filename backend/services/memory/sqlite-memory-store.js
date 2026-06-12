const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SQLITE_MEMORY_FILE = path.join(__dirname, '..', '..', '..', 'data', 'august_brain.sqlite');
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
    deleteMemory,
    deleteProviderEvent,
    getMemoryStoreStatus,
    listProviderEvents,
    listSqliteMemories,
    recordProviderEvent,
    searchMemoryFts,
    syncVectorEntries,
    upsertMemory
};
