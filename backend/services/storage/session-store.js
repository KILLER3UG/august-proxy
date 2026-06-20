/**
 * session-store.js — SQLite-based session persistence
 * Replaces JSON file-based session storage with a proper SQLite schema.
 * Features: WAL mode, FTS5 search, compression chaining, retry logic.
 */

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../../lib/config');
const { getDataDir } = require('../../lib/data-paths');

const DATA_DIR = getDataDir();
const DB_PATH = path.join(DATA_DIR, 'august-sessions.db');
const WAL_PATH = DB_PATH + '-wal';
const SHM_PATH = DB_PATH + '-shm';

let db = null;
let ready = false;

// ── Schema ──

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  title         TEXT DEFAULT '',
  agent_type    TEXT DEFAULT 'general',
  provider      TEXT DEFAULT '',
  model         TEXT DEFAULT '',
  status        TEXT DEFAULT 'idle',
  parent_id     TEXT REFERENCES sessions(id),
  cwd           TEXT DEFAULT '',
  task          TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  end_reason    TEXT,
  message_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  total_tokens  INTEGER DEFAULT 0,
  total_cost    REAL DEFAULT 0.0,
  metadata      TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  role        TEXT NOT NULL,
  content     TEXT DEFAULT '',
  tool_calls  TEXT DEFAULT '[]',
  tool_call_id TEXT DEFAULT '',
  tool_name   TEXT DEFAULT '',
  finish_reason TEXT DEFAULT '',
  token_count INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  active      INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tool_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER REFERENCES messages(id),
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  tool_name   TEXT NOT NULL,
  tool_input  TEXT DEFAULT '',
  tool_output TEXT DEFAULT '',
  duration_ms INTEGER DEFAULT 0,
  error       TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  request_id          TEXT DEFAULT '',
  source              TEXT DEFAULT 'unknown',
  request_type        TEXT DEFAULT '',
  model               TEXT DEFAULT '',
  provider            TEXT DEFAULT '',
  input_tokens        INTEGER DEFAULT 0,
  output_tokens       INTEGER DEFAULT 0,
  cache_creation_input_tokens INTEGER DEFAULT 0,
  cache_read_input_tokens     INTEGER DEFAULT 0,
  total_tokens        INTEGER DEFAULT 0,
  input_cost_per_1m   REAL DEFAULT 0.0,
  output_cost_per_1m  REAL DEFAULT 0.0,
  input_cost          REAL DEFAULT 0.0,
  output_cost         REAL DEFAULT 0.0,
  total_cost          REAL DEFAULT 0.0,
  metadata            TEXT DEFAULT '{}',
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS compression_locks (
  session_id  TEXT PRIMARY KEY REFERENCES sessions(id),
  locked_at   TEXT NOT NULL DEFAULT (datetime('now')),
  holder      TEXT DEFAULT '',
  ttl_seconds INTEGER DEFAULT 300
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_active ON messages(session_id, active);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_tool_results_session ON tool_results(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_results_message ON tool_results(message_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);

-- FTS5 virtual tables for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, session_id,
  content=messages,
  content_rowid=id,
  tokenize='unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  title, task,
  content=sessions,
  content_rowid=rowid,
  tokenize='unicode61'
);
`;

// ── Triggers to keep FTS in sync ──

const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, session_id)
  VALUES (new.id, new.content, new.session_id);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, session_id)
  VALUES ('delete', old.id, old.content, old.session_id);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, session_id)
  VALUES ('delete', old.id, old.content, old.session_id);
  INSERT INTO messages_fts(rowid, content, session_id)
  VALUES (new.id, new.content, new.session_id);
END;

CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
  INSERT INTO sessions_fts(rowid, title, task)
  VALUES (new.rowid, new.title, new.task);
END;

CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, title, task)
  VALUES ('delete', old.rowid, old.title, old.task);
END;

CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, title, task)
  VALUES ('delete', old.rowid, old.title, old.task);
  INSERT INTO sessions_fts(rowid, title, task)
  VALUES (new.rowid, new.title, new.task);
END;
`;

// ── Helpers ──

function q(v) {
  if (v === undefined || v === null) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function json(v) {
  return JSON.stringify(v === undefined ? null : v);
}

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Initialization ──

async function init() {
  if (ready) return;
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('PRAGMA cache_size=-64000');
    db.exec('PRAGMA foreign_keys=ON');

    // Create tables
    for (const stmt of SCHEMA_SQL.split(';').filter(s => s.trim())) {
      db.exec(stmt + ';');
    }

    // Create triggers
    for (const stmt of FTS_TRIGGERS.split(';').filter(s => s.trim())) {
      try { db.exec(stmt + ';'); } catch (e) { /* trigger may already exist */ }
    }

    ready = true;
    console.log('[SessionStore] Initialized SQLite session store at', DB_PATH);
  } catch (e) {
    console.error('[SessionStore] Failed to initialize:', e.message);
    throw e;
  }
}

// ── Session CRUD ──

function createSession({ id, title, agent_type, provider, model, cwd, task, parent_id, metadata }) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO sessions (id, title, agent_type, provider, model, cwd, task, parent_id, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id || crypto.randomUUID(),
    title || '',
    agent_type || 'general',
    provider || '',
    model || '',
    cwd || '',
    task || '',
    parent_id || null,
    json(metadata || {}),
    now(), now()
  );
}

