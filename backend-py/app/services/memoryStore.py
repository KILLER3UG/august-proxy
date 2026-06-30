"""
SQLite memory store — persists conversations, facts, proposals, lifecycle,
and index data. The core persistence layer for the August "brain".

Port of backend/services/memory/sqlite-memory-store.js (1,431 lines).
Uses aiosqlite for async access and a sync sqlite3 fallback.
"""
from __future__ import annotations
import json
import os
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from app.lib.paths import dataPath
_BRAINFileEnv = 'AUGUST_BRAIN_SQLITE_FILE'
_DEFAULTBrainFile = 'august_brain.sqlite'
_TIMEOUTMs = 10000
_BUSYRetries = 2
_local = threading.local()

def _dbPath() -> Path:
    """Resolve the brain SQLite database path."""
    envPath = os.environ.get(_BRAINFileEnv)
    if envPath:
        return Path(envPath)
    return dataPath(_DEFAULTBrainFile)

def _conn() -> sqlite3.Connection:
    """Get a thread-local connection to the brain database."""
    if not hasattr(_local, 'conn') or _local.conn is None:
        dbPath = _dbPath()
        dbPath.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(dbPath), timeout=_TIMEOUTMs / 1000)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA busy_timeout=10000')
        conn.execute('PRAGMA foreign_keys=ON')
        _local.conn = conn
    return _local.conn

def close() -> None:
    """Close the thread-local connection."""
    if hasattr(_local, 'conn') and _local.conn is not None:
        try:
            _local.conn.close()
        except Exception:
            pass
        _local.conn = None

def _q(value: Any) -> str:
    """Quote a value for SQL (sync helper)."""
    if value is None:
        return 'NULL'
    return f"'{str(value).replace(chr(39), chr(39) + chr(39))}'"

def _json(value: Any) -> str:
    """Serialize a value to JSON for storage."""
    return json.dumps(value)