function getSession(id) {
  const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const row = stmt.get(id);
  if (!row) return null;
  try { row.metadata = JSON.parse(row.metadata || '{}'); } catch (e) { row.metadata = {}; }
  return row;
}

function updateSession(id, updates) {
  const fields = [];
  const vals = [];
  for (const [k, v] of Object.entries(updates)) {
    if (k === 'id') continue;
    if (k === 'metadata') { fields.push('metadata=?'); vals.push(json(v)); continue; }
    fields.push(`${k}=?`);
    vals.push(v);
  }
  fields.push('updated_at=?');
  vals.push(now());
  vals.push(id);
  const stmt = db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id=?`);
  stmt.run(...vals);
}

function listSessions(opts = {}) {
  const { status, agent_type, limit, offset, order } = opts;
  let sql = 'SELECT * FROM sessions WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status=?'; params.push(status); }
  if (agent_type) { sql += ' AND agent_type=?'; params.push(agent_type); }
  sql += ` ORDER BY ${order === 'oldest' ? 'created_at ASC' : 'updated_at DESC'}`;
  if (limit) { sql += ' LIMIT ?'; params.push(limit); }
  if (offset) { sql += ' OFFSET ?'; params.push(offset); }
  const rows = db.prepare(sql).all(...params);
  for (const row of rows) {
    try { row.metadata = JSON.parse(row.metadata || '{}'); } catch (e) { row.metadata = {}; }
  }
  return rows;
}

function deleteSession(id) {
  db.prepare('DELETE FROM usage_events WHERE session_id=?').run(id);
  db.prepare('DELETE FROM tool_results WHERE session_id=?').run(id);
  db.prepare('DELETE FROM messages WHERE session_id=?').run(id);
  db.prepare('DELETE FROM compression_locks WHERE session_id=?').run(id);
  db.prepare('DELETE FROM sessions WHERE id=?').run(id);
}

// ── Message CRUD ──

function appendMessage(sessionId, msg) {
  const stmt = db.prepare(`
    INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, tool_name, finish_reason, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    sessionId,
    msg.role || 'user',
    msg.content || '',
    json(msg.tool_calls || []),
    msg.tool_call_id || '',
    msg.tool_name || '',
    msg.finish_reason || '',
    msg.token_count || 0,
    now()
  );
  // Update session message count
  db.prepare('UPDATE sessions SET message_count=message_count+1, updated_at=? WHERE id=?').run(now(), sessionId);
  return result.lastInsertRowid;
}