def init() -> None:
    """Create all tables on first use."""
    conn = _conn()
    conn.executescript("\n        CREATE TABLE IF NOT EXISTS memory_store (\n            key TEXT PRIMARY KEY,\n            value TEXT,\n            updated_at TEXT DEFAULT (datetime('now'))\n        );\n\n        -- FTS5 on memory_store (content-sync table — triggers added below in Phase 0)\n        CREATE VIRTUAL TABLE IF NOT EXISTS memory_store_fts USING fts5(\n            key, value, content='memory_store', content_rowid='rowid'\n        );\n\n        CREATE TABLE IF NOT EXISTS facts (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            fact_key TEXT UNIQUE NOT NULL,\n            fact_value TEXT NOT NULL,\n            category TEXT DEFAULT 'general',\n            source TEXT DEFAULT '',\n            confidence REAL DEFAULT 1.0,\n            created_at TEXT DEFAULT (datetime('now')),\n            updated_at TEXT DEFAULT (datetime('now'))\n        );\n\n        CREATE TABLE IF NOT EXISTS proposals (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            session_id TEXT NOT NULL,\n            proposal_type TEXT NOT NULL,\n            content TEXT,\n            status TEXT DEFAULT 'pending',\n            created_at TEXT DEFAULT (datetime('now')),\n            decided_at TEXT,\n            decided_by TEXT\n        );\n\n        CREATE TABLE IF NOT EXISTS lifecycle (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            session_id TEXT,\n            event_type TEXT NOT NULL,\n            detail TEXT,\n            created_at TEXT DEFAULT (datetime('now'))\n        );\n\n        CREATE TABLE IF NOT EXISTS session_topics (\n            session_id TEXT PRIMARY KEY,\n            topic TEXT NOT NULL,\n            parent_topic TEXT,\n            confidence REAL DEFAULT 0.75,\n            classified_at TEXT DEFAULT (datetime('now'))\n        );\n\n        CREATE TABLE IF NOT EXISTS sessions (\n            id TEXT PRIMARY KEY,\n            title TEXT,\n            started_at TEXT,\n            message_count INTEGER DEFAULT 0,\n            provider TEXT DEFAULT '',\n            model TEXT DEFAULT '',\n            folder_id TEXT,\n            is_archived INTEGER DEFAULT 0,\n            workspace_path TEXT\n        );\n\n        CREATE TABLE IF NOT EXISTS messages (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            session_id TEXT NOT NULL,\n            role TEXT NOT NULL,\n            content TEXT,\n            created_at TEXT DEFAULT (datetime('now')),\n            FOREIGN KEY (session_id) REFERENCES sessions(id)\n        );\n\n        CREATE TABLE IF NOT EXISTS usage_events (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            session_id TEXT,\n            model TEXT,\n            input_tokens INTEGER DEFAULT 0,\n            output_tokens INTEGER DEFAULT 0,\n            context_tokens INTEGER DEFAULT 0,\n            created_at TEXT DEFAULT (datetime('now'))\n        );\n\n        CREATE TABLE IF NOT EXISTS config_audit (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            category TEXT NOT NULL,\n            action TEXT NOT NULL,\n            actor TEXT DEFAULT '',\n            before_json TEXT,\n            after_json TEXT,\n            created_at TEXT DEFAULT (datetime('now'))\n        );\n\n        -- ═══════════════════════════════════════════════════════════════\n        -- Phase 0: Learned Heuristics table\n        -- ═══════════════════════════════════════════════════════════════\n        CREATE TABLE IF NOT EXISTS learned_heuristics (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            rule TEXT NOT NULL,\n            source TEXT DEFAULT '',\n            category TEXT DEFAULT 'general',\n            created_at TEXT DEFAULT (datetime('now')),\n            updated_at TEXT DEFAULT (datetime('now'))\n        );\n\n        -- ═══════════════════════════════════════════════════════════════\n        -- Phase 0: Flattened auto_memories (individual FTS-indexed rows)\n        -- ═══════════════════════════════════════════════════════════════\n        CREATE TABLE IF NOT EXISTS auto_memories (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            key TEXT,\n            content TEXT,\n            category TEXT DEFAULT 'auto',\n            importance REAL DEFAULT 0.5,\n            source TEXT DEFAULT '',\n            created_at TEXT DEFAULT (datetime('now')),\n            updated_at TEXT DEFAULT (datetime('now'))\n        );\n\n        CREATE VIRTUAL TABLE IF NOT EXISTS auto_memories_fts USING fts5(\n            key, content, content='auto_memories', content_rowid='rowid'\n        );\n\n        -- ═══════════════════════════════════════════════════════════════\n        -- Phase 0: FTS5 triggers — CRITICAL — without these FTS indexes\n        -- stay empty. Both memory_store_fts and auto_memories_fts need\n        -- INSERT/UPDATE/DELETE triggers.\n        -- ═══════════════════════════════════════════════════════════════\n\n        -- memory_store_fts triggers (fixes existing broken FTS)\n        CREATE TRIGGER IF NOT EXISTS memory_store_fts_ai AFTER INSERT ON memory_store BEGIN\n            INSERT INTO memory_store_fts(rowid, key, value)\n            VALUES (new.rowid, new.key, new.value);\n        END;\n        CREATE TRIGGER IF NOT EXISTS memory_store_fts_ad AFTER DELETE ON memory_store BEGIN\n            INSERT INTO memory_store_fts(memory_store_fts, rowid, key, value)\n            VALUES('delete', old.rowid, old.key, old.value);\n        END;\n        CREATE TRIGGER IF NOT EXISTS memory_store_fts_au AFTER UPDATE ON memory_store BEGIN\n            INSERT INTO memory_store_fts(memory_store_fts, rowid, key, value)\n            VALUES('delete', old.rowid, old.key, old.value);\n            INSERT INTO memory_store_fts(rowid, key, value)\n            VALUES (new.rowid, new.key, new.value);\n        END;\n\n        -- auto_memories_fts triggers\n        CREATE TRIGGER IF NOT EXISTS auto_memories_ai AFTER INSERT ON auto_memories BEGIN\n            INSERT INTO auto_memories_fts(rowid, key, content)\n            VALUES (new.id, new.key, new.content);\n        END;\n        CREATE TRIGGER IF NOT EXISTS auto_memories_ad AFTER DELETE ON auto_memories BEGIN\n            INSERT INTO auto_memories_fts(auto_memories_fts, rowid, key, content)\n            VALUES('delete', old.id, old.key, old.content);\n        END;\n        CREATE TRIGGER IF NOT EXISTS auto_memories_au AFTER UPDATE ON auto_memories BEGIN\n            INSERT INTO auto_memories_fts(auto_memories_fts, rowid, key, content)\n            VALUES('delete', old.id, old.key, old.content);\n            INSERT INTO auto_memories_fts(rowid, key, content)\n            VALUES (new.id, new.key, new.content);\n        END;\n\n        CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);\n        CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updated_at);\n        CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(session_id);\n        CREATE INDEX IF NOT EXISTS idx_lifecycle_session ON lifecycle(session_id);\n        CREATE INDEX IF NOT EXISTS idx_lifecycle_event ON lifecycle(event_type);\n        CREATE INDEX IF NOT EXISTS idx_config_audit_category ON config_audit(category);\n        CREATE INDEX IF NOT EXISTS idx_config_audit_created ON config_audit(created_at);\n    ")
    conn.commit()
    rowCount = conn.execute('SELECT count(*) FROM memory_store_fts').fetchone()[0]
    if rowCount == 0:
        conn.execute('\n        INSERT INTO memory_store_fts(rowid, key, value)\n        SELECT rowid, key, value FROM memory_store\n    ')
    conn.commit()
    try:
        cols = [r['name'] for r in conn.execute('PRAGMA table_info(auto_memories)').fetchall()]
        if 'updated_at' not in cols:
            conn.execute('ALTER TABLE auto_memories ADD COLUMN updated_at TEXT')
    except Exception as exc:
        import logging
        logging.warning('auto_memories updated_at migration failed: %s', exc)
    conn.execute("\n        CREATE TABLE IF NOT EXISTS episodic_timeline (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            timestamp TEXT,\n            session_id TEXT,\n            event_summary TEXT,\n            category TEXT DEFAULT 'general'\n        )\n    ")
    conn.execute("\n        CREATE TABLE IF NOT EXISTS blackboard (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            session_id TEXT NOT NULL,\n            agent TEXT NOT NULL DEFAULT 'main',\n            key TEXT NOT NULL,\n            value TEXT NOT NULL,\n            priority INTEGER DEFAULT 0,\n            created_at TEXT DEFAULT (datetime('now')),\n            expires_at TEXT\n        )\n    ")
    conn.execute("\n        CREATE TABLE IF NOT EXISTS exams (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            title TEXT NOT NULL,\n            topic TEXT DEFAULT '',\n            created_at TEXT DEFAULT (datetime('now')),\n            source TEXT DEFAULT 'model',\n            source_files TEXT DEFAULT ''\n        )\n    ")
    conn.execute("\n        CREATE TABLE IF NOT EXISTS exam_questions (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            exam_id INTEGER NOT NULL,\n            position INTEGER NOT NULL,\n            stem TEXT NOT NULL,\n            options TEXT NOT NULL,\n            correct_index INTEGER NOT NULL,\n            rationale TEXT DEFAULT '',\n            source_snippet TEXT DEFAULT '',\n            origin TEXT DEFAULT 'generated',\n            FOREIGN KEY (exam_id) REFERENCES exams(id)\n        )\n    ")
    conn.execute("\n        CREATE TABLE IF NOT EXISTS exam_attempts (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            exam_id INTEGER NOT NULL,\n            question_id INTEGER NOT NULL,\n            selected_index INTEGER,\n            is_correct INTEGER DEFAULT 0,\n            asked_for_help INTEGER DEFAULT 0,\n            answered_at TEXT DEFAULT (datetime('now'))\n        )\n    ")
    conn.execute("\n        CREATE TABLE IF NOT EXISTS pending_skills (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            name TEXT UNIQUE NOT NULL,\n            description TEXT,\n            trigger_text TEXT,\n            draft_path TEXT NOT NULL,\n            source_session_id TEXT,\n            source_workflow TEXT,\n            created_by TEXT DEFAULT 'auto-gen',\n            created_at TEXT DEFAULT (datetime('now')),\n            status TEXT DEFAULT 'pending',\n            use_count INTEGER DEFAULT 0,\n            last_surfaced_at TEXT\n        )\n    ")
    conn.commit()
    _ensureColumn(conn, 'usage_events', 'context_tokens', 'INTEGER DEFAULT 0')

def _ensureColumn(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    """Add a column to a table if it does not already exist (idempotent)."""
    cols = {row['name'] for row in conn.execute(f'PRAGMA table_info({table})').fetchall()}
    if column not in cols:
        conn.execute(f'ALTER TABLE {table} ADD COLUMN {column} {decl}')
        conn.commit()

def saveMemory(key: str, value: Any) -> None:
    """Save a key-value pair to memory."""
    conn = _conn()
    conn.execute("INSERT OR REPLACE INTO memory_store (key, value, updated_at) VALUES (?, ?, datetime('now'))", (key, _json(value)))
    conn.commit()

def getMemory(key: str) -> Any | None:
    """Get a value from memory by key."""
    conn = _conn()
    row = conn.execute('SELECT value FROM memory_store WHERE key = ?', (key,)).fetchone()
    if row:
        try:
            return json.loads(row['value'])
        except (json.JSONDecodeError, TypeError):
            return row['value']
    return None

def deleteMemory(key: str) -> bool:
    """Delete a memory key. Returns True if it existed."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM memory_store WHERE key = ?', (key,))
    conn.commit()
    return cursor.rowcount > 0

def listMemory(pattern: str='%') -> list[dict[str, Any]]:
    """List memory entries with optional key pattern matching."""
    conn = _conn()
    rows = conn.execute('SELECT key, value, updated_at FROM memory_store WHERE key LIKE ? ORDER BY updated_at DESC', (pattern,)).fetchall()
    results = []
    for r in rows:
        try:
            val = json.loads(r['value'])
        except (json.JSONDecodeError, TypeError):
            val = r['value']
        results.append({'key': r['key'], 'value': val, 'updated_at': r['updated_at']})
    return results

def searchMemory(query: str) -> list[dict[str, Any]]:
    """Full-text search across memory keys and values."""
    if not query or not query.strip():
        return []
    conn = _conn()
    try:
        ftsQuery = ' OR '.join((f'"{w}"*' for w in query.strip().split() if w))
        if not ftsQuery:
            return []
        rows = conn.execute('SELECT key, value FROM memory_store_fts WHERE content MATCH ?\n               ORDER BY rank LIMIT 20', (ftsQuery,)).fetchall()
        results = []
        for r in rows:
            try:
                val = json.loads(r['value'])
            except (json.JSONDecodeError, TypeError):
                val = r['value']
            results.append({'key': r['key'], 'value': val})
        return results
    except sqlite3.OperationalError:
        likeQuery = f'%{query.strip()}%'
        rows = conn.execute('SELECT key, value FROM memory_store WHERE key LIKE ? OR value LIKE ? LIMIT 20', (likeQuery, likeQuery)).fetchall()
        results = []
        for r in rows:
            try:
                val = json.loads(r['value'])
            except (json.JSONDecodeError, TypeError):
                val = r['value']
            results.append({'key': r['key'], 'value': val})
        return results

def saveFact(factKey: str, factValue: Any, category: str='general', source: str='', confidence: float=1.0) -> None:
    """Save a structured fact."""
    conn = _conn()
    conn.execute("INSERT OR REPLACE INTO facts (fact_key, fact_value, category, source, confidence, updated_at)\n           VALUES (?, ?, ?, ?, ?, datetime('now'))", (factKey, _json(factValue), category, source, confidence))
    conn.commit()

def getFact(factKey: str) -> dict[str, Any] | None:
    """Get a fact by key."""
    conn = _conn()
    row = conn.execute('SELECT * FROM facts WHERE fact_key = ?', (factKey,)).fetchone()
    if not row:
        return None
    return dict(row)

def searchFacts(query: str, category: str='') -> list[dict[str, Any]]:
    """Search facts by key or value."""
    conn = _conn()
    like = f'%{query}%'
    if category:
        rows = conn.execute('SELECT * FROM facts WHERE (fact_key LIKE ? OR fact_value LIKE ?) AND category = ? ORDER BY updated_at DESC LIMIT 20', (like, like, category)).fetchall()
    else:
        rows = conn.execute('SELECT * FROM facts WHERE fact_key LIKE ? OR fact_value LIKE ? ORDER BY updated_at DESC LIMIT 20', (like, like)).fetchall()
    return [dict(r) for r in rows]

def listFacts(category: str='') -> list[dict[str, Any]]:
    """List facts, optionally filtered by category."""
    conn = _conn()
    if category:
        rows = conn.execute('SELECT * FROM facts WHERE category = ? ORDER BY updated_at DESC', (category,)).fetchall()
    else:
        rows = conn.execute('SELECT * FROM facts ORDER BY updated_at DESC').fetchall()
    return [dict(r) for r in rows]

def deleteFact(factKey: str) -> bool:
    """Delete a fact by key."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM facts WHERE fact_key = ?', (factKey,))
    conn.commit()
    return cursor.rowcount > 0

def saveProposal(sessionId: str, proposalType: str, content: Any) -> int:
    """Save a proposal (plan, mutation, etc.)."""
    conn = _conn()
    cursor = conn.execute('INSERT INTO proposals (session_id, proposal_type, content) VALUES (?, ?, ?)', (sessionId, proposalType, _json(content)))
    conn.commit()
    return cursor.lastrowid

def getProposal(proposalId: int) -> dict[str, Any] | None:
    """Get a proposal by ID."""
    conn = _conn()
    row = conn.execute('SELECT * FROM proposals WHERE id = ?', (proposalId,)).fetchone()
    return dict(row) if row else None

def listProposals(sessionId: str, status: str='') -> list[dict[str, Any]]:
    """List proposals for a session, optionally filtered by status."""
    conn = _conn()
    if status:
        rows = conn.execute('SELECT * FROM proposals WHERE session_id = ? AND status = ? ORDER BY created_at DESC', (sessionId, status)).fetchall()
    else:
        rows = conn.execute('SELECT * FROM proposals WHERE session_id = ? ORDER BY created_at DESC', (sessionId,)).fetchall()
    return [dict(r) for r in rows]

def decideProposal(proposalId: int, status: str, decidedBy: str='') -> bool:
    """Decide (approve/reject) a proposal."""
    conn = _conn()
    cursor = conn.execute("UPDATE proposals SET status = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?", (status, decidedBy, proposalId))
    conn.commit()
    return cursor.rowcount > 0

def recordLifecycle(sessionId: str, eventType: str, detail: Any=None) -> int:
    """Record a lifecycle event."""
    conn = _conn()
    cursor = conn.execute('INSERT INTO lifecycle (session_id, event_type, detail) VALUES (?, ?, ?)', (sessionId, eventType, _json(detail) if detail else None))
    conn.commit()
    return cursor.lastrowid

def listLifecycle(sessionId: str, eventType: str='', limit: int=100) -> list[dict[str, Any]]:
    """List lifecycle events for a session."""
    conn = _conn()
    if eventType:
        rows = conn.execute('SELECT * FROM lifecycle WHERE session_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT ?', (sessionId, eventType, limit)).fetchall()
    else:
        rows = conn.execute('SELECT * FROM lifecycle WHERE session_id = ? ORDER BY created_at DESC LIMIT ?', (sessionId, limit)).fetchall()
    return [dict(r) for r in rows]

def recordConfigAudit(category: str, action: str, actor: str='', before: Any=None, after: Any=None) -> int:
    """Record a structured config-change audit entry.

    Used by alias, fallback, and agent mutation paths so that every
    self-configuration change is traceable.
    """
    conn = _conn()
    cursor = conn.execute('INSERT INTO config_audit (category, action, actor, before_json, after_json) VALUES (?, ?, ?, ?, ?)', (category, action, actor, _json(before) if before is not None else None, _json(after) if after is not None else None))
    conn.commit()
    return cursor.lastrowid

def listConfigAudit(category: str='', limit: int=200) -> list[dict[str, Any]]:
    """List config-change audit entries, newest first."""
    conn = _conn()
    if category:
        rows = conn.execute('SELECT * FROM config_audit WHERE category = ? ORDER BY created_at DESC LIMIT ?', (category, limit)).fetchall()
    else:
        rows = conn.execute('SELECT * FROM config_audit ORDER BY created_at DESC LIMIT ?', (limit,)).fetchall()
    results = []
    for r in rows:
        entry = {'id': r['id'], 'category': r['category'], 'action': r['action'], 'actor': r['actor'] or '', 'createdAt': r['created_at']}
        for rawKey, outKey in (('before_json', 'before'), ('after_json', 'after')):
            raw = r[rawKey]
            if isinstance(raw, str):
                try:
                    entry[outKey] = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    entry[outKey] = raw
            else:
                entry[outKey] = raw
        results.append(entry)
    return results

def indexSessionTopic(sessionId: str, topic: str, parentTopic: str | None=None, confidence: float=0.75) -> bool:
    """Record or update the topic for a session."""
    conn = _conn()
    try:
        conn.execute("INSERT INTO session_topics (session_id, topic, parent_topic, confidence, classified_at)\n               VALUES (?, ?, ?, ?, datetime('now'))\n               ON CONFLICT(session_id) DO UPDATE SET\n                   topic=excluded.topic,\n                   parent_topic=excluded.parent_topic,\n                   confidence=excluded.confidence,\n                   classified_at=excluded.classified_at", (sessionId, topic, parentTopic, confidence))
        conn.commit()
        return True
    except Exception:
        return False

def getSessionTopic(sessionId: str) -> dict[str, Any] | None:
    """Get the classified topic for a session."""
    conn = _conn()
    row = conn.execute('SELECT * FROM session_topics WHERE session_id = ?', (sessionId,)).fetchone()
    return dict(row) if row else None

def listTopics(limit: int=50) -> list[dict[str, Any]]:
    """List all classified session topics, most recent first."""
    conn = _conn()
    rows = conn.execute('SELECT * FROM session_topics ORDER BY classified_at DESC LIMIT ?', (limit,)).fetchall()
    return [dict(r) for r in rows]

def searchSessionsByTopic(topic: str) -> list[dict[str, Any]]:
    """Find sessions with a given topic classification."""
    conn = _conn()
    rows = conn.execute('SELECT * FROM session_topics WHERE topic = ? ORDER BY classified_at DESC', (topic,)).fetchall()
    return [dict(r) for r in rows]

def saveSession(session: dict[str, Any]) -> None:
    """Persist a session record."""
    conn = _conn()
    conn.execute('INSERT OR REPLACE INTO sessions (id, title, started_at, message_count, provider, model, folder_id, is_archived, workspace_path)\n           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', (session['id'], session.get('title', ''), session.get('startedAt'), session.get('messageCount', 0), session.get('provider', ''), session.get('model', ''), session.get('folderId'), 1 if session.get('isArchived') else 0, session.get('workspacePath')))
    conn.commit()

def listSessions() -> list[dict[str, Any]]:
    """List all sessions, most recent first."""
    conn = _conn()
    rows = conn.execute('SELECT * FROM sessions ORDER BY started_at DESC').fetchall()
    return [dict(r) for r in rows]

def getSession(sessionId: str) -> dict[str, Any] | None:
    """Get a single session by ID."""
    conn = _conn()
    row = conn.execute('SELECT * FROM sessions WHERE id = ?', (sessionId,)).fetchone()
    return dict(row) if row else None

def deleteSessionRecord(sessionId: str) -> bool:
    """Delete a session record."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM sessions WHERE id = ?', (sessionId,))
    conn.commit()
    return cursor.rowcount > 0

def saveMessage(sessionId: str, role: str, content: Any) -> int:
    """Save a message to a session."""
    conn = _conn()
    cursor = conn.execute('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)', (sessionId, role, _json(content)))
    conn.commit()
    return cursor.lastrowid

def getMessages(sessionId: str) -> list[dict[str, Any]]:
    """Get all messages for a session."""
    conn = _conn()
    rows = conn.execute('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at', (sessionId,)).fetchall()
    results = []
    for r in rows:
        msg = dict(r)
        try:
            msg['content'] = json.loads(msg['content']) if isinstance(msg['content'], str) else msg['content']
        except (json.JSONDecodeError, TypeError):
            pass
        results.append(msg)
    return results

def deleteSessionMessages(sessionId: str) -> int:
    """Delete all messages for a session."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM messages WHERE session_id = ?', (sessionId,))
    conn.commit()
    return cursor.rowcount

def recordUsage(sessionId: str, model: str, inputTokens: int=0, outputTokens: int=0, contextTokens: int=0) -> int:
    """Record a usage event.

    ``context_tokens`` captures the provider-reported ``input_tokens`` of the
    FINAL sub-call in the agentic turn — i.e. the true current context fill
    (system prompt + tools + messages, counted once). The cumulative
    ``input_tokens``/``output_tokens`` are still recorded for Usage-page totals.
    """
    conn = _conn()
    cursor = conn.execute('INSERT INTO usage_events (session_id, model, input_tokens, output_tokens, context_tokens) VALUES (?, ?, ?, ?, ?)', (sessionId, model, inputTokens, outputTokens, contextTokens))
    conn.commit()
    return cursor.lastrowid

def getUsage(sessionId: str) -> dict[str, Any]:
    """Get aggregated usage for a session.

    Returns cumulative totals (for the Usage page) plus ``latest_context_tokens``
    — the ``context_tokens`` of the most recent usage event, which equals the
    provider-reported input_tokens of the final sub-call of the latest turn
    (the true current context fill). Also returns the per-event list ordered
    newest-first so the caller can derive the same value independently.
    """
    conn = _conn()
    row = conn.execute('SELECT SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, COUNT(*) as request_count FROM usage_events WHERE session_id = ?', (sessionId,)).fetchone()
    totals = dict(row) if row else {'total_input': 0, 'total_output': 0, 'request_count': 0}
    latest = conn.execute('SELECT context_tokens, input_tokens FROM usage_events WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', (sessionId,)).fetchone()
    if latest:
        latestCtx = latest['context_tokens'] or latest['input_tokens']
    else:
        latestCtx = 0
    events = [{'id': e['id'], 'model': e['model'], 'inputTokens': e['input_tokens'], 'outputTokens': e['output_tokens'], 'contextTokens': e['context_tokens'] or e['input_tokens'], 'totalTokens': (e['input_tokens'] or 0) + (e['output_tokens'] or 0), 'createdAt': e['created_at']} for e in conn.execute('SELECT id, model, input_tokens, output_tokens, context_tokens, created_at FROM usage_events WHERE session_id = ? ORDER BY created_at DESC, id DESC', (sessionId,)).fetchall()]
    return {'sessionId': sessionId, 'totalEvents': totals.get('request_count', 0) or 0, 'totalInputTokens': totals.get('total_input', 0) or 0, 'totalOutputTokens': totals.get('total_output', 0) or 0, 'totalTokens': (totals.get('total_input', 0) or 0) + (totals.get('total_output', 0) or 0), 'totalCost': 0.0, 'model': events[0]['model'] if events else None, 'provider': None, 'contextTokens': latestCtx, 'latestContextTokens': latestCtx, 'events': events}

def vacuum() -> None:
    """Vacuum the database to reclaim space."""
    conn = _conn()
    conn.execute('VACUUM')
    conn.commit()

def getStats() -> dict[str, Any]:
    """Get database statistics."""
    conn = _conn()
    stats = {}
    for table in ['memory_store', 'facts', 'proposals', 'sessions', 'messages', 'usage_events', 'session_topics']:
        try:
            row = conn.execute(f'SELECT COUNT(*) as count FROM {table}').fetchone()
            stats[table] = row['count'] if row else 0
        except Exception:
            stats[table] = 0
    stats['db_size_bytes'] = _dbPath().stat().st_size if _dbPath().exists() else 0
    return stats
_BRAINStores: dict[str, dict[str, Any]] = {'memory': {'table': 'memory_store', 'fts': 'memory_store_fts', 'columns': 'key, value, updated_at', 'search_cols': ['key', 'value'], 'label': 'key-value memory store'}, 'auto_memories': {'table': 'auto_memories', 'fts': 'auto_memories_fts', 'columns': 'id, key, content, category, importance, created_at', 'search_cols': ['key', 'content'], 'label': 'auto-captured memories'}, 'heuristics': {'table': 'learned_heuristics', 'fts': None, 'columns': 'id, rule, source, category, created_at, updated_at', 'search_cols': ['rule', 'source'], 'label': 'learned behavioral rules'}, 'facts': {'table': 'facts', 'fts': None, 'columns': 'id, fact_key, fact_value, category, source, confidence, created_at, updated_at', 'search_cols': ['fact_key', 'fact_value'], 'label': 'structured semantic facts'}, 'sessions': {'table': 'sessions', 'fts': None, 'columns': 'id, title, started_at, message_count, provider, model, workspace_path', 'search_cols': ['title', 'id'], 'label': 'conversation sessions'}, 'messages': {'table': 'messages', 'fts': None, 'columns': 'id, session_id, role, content, created_at', 'search_cols': ['content'], 'label': 'chat messages'}, 'timeline': {'table': 'episodic_timeline', 'fts': None, 'columns': 'id, timestamp, session_id, event_summary, category', 'search_cols': ['event_summary', 'category', 'session_id'], 'label': 'episodic timeline entries'}, 'blackboard': {'table': 'blackboard', 'fts': None, 'columns': 'id, session_id, agent, key, value, priority, created_at, expires_at', 'search_cols': ['agent', 'key', 'value'], 'label': 'inter-agent blackboard notes'}, 'exams': {'table': 'exams', 'fts': None, 'columns': 'id, title, topic, created_at, source, source_files', 'search_cols': ['title', 'topic'], 'label': 'exam sessions'}, 'exam_attempts': {'table': 'exam_attempts', 'fts': None, 'columns': 'id, exam_id, question_id, selected_index, is_correct, asked_for_help, answered_at', 'search_cols': ['exam_id'], 'label': 'exam attempt history'}}

def _brainQueryGraph(query: str, filters: dict | None, limit: int) -> str:
    """v1.1: Read graph entities/relations from august_graph_memory.json.

    Returns list of {entity, type, attributes} or {source, relation, target} rows.
    If the JSON file is missing or empty, returns an empty list (NOT an error).
    """
    try:
        import json as _json
        import os as _os
        candidates = [_os.path.join('data', 'august_graph_memory.json'), 'august_graph_memory.json', _os.path.expanduser('~/.august/august_graph_memory.json')]
        graphPath = next((p for p in candidates if _os.path.exists(p)), None)
        if graphPath is None:
            return _json.dumps([])
        with open(graphPath, 'r', encoding='utf-8') as f:
            data = _json.load(f)
    except (ImportError, _json.JSONDecodeError, OSError):
        return _json.dumps([])
    rows: list[dict] = []
    entities = data.get('entities', []) if isinstance(data, dict) else []
    for ent in entities:
        if not isinstance(ent, dict):
            continue
        name = ent.get('name', '')
        if query and query.lower() not in name.lower():
            continue
        rows.append({'entity': name, 'type': ent.get('type', ''), 'attributes': ent.get('attributes', {})})
        if len(rows) >= limit:
            return _json.dumps(rows[:limit], ensure_ascii=False)
    if len(rows) < limit:
        relations = data.get('relations', []) if isinstance(data, dict) else []
        for rel in relations:
            if not isinstance(rel, dict):
                continue
            source = rel.get('source', '')
            target = rel.get('target', '')
            if query and query.lower() not in (source + target).lower():
                continue
            rows.append({'source': source, 'relation': rel.get('relation', ''), 'target': target})
            if len(rows) >= limit:
                break
    return _json.dumps(rows[:limit], ensure_ascii=False)

def _brainQueryDaemons(query: str, filters: dict | None, limit: int) -> str:
    """v1.1: Read live daemon registry (Phase 8).

    Returns list of {session_id, name, status, watch_condition, last_check, error} rows.
    If no daemons are running, returns an empty list.
    Gracefully degrades if daemon_manager is unavailable (returns []).
    """
    import json as _json
    try:
        from app.services import daemonManager
    except ImportError:
        return _json.dumps([])
    try:
        internal = getattr(daemonManager, '_daemons', None)
        if not isinstance(internal, dict):
            return _json.dumps([])
        rows: list[dict] = []
        for sessionId, daemons in internal.items():
            for d in daemons or []:
                if hasattr(d, '__dict__'):
                    info = dict(d.__dict__)
                elif isinstance(d, dict):
                    info = d
                else:
                    continue
                row = {'session_id': sessionId, 'name': info.get('name', ''), 'status': info.get('status', 'unknown'), 'watch_condition': info.get('watch_condition'), 'last_check': info.get('last_check'), 'error': info.get('error')}
                if filters and filters.get('session_id') and (filters['session_id'] != sessionId):
                    continue
                if query and query.lower() not in row['name'].lower():
                    continue
                rows.append(row)
                if len(rows) >= limit:
                    break
            if len(rows) >= limit:
                break
        return _json.dumps(rows[:limit], ensure_ascii=False)
    except Exception:
        return _json.dumps([])

def brainQuery(store: str, query: str='', filters: dict | None=None, limit: int=10) -> str:
    """Read-only query across any brain store (§11 of the cognitive spec).

    Returns compact JSON rows. Capped at ``limit`` and at a hard token
    ceiling (truncated with "N more rows; narrow your query" if exceeded).

    Unknown or not-yet-shipped stores return a structured error string
    rather than raising — keeps the tool stable across phases.
    """
    _TOKENCeiling = 2000
    conn = _conn()
    if store == 'graph':
        return _brainQueryGraph(query, filters, limit)
    if store == 'daemons':
        return _brainQueryDaemons(query, filters, limit)
    if store not in _BRAINStores:
        return json.dumps({'error': f"store '{store}' not available in this build", 'available': sorted(_BRAINStores.keys())})
    info = _BRAINStores[store]
    try:
        tableCheck = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (info['table'],)).fetchone()
        if not tableCheck:
            return json.dumps({'error': f"store '{store}' table not yet created"})
        cols = info['columns']
        sql = f"SELECT {cols} FROM {info['table']}"
        params: list[Any] = []
        whereClauses: list[str] = []
        if query:
            fts = info.get('fts')
            if fts:
                ftsQ = ' OR '.join((f'"{w}"*' for w in query.strip().split() if w))
                if ftsQ:
                    qualifiedCols = ', '.join((f't.{c.strip()}' for c in cols.split(',')))
                    sql = f"SELECT {qualifiedCols} FROM {fts} fts JOIN {info['table']} t ON fts.rowid = t.rowid WHERE fts.content MATCH ? ORDER BY rank"
                    params = [ftsQ]
                else:
                    whereClauses.append('1=0')
            else:
                searchParts = []
                for col in info['search_cols']:
                    searchParts.append(f'{col} LIKE ?')
                    params.append(f'%{query}%')
                whereClauses.append(f"({' OR '.join(searchParts)})")
        if filters:
            for key, val in filters.items():
                colInfo = conn.execute(f"PRAGMA table_info({info['table']})").fetchall()
                colNames = {c['name'] for c in colInfo}
                if key in colNames:
                    whereClauses.append(f'{key} = ?')
                    params.append(val)
        if whereClauses:
            if 'WHERE' not in sql and 'MATCH' not in sql:
                sql += ' WHERE ' + ' AND '.join(whereClauses)
            elif 'MATCH' in sql and 'WHERE' in sql:
                pass
            elif 'MATCH' not in sql:
                sql += ' WHERE ' + ' AND '.join(whereClauses)
        sql += f' LIMIT {min(limit, 100)}'
        rows = conn.execute(sql, params).fetchall()
        results = [dict(r) for r in rows]
        resultJson = json.dumps(results, default=str, ensure_ascii=False)
        if len(resultJson) > _TOKENCeiling * 4:
            truncated = []
            charBudget = _TOKENCeiling * 4
            for r in results:
                rowS = json.dumps(r, default=str, ensure_ascii=False)
                if len(json.dumps(truncated, default=str, ensure_ascii=False)) + len(rowS) < charBudget:
                    truncated.append(r)
                else:
                    break
            nMore = len(results) - len(truncated)
            resultJson = json.dumps({'rows': truncated, 'note': f'{nMore} more rows; narrow your query'}, default=str, ensure_ascii=False)
        return resultJson
    except Exception as exc:
        return json.dumps({'error': f'brain_query({store}): {exc}'})