function getMessages(sessionId, opts = {}) {
  const { active, limit, offset, include_inactive } = opts;
  let sql = 'SELECT * FROM messages WHERE session_id=?';
  const params = [sessionId];
  if (!include_inactive) { sql += ' AND active=1'; }
  sql += ' ORDER BY id ASC';
  if (limit) { sql += ' LIMIT ?'; params.push(limit); }
  if (offset) { sql += ' OFFSET ?'; params.push(offset); }
  const rows = db.prepare(sql).all(...params);
  for (const row of rows) {
    try { row.tool_calls = JSON.parse(row.tool_calls || '[]'); } catch (e) { row.tool_calls = []; }
  }
  return rows;
}

function getMessagesAround(sessionId, messageId, window = 5) {
  // Find the anchor position
  const anchor = db.prepare('SELECT id FROM messages WHERE session_id=? AND id=?').get(sessionId, messageId);
  if (!anchor) return [];
  const before = db.prepare('SELECT * FROM messages WHERE session_id=? AND id<? AND active=1 ORDER BY id DESC LIMIT ?').all(sessionId, messageId, window).reverse();
  const after = db.prepare('SELECT * FROM messages WHERE session_id=? AND id>? AND active=1 ORDER BY id ASC LIMIT ?').all(sessionId, messageId, window);
  const center = db.prepare('SELECT * FROM messages WHERE session_id=? AND id=?').get(sessionId, messageId);
  const rows = [...before, center, ...after].filter(Boolean);
  for (const row of rows) {
    try { row.tool_calls = JSON.parse(row.tool_calls || '[]'); } catch (e) { row.tool_calls = []; }
  }
  return rows;
}

function rewindToMessage(sessionId, messageId) {
  db.prepare('UPDATE messages SET active=0 WHERE session_id=? AND id>?').run(sessionId, messageId);
  db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now(), sessionId);
}

function replaceMessages(sessionId, oldIds, newMessages) {
  const del = db.prepare('UPDATE messages SET active=0 WHERE session_id=? AND id IN (' + oldIds.map(() => '?').join(',') + ')');
  del.run(sessionId, ...oldIds);
  for (const msg of newMessages) {
    appendMessage(sessionId, msg);
  }
}

function countMessages(sessionId) {
  const row = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id=? AND active=1').get(sessionId);
  return row.count;
}

// ── FTS5 Search ──