def writeTimelineEvent(sessionId: str, eventSummary: str, category: str='general') -> int:
    """v2: Append an entry to episodic_timeline. Returns the new row's id."""
    conn = _conn()
    cur = conn.execute("INSERT INTO episodic_timeline (timestamp, session_id, event_summary, category) VALUES (datetime('now'), ?, ?, ?)", (sessionId, eventSummary, category))
    conn.commit()
    return cur.lastrowid

def timelineSweep() -> int:
    """v2: Hourly sweep. For sessions with no timeline entry, generate one.

    Returns the number of new entries created.
    """
    conn = _conn()
    rows = conn.execute('\n        SELECT s.id FROM sessions s\n        LEFT JOIN episodic_timeline t ON t.session_id = s.id\n        WHERE t.id IS NULL\n        LIMIT 20\n    ').fetchall()
    if not rows:
        return 0
    count = 0
    for r in rows:
        sid = r['id']
        msgs = conn.execute('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10', (sid,)).fetchall()
        if not msgs:
            continue
        try:
            from app.services.workbench import modelFleet
            from app.providers.clients import getClient
            model = modelFleet.get_model_for_role('hippocampus')
            client = getClient({'model': model})
            if client and hasattr(client, 'generate'):
                transcript = '\n'.join((f"{m['role']}: {m['content'][:200]}" for m in msgs))
                prompt = f'Summarize this session in one line (under 100 words):\n\n{transcript}'
                summary = client.generate(prompt)
            else:
                summary = None
        except Exception:
            summary = None
        if not summary:
            last = msgs[0]
            content = last['content']
            if isinstance(content, str):
                summary = content[:200]
            else:
                summary = '(session ended)'
        writeTimelineEvent(sid, summary.strip()[:500], 'sweep')
        count += 1
    return count