function searchSessions(query, opts = {}) {
  const { limit, offset } = opts;
  // Escape FTS5 query special chars
  const sanitized = query.replace(/[+{}():^*"]/g, '').trim();
  if (!sanitized) return [];

  const sql = `
    SELECT s.*, snippet(messages_fts, 1, '>>>', '<<<', '...', 40) as snippet
    FROM sessions s
    JOIN messages m ON m.session_id = s.id
    JOIN messages_fts fts ON fts.rowid = m.id
    WHERE messages_fts MATCH ?
    GROUP BY s.id
    ORDER BY rank
    LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(sql).all(sanitized, limit || 10, offset || 0);
  for (const row of rows) {
    try { row.metadata = JSON.parse(row.metadata || '{}'); } catch (e) { row.metadata = {}; }
  }
  return rows;
}

function searchMessages(query, opts = {}) {
  const { sessionId, limit, offset } = opts;
  const sanitized = query.replace(/[+{}():^*"]/g, '').trim();
  if (!sanitized) return [];

  let sql = `
    SELECT m.*, snippet(messages_fts, 1, '>>>', '<<<', '...', 40) as snippet
    FROM messages m
    JOIN messages_fts fts ON fts.rowid = m.id
    WHERE messages_fts MATCH ?
  `;
  const params = [sanitized];
  if (sessionId) { sql += ' AND m.session_id=?'; params.push(sessionId); }
  sql += ' ORDER BY rank LIMIT ? OFFSET ?';
  params.push(limit || 20, offset || 0);

  const rows = db.prepare(sql).all(...params);
  for (const row of rows) {
    try { row.tool_calls = JSON.parse(row.tool_calls || '[]'); } catch (e) { row.tool_calls = []; }
  }
  return rows;
}

// ── Tool Result Storage ──

function storeToolResult({ messageId, sessionId, toolName, toolInput, toolOutput, durationMs, error }) {
  const stmt = db.prepare(`
    INSERT INTO tool_results (message_id, session_id, tool_name, tool_input, tool_output, duration_ms, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    messageId || null,
    sessionId,
    toolName,
    json(toolInput || {}),
    typeof toolOutput === 'string' ? toolOutput.substring(0, 100000) : json(toolOutput || ''),
    durationMs || 0,
    error || '',
    now()
  );
}

function getToolResults(sessionId, opts = {}) {
  const { limit, offset, toolName } = opts;
  let sql = 'SELECT * FROM tool_results WHERE session_id=?';
  const params = [sessionId];
  if (toolName) { sql += ' AND tool_name=?'; params.push(toolName); }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit || 50, offset || 0);
  return db.prepare(sql).all(...params);
}

// ── Usage Event Storage ──

function recordUsageEvent({
  sessionId,
  requestId = '',
  source = 'unknown',
  requestType = '',
  model = '',
  provider = '',
  inputTokens = 0,
  outputTokens = 0,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0,
  totalTokens = 0,
  inputCostPer1M = 0,
  outputCostPer1M = 0,
  inputCost = 0,
  outputCost = 0,
  totalCost = 0,
  metadata = {},
} = {}) {
  if (!ready || !sessionId) return null;

  const normalizedTotalTokens = Number(totalTokens) || Number(inputTokens || 0) + Number(outputTokens || 0);
  if (normalizedTotalTokens <= 0 && Number(inputCost || 0) <= 0 && Number(outputCost || 0) <= 0) {
    return null;
  }

  const result = db.prepare(`
    INSERT INTO usage_events (
      session_id, request_id, source, request_type, model, provider,
      input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
      input_cost_per_1m, output_cost_per_1m, input_cost, output_cost, total_cost, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    requestId || '',
    source || 'unknown',
    requestType || '',
    model || '',
    provider || '',
    Number(inputTokens || 0),
    Number(outputTokens || 0),
    Number(cacheCreationInputTokens || 0),
    Number(cacheReadInputTokens || 0),
    normalizedTotalTokens,
    Number(inputCostPer1M || 0),
    Number(outputCostPer1M || 0),
    Number(inputCost || 0),
    Number(outputCost || 0),
    Number(totalCost || 0),
    json(metadata || {}),
    now()
  );

  db.prepare(`
    UPDATE sessions
    SET total_tokens = total_tokens + ?,
        total_cost = total_cost + ?,
        model = COALESCE(NULLIF(?, ''), model),
        provider = COALESCE(NULLIF(?, ''), provider),
        updated_at = ?
    WHERE id = ?
  `).run(normalizedTotalTokens, Number(totalCost || 0), model || '', provider || '', now(), sessionId);

  const row = getSessionUsageEvent(result.lastInsertRowid);
  return row;
}

function getSessionUsageEvent(id) {
  const row = db.prepare('SELECT * FROM usage_events WHERE id = ?').get(id);
  if (!row) return null;
  try { row.metadata = JSON.parse(row.metadata || '{}'); } catch (e) { row.metadata = {}; }
  return row;
}

function listUsageEvents(sessionId, opts = {}) {
  if (!ready) return [];
  const { limit, offset, order = 'desc' } = opts;
  let sql = 'SELECT * FROM usage_events WHERE 1=1';
  const params = [];
  if (sessionId) { sql += ' AND session_id=?'; params.push(sessionId); }
  sql += ` ORDER BY created_at ${order === 'asc' ? 'ASC' : 'DESC'}, id ${order === 'asc' ? 'ASC' : 'DESC'}`;
  if (limit) { sql += ' LIMIT ?'; params.push(limit); }
  if (offset) { sql += ' OFFSET ?'; params.push(offset); }
  const rows = db.prepare(sql).all(...params);
  for (const row of rows) {
    try { row.metadata = JSON.parse(row.metadata || '{}'); } catch (e) { row.metadata = {}; }
  }
  return rows;
}

// ── Compression Locks ──

function acquireCompressionLock(sessionId, holder, ttlSeconds = 300) {
  const existing = db.prepare('SELECT * FROM compression_locks WHERE session_id=?').get(sessionId);
  if (existing) {
    const elapsed = (Date.now() - new Date(existing.locked_at).getTime()) / 1000;
    if (elapsed < existing.ttl_seconds && existing.holder !== holder) {
      return false; // Lock held by another
    }
  }
  db.prepare(`
    INSERT OR REPLACE INTO compression_locks (session_id, locked_at, holder, ttl_seconds)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, now(), holder, ttlSeconds);
  return true;
}

function releaseCompressionLock(sessionId) {
  db.prepare('DELETE FROM compression_locks WHERE session_id=?').run(sessionId);
}

// ── Cleanup ──

function pruneSessions(olderThanDays = 30) {
  const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
  const old = db.prepare("SELECT id FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?").all(cutoff);
  for (const row of old) deleteSession(row.id);
  return old.length;
}

// ── Migration from JSON files ──

async function migrateFromJson() {
  const JSON_SESSIONS = path.join(DATA_DIR, 'august_agent_sessions.json');
  if (!fs.existsSync(JSON_SESSIONS)) return 0;

  try {
    const data = JSON.parse(fs.readFileSync(JSON_SESSIONS, 'utf8'));
    const sessions = Array.isArray(data) ? data : data.sessions || [];
    let count = 0;
    for (const s of sessions) {
      try {
        createSession({
          id: s.id,
          title: s.title || '',
          agent_type: s.agent || s.agent_type || 'general',
          provider: s.provider || '',
          model: s.model || '',
          cwd: s.cwd || '',
          task: s.task || '',
          parent_id: s.parentId || s.parent_id,
          metadata: { legacy: true, todos: s.todos, permissions: s.permissions, questions: s.questions }
        });
        if (s.messages && Array.isArray(s.messages)) {
          for (const m of s.messages) {
            appendMessage(s.id, {
              role: m.role || 'user',
              content: m.content || '',
              tool_calls: m.tool_calls,
              tool_call_id: m.tool_call_id,
              tool_name: m.tool_name,
              finish_reason: m.finish_reason,
              token_count: m.token_count
            });
          }
        }
        count++;
      } catch (e) {
        console.warn(`[SessionStore] Migration skipped session ${s.id}: ${e.message}`);
      }
    }
    // Backup and remove old file
    fs.renameSync(JSON_SESSIONS, JSON_SESSIONS + '.backup');
    console.log(`[SessionStore] Migrated ${count} sessions from JSON`);
    return count;
  } catch (e) {
    console.error('[SessionStore] Migration failed:', e.message);
    return 0;
  }
}

// ── Shutdown ──

function close() {
  if (db) {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
    try { db.close(); } catch (e) {}
    db = null;
    ready = false;
    console.log('[SessionStore] Closed');
  }
}

module.exports = {
  init,
  close,
  migrateFromJson,
  createSession, getSession, updateSession, listSessions, deleteSession, pruneSessions,
  appendMessage, getMessages, getMessagesAround, rewindToMessage, replaceMessages, countMessages,
  searchSessions, searchMessages,
  storeToolResult, getToolResults,
  recordUsageEvent, listUsageEvents,
  acquireCompressionLock, releaseCompressionLock,
  getDbPath: () => DB_PATH,
  isReady: () => ready
};
