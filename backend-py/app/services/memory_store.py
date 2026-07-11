"""
SQLite memory store — persists conversations, facts, proposals, lifecycle,
and index data. The core persistence layer for the August "brain".

Port of backend/services/memory/sqlite-memory-store.js (1,431 lines).
Uses aiosqlite for async access and a sync sqlite3 fallback.
"""
from __future__ import annotations
import asyncio
import json
import os
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path
from app.lib.paths import dataPath
from app.typeAliases import JsonValue, MemoryEntryDict, FactDict, ProposalDict, SessionRecord, UsageEventDict, MessageDict
from app.jsonUtils import as_str, as_dict, as_list, as_int, as_float
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

def _q(value: object) -> str:
    """Quote a value for SQL (sync helper)."""
    if value is None:
        return 'NULL'
    return f"'{str(value).replace(chr(39), chr(39) + chr(39))}'"

def _json(value: object) -> str:
    """Serialize a value to JSON for storage."""
    return json.dumps(value)

def init() -> None:
    """Create all tables on first use."""
    conn = _conn()
    conn.executescript("\n        CREATE TABLE IF NOT EXISTS memoryStore (\n            key TEXT PRIMARY KEY,\n            value TEXT,\n            updatedAt TEXT DEFAULT (datetime('now'))\n        );\n\n        -- FTS5 on memoryStore (content-sync table — triggers added below)\n        CREATE VIRTUAL TABLE IF NOT EXISTS memoryStore_fts USING fts5(\n            key, value, content='memoryStore', content_rowid='rowid'\n        );\n\n        CREATE TABLE IF NOT EXISTS facts (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            factKey TEXT UNIQUE NOT NULL,\n            factValue TEXT NOT NULL,\n            category TEXT DEFAULT 'general',\n            source TEXT DEFAULT '',\n            confidence REAL DEFAULT 1.0,\n            createdAt TEXT DEFAULT (datetime('now')),\n            updatedAt TEXT DEFAULT (datetime('now'))\n        );\n\n        CREATE TABLE IF NOT EXISTS proposals (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            sessionId TEXT NOT NULL,\n            proposalType TEXT NOT NULL,\n            content TEXT,\n            status TEXT DEFAULT 'pending',\n            createdAt TEXT DEFAULT (datetime('now')),\n            decidedAt TEXT,\n            decidedBy TEXT\n        );\n\n        CREATE TABLE IF NOT EXISTS lifecycle (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            sessionId TEXT,\n            eventType TEXT NOT NULL,\n            detail TEXT,\n            createdAt TEXT DEFAULT (datetime('now'))\n        );\n\n        CREATE TABLE IF NOT EXISTS sessionTopics (\n            sessionId TEXT PRIMARY KEY,\n            topic TEXT NOT NULL,\n            parentTopic TEXT,\n            confidence REAL DEFAULT 0.75,\n            classifiedAt TEXT DEFAULT (datetime('now'))\n        );\n\n        CREATE TABLE IF NOT EXISTS sessions (\n            id TEXT PRIMARY KEY,\n            title TEXT,\n            startedAt TEXT,\n            messageCount INTEGER DEFAULT 0,\n            provider TEXT DEFAULT '',\n            model TEXT DEFAULT '',\n            folderId TEXT,\n            isArchived INTEGER DEFAULT 0,\n            workspacePath TEXT\n        );\n\n        CREATE TABLE IF NOT EXISTS messages (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            sessionId TEXT NOT NULL,\n            role TEXT NOT NULL,\n            content TEXT,\n            createdAt TEXT DEFAULT (datetime('now')),\n            FOREIGN KEY (sessionId) REFERENCES sessions(id)\n        );\n\n        CREATE TABLE IF NOT EXISTS usageEvents (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            sessionId TEXT,\n            model TEXT,\n            inputTokens INTEGER DEFAULT 0,\n            outputTokens INTEGER DEFAULT 0,\n            contextTokens INTEGER DEFAULT 0,\n            createdAt TEXT DEFAULT (datetime('now'))\n        );\n\n        CREATE TABLE IF NOT EXISTS configAudit (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            category TEXT NOT NULL,\n            action TEXT NOT NULL,\n            actor TEXT DEFAULT '',\n            beforeJson TEXT,\n            afterJson TEXT,\n            createdAt TEXT DEFAULT (datetime('now'))\n        );\n\n        CREATE TABLE IF NOT EXISTS learnedHeuristics (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            rule TEXT NOT NULL,\n            source TEXT DEFAULT '',\n            category TEXT DEFAULT 'general',\n            createdAt TEXT DEFAULT (datetime('now')),\n            updatedAt TEXT DEFAULT (datetime('now'))\n        );\n\n        CREATE TABLE IF NOT EXISTS autoMemories (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            key TEXT,\n            content TEXT,\n            category TEXT DEFAULT 'auto',\n            importance REAL DEFAULT 0.5,\n            source TEXT DEFAULT '',\n            createdAt TEXT DEFAULT (datetime('now')),\n            updatedAt TEXT DEFAULT (datetime('now'))\n        );\n\n        CREATE VIRTUAL TABLE IF NOT EXISTS autoMemories_fts USING fts5(\n            key, content, content='autoMemories', content_rowid='rowid'\n        );\n\n        -- FTS5 triggers — CRITICAL — without these FTS indexes stay empty\n        -- memoryStore_fts triggers\n        CREATE TRIGGER IF NOT EXISTS memoryStore_fts_ai AFTER INSERT ON memoryStore BEGIN\n            INSERT INTO memoryStore_fts(rowid, key, value)\n            VALUES (new.rowid, new.key, new.value);\n        END;\n        CREATE TRIGGER IF NOT EXISTS memoryStore_fts_ad AFTER DELETE ON memoryStore BEGIN\n            INSERT INTO memoryStore_fts(memoryStore_fts, rowid, key, value)\n            VALUES('delete', old.rowid, old.key, old.value);\n        END;\n        CREATE TRIGGER IF NOT EXISTS memoryStore_fts_au AFTER UPDATE ON memoryStore BEGIN\n            INSERT INTO memoryStore_fts(memoryStore_fts, rowid, key, value)\n            VALUES('delete', old.rowid, old.key, old.value);\n            INSERT INTO memoryStore_fts(rowid, key, value)\n            VALUES (new.rowid, new.key, new.value);\n        END;\n\n        -- autoMemories_fts triggers\n        CREATE TRIGGER IF NOT EXISTS autoMemories_ai AFTER INSERT ON autoMemories BEGIN\n            INSERT INTO autoMemories_fts(rowid, key, content)\n            VALUES (new.id, new.key, new.content);\n        END;\n        CREATE TRIGGER IF NOT EXISTS autoMemories_ad AFTER DELETE ON autoMemories BEGIN\n            INSERT INTO autoMemories_fts(autoMemories_fts, rowid, key, content)\n            VALUES('delete', old.id, old.key, old.content);\n        END;\n        CREATE TRIGGER IF NOT EXISTS autoMemories_au AFTER UPDATE ON autoMemories BEGIN\n            INSERT INTO autoMemories_fts(autoMemories_fts, rowid, key, content)\n            VALUES('delete', old.id, old.key, old.content);\n            INSERT INTO autoMemories_fts(rowid, key, content)\n            VALUES (new.id, new.key, new.content);\n        END;\n\n        CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);\n        CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updatedAt);\n        CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(sessionId);\n        CREATE INDEX IF NOT EXISTS idx_lifecycle_session ON lifecycle(sessionId);\n        CREATE INDEX IF NOT EXISTS idx_lifecycle_event ON lifecycle(eventType);\n        CREATE INDEX IF NOT EXISTS idx_configAudit_category ON configAudit(category);\n        CREATE INDEX IF NOT EXISTS idx_configAudit_created ON configAudit(createdAt);\n    ")
    conn.commit()
    rowCount = conn.execute('SELECT count(*) FROM memoryStore_fts').fetchone()[0]
    if rowCount == 0:
        conn.execute('\n            INSERT INTO memoryStore_fts(rowid, key, value)\n            SELECT rowid, key, value FROM memoryStore\n        ')
    conn.commit()
    try:
        cols = [r['name'] for r in conn.execute('PRAGMA table_info(autoMemories)').fetchall()]
        if 'updatedAt' not in cols:
            conn.execute('ALTER TABLE autoMemories ADD COLUMN updatedAt TEXT')
    except Exception as exc:
        import logging
        logging.warning('autoMemories updatedAt migration failed: %s', exc)
    conn.execute("\n        CREATE TABLE IF NOT EXISTS episodicTimeline (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            timestamp TEXT,\n            sessionId TEXT,\n            eventSummary TEXT,\n            category TEXT DEFAULT 'general'\n        )\n    ")
    conn.execute("\n        CREATE TABLE IF NOT EXISTS blackboard (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            sessionId TEXT NOT NULL,\n            agent TEXT NOT NULL DEFAULT 'main',\n            key TEXT NOT NULL,\n            value TEXT NOT NULL,\n            priority INTEGER DEFAULT 0,\n            createdAt TEXT DEFAULT (datetime('now')),\n            expiresAt TEXT\n        )\n    ")
    conn.execute("\n        CREATE TABLE IF NOT EXISTS exams (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            title TEXT NOT NULL,\n            topic TEXT DEFAULT '',\n            createdAt TEXT DEFAULT (datetime('now')),\n            source TEXT DEFAULT 'model',\n            sourceFiles TEXT DEFAULT ''\n        )\n    ")
    conn.execute("\n        CREATE TABLE IF NOT EXISTS examQuestions (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            examId INTEGER NOT NULL,\n            position INTEGER NOT NULL,\n            stem TEXT NOT NULL,\n            options TEXT NOT NULL,\n            correctIndex INTEGER NOT NULL,\n            rationale TEXT DEFAULT '',\n            sourceSnippet TEXT DEFAULT '',\n            origin TEXT DEFAULT 'generated',\n            FOREIGN KEY (examId) REFERENCES exams(id)\n        )\n    ")
    conn.execute("\n        CREATE TABLE IF NOT EXISTS examAttempts (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            examId INTEGER NOT NULL,\n            questionId INTEGER NOT NULL,\n            selectedIndex INTEGER,\n            isCorrect INTEGER DEFAULT 0,\n            askedForHelp INTEGER DEFAULT 0,\n            answeredAt TEXT DEFAULT (datetime('now'))\n        )\n    ")
    conn.execute("\n        CREATE TABLE IF NOT EXISTS pendingSkills (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            name TEXT UNIQUE NOT NULL,\n            description TEXT,\n            triggerText TEXT,\n            draftPath TEXT NOT NULL,\n            sourceSessionId TEXT,\n            sourceWorkflow TEXT,\n            createdBy TEXT DEFAULT 'auto-gen',\n            createdAt TEXT DEFAULT (datetime('now')),\n            status TEXT DEFAULT 'pending',\n            useCount INTEGER DEFAULT 0,\n            lastSurfacedAt TEXT\n        )\n    ")
    conn.commit()
    _ensureColumn(conn, 'usageEvents', 'contextTokens', 'INTEGER DEFAULT 0')

def _ensureColumn(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    """Add a column to a table if it does not already exist (idempotent)."""
    cols = {row['name'] for row in conn.execute(f'PRAGMA table_info({table})').fetchall()}
    if column not in cols:
        conn.execute(f'ALTER TABLE {table} ADD COLUMN {column} {decl}')
        conn.commit()

def saveMemory(key: str, value: JsonValue) -> None:
    """Save a key-value pair to memory."""
    conn = _conn()
    conn.execute("INSERT OR REPLACE INTO memoryStore (key, value, updatedAt) VALUES (?, ?, datetime('now'))", (key, _json(value)))
    conn.commit()

def getMemory(key: str) -> JsonValue | None:
    """Get a value from memory by key."""
    conn = _conn()
    row = conn.execute('SELECT value FROM memoryStore WHERE key = ?', (key,)).fetchone()
    if row:
        try:
            return json.loads(row['value'])
        except (json.JSONDecodeError, TypeError):
            return row['value']
    return None

def deleteMemory(key: str) -> bool:
    """Delete a memory key. Returns True if it existed."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM memoryStore WHERE key = ?', (key,))
    conn.commit()
    return cursor.rowcount > 0

def listMemory(pattern: str='%') -> list[MemoryEntryDict]:
    """List memory entries with optional key pattern matching."""
    conn = _conn()
    rows = conn.execute('SELECT key, value, updatedAt FROM memoryStore WHERE key LIKE ? ORDER BY updatedAt DESC', (pattern,)).fetchall()
    results: list[MemoryEntryDict] = []
    for r in rows:
        try:
            val = json.loads(r['value'])
        except (json.JSONDecodeError, TypeError):
            val = r['value']
        results.append({'key': r['key'], 'value': val, 'updatedAt': r['updatedAt']})
    return results

def searchMemory(query: str) -> list[MemoryEntryDict]:
    """Full-text search across memory keys and values."""
    if not query or not query.strip():
        return []
    conn = _conn()
    try:
        ftsQuery = ' OR '.join((f'"{w}"*' for w in query.strip().split() if w))
        if not ftsQuery:
            return []
        rows = conn.execute('SELECT key, value FROM memoryStore_fts WHERE content MATCH ?\n               ORDER BY rank LIMIT 20', (ftsQuery,)).fetchall()
        results: list[MemoryEntryDict] = []
        for r in rows:
            try:
                val = json.loads(r['value'])
            except (json.JSONDecodeError, TypeError):
                val = r['value']
            results.append({'key': r['key'], 'value': val})
        return results
    except sqlite3.OperationalError:
        likeQuery = f'%{query.strip()}%'
        rows = conn.execute('SELECT key, value FROM memoryStore WHERE key LIKE ? OR value LIKE ? LIMIT 20', (likeQuery, likeQuery)).fetchall()
        results: list[MemoryEntryDict] = []
        for r in rows:
            try:
                val = json.loads(r['value'])
            except (json.JSONDecodeError, TypeError):
                val = r['value']
            results.append({'key': r['key'], 'value': val})
        return results

def saveFact(factKey: str, factValue: JsonValue, category: str='general', source: str='', confidence: float=1.0) -> None:
    """Save a structured fact."""
    conn = _conn()
    conn.execute("INSERT OR REPLACE INTO facts (factKey, factValue, category, source, confidence, updatedAt)\n           VALUES (?, ?, ?, ?, ?, datetime('now'))", (factKey, _json(factValue), category, source, confidence))
    conn.commit()

def getFact(factKey: str) -> FactDict | None:
    """Get a fact by key."""
    conn = _conn()
    row = conn.execute('SELECT * FROM facts WHERE factKey = ?', (factKey,)).fetchone()
    if not row:
        return None
    return dict(row)

def searchFacts(query: str, category: str='') -> list[FactDict]:
    """Search facts by key or value."""
    conn = _conn()
    like = f'%{query}%'
    if category:
        rows = conn.execute('SELECT * FROM facts WHERE (factKey LIKE ? OR factValue LIKE ?) AND category = ? ORDER BY updatedAt DESC LIMIT 20', (like, like, category)).fetchall()
    else:
        rows = conn.execute('SELECT * FROM facts WHERE factKey LIKE ? OR factValue LIKE ? ORDER BY updatedAt DESC LIMIT 20', (like, like)).fetchall()
    return [dict(r) for r in rows]

def listFacts(category: str='') -> list[FactDict]:
    """List facts, optionally filtered by category."""
    conn = _conn()
    if category:
        rows = conn.execute('SELECT * FROM facts WHERE category = ? ORDER BY updatedAt DESC', (category,)).fetchall()
    else:
        rows = conn.execute('SELECT * FROM facts ORDER BY updatedAt DESC').fetchall()
    return [dict(r) for r in rows]

def deleteFact(factKey: str) -> bool:
    """Delete a fact by key."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM facts WHERE factKey = ?', (factKey,))
    conn.commit()
    return cursor.rowcount > 0

def saveProposal(sessionId: str, proposalType: str, content: JsonValue) -> int:
    """Save a proposal (plan, mutation, etc.)."""
    conn = _conn()
    cursor = conn.execute('INSERT INTO proposals (sessionId, proposalType, content) VALUES (?, ?, ?)', (sessionId, proposalType, _json(content)))
    conn.commit()
    return cursor.lastrowid

def getProposal(proposalId: int) -> ProposalDict | None:
    """Get a proposal by ID."""
    conn = _conn()
    row = conn.execute('SELECT * FROM proposals WHERE id = ?', (proposalId,)).fetchone()
    return dict(row) if row else None

def listProposals(sessionId: str, status: str='') -> list[ProposalDict]:
    """List proposals for a session, optionally filtered by status."""
    conn = _conn()
    if status:
        rows = conn.execute('SELECT * FROM proposals WHERE sessionId = ? AND status = ? ORDER BY createdAt DESC', (sessionId, status)).fetchall()
    else:
        rows = conn.execute('SELECT * FROM proposals WHERE sessionId = ? ORDER BY createdAt DESC', (sessionId,)).fetchall()
    return [dict(r) for r in rows]

def decideProposal(proposalId: int, status: str, decidedBy: str='') -> bool:
    """Decide (approve/reject) a proposal."""
    conn = _conn()
    cursor = conn.execute("UPDATE proposals SET status = ?, decidedAt = datetime('now'), decidedBy = ? WHERE id = ?", (status, decidedBy, proposalId))
    conn.commit()
    return cursor.rowcount > 0

def recordLifecycle(sessionId: str, eventType: str, detail: JsonValue=None) -> int:
    """Record a lifecycle event."""
    conn = _conn()
    cursor = conn.execute('INSERT INTO lifecycle (sessionId, eventType, detail) VALUES (?, ?, ?)', (sessionId, eventType, _json(detail) if detail else None))
    conn.commit()
    return cursor.lastrowid

def listLifecycle(sessionId: str, eventType: str='', limit: int=100) -> list[dict[str, object]]:
    """List lifecycle events for a session."""
    conn = _conn()
    if eventType:
        rows = conn.execute('SELECT * FROM lifecycle WHERE sessionId = ? AND eventType = ? ORDER BY createdAt DESC LIMIT ?', (sessionId, eventType, limit)).fetchall()
    else:
        rows = conn.execute('SELECT * FROM lifecycle WHERE sessionId = ? ORDER BY createdAt DESC LIMIT ?', (sessionId, limit)).fetchall()
    return [dict(r) for r in rows]

def recordConfigAudit(category: str, action: str, actor: str='', before: JsonValue=None, after: JsonValue=None) -> int:
    """Record a structured config-change audit entry.

    Used by alias, fallback, and agent mutation paths so that every
    self-configuration change is traceable.
    """
    conn = _conn()
    cursor = conn.execute('INSERT INTO configAudit (category, action, actor, beforeJson, afterJson) VALUES (?, ?, ?, ?, ?)', (category, action, actor, _json(before) if before is not None else None, _json(after) if after is not None else None))
    conn.commit()
    return cursor.lastrowid

def listConfigAudit(category: str='', limit: int=200) -> list[dict[str, object]]:
    """List config-change audit entries, newest first."""
    conn = _conn()
    if category:
        rows = conn.execute('SELECT * FROM configAudit WHERE category = ? ORDER BY createdAt DESC LIMIT ?', (category, limit)).fetchall()
    else:
        rows = conn.execute('SELECT * FROM configAudit ORDER BY createdAt DESC LIMIT ?', (limit,)).fetchall()
    results = []
    for r in rows:
        entry = {'id': r['id'], 'category': r['category'], 'action': r['action'], 'actor': r['actor'] or '', 'createdAt': r['createdAt']}
        for rawKey, outKey in (('beforeJson', 'before'), ('afterJson', 'after')):
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
        conn.execute("INSERT INTO sessionTopics (sessionId, topic, parentTopic, confidence, classifiedAt)\n               VALUES (?, ?, ?, ?, datetime('now'))\n               ON CONFLICT(sessionId) DO UPDATE SET\n                   topic=excluded.topic,\n                   parentTopic=excluded.parentTopic,\n                   confidence=excluded.confidence,\n                   classifiedAt=excluded.classifiedAt", (sessionId, topic, parentTopic, confidence))
        conn.commit()
        return True
    except Exception:
        return False

def getSessionTopic(sessionId: str) -> dict[str, object] | None:
    """Get the classified topic for a session."""
    conn = _conn()
    row = conn.execute('SELECT * FROM sessionTopics WHERE sessionId = ?', (sessionId,)).fetchone()
    return dict(row) if row else None

def listTopics(limit: int=50) -> list[dict[str, object]]:
    """List all classified session topics, most recent first."""
    conn = _conn()
    rows = conn.execute('SELECT * FROM sessionTopics ORDER BY classifiedAt DESC LIMIT ?', (limit,)).fetchall()
    return [dict(r) for r in rows]

def searchSessionsByTopic(topic: str) -> list[dict[str, object]]:
    """Find sessions with a given topic classification."""
    conn = _conn()
    rows = conn.execute('SELECT * FROM sessionTopics WHERE topic = ? ORDER BY classifiedAt DESC', (topic,)).fetchall()
    return [dict(r) for r in rows]

def saveSession(session: SessionRecord) -> None:
    """Persist a session record."""
    conn = _conn()
    conn.execute('INSERT OR REPLACE INTO sessions (id, title, startedAt, messageCount, provider, model, folderId, isArchived, workspacePath)\n           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', (session['id'], session.get('title', ''), session.get('startedAt'), session.get('messageCount', 0), session.get('provider', ''), session.get('model', ''), session.get('folderId'), 1 if session.get('isArchived') else 0, session.get('workspacePath')))
    conn.commit()

def listSessions() -> list[SessionRecord]:
    """List all sessions, most recent first."""
    conn = _conn()
    rows = conn.execute('SELECT * FROM sessions ORDER BY startedAt DESC').fetchall()
    return [dict(r) for r in rows]

def getSession(sessionId: str) -> SessionRecord | None:
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

def saveMessage(sessionId: str, role: str, content: JsonValue) -> int:
    """Save a message to a session."""
    conn = _conn()
    cursor = conn.execute('INSERT INTO messages (sessionId, role, content) VALUES (?, ?, ?)', (sessionId, role, _json(content)))
    conn.commit()
    return cursor.lastrowid

def getMessages(sessionId: str) -> list[MessageDict]:
    """Get all messages for a session."""
    conn = _conn()
    rows = conn.execute('SELECT * FROM messages WHERE sessionId = ? ORDER BY createdAt', (sessionId,)).fetchall()
    results: list[MessageDict] = []
    for r in rows:
        msg: MessageDict = dict(r)
        try:
            msg['content'] = json.loads(msg['content']) if isinstance(msg['content'], str) else msg['content']
        except (json.JSONDecodeError, TypeError):
            pass
        results.append(msg)
    return results

def deleteSessionMessages(sessionId: str) -> int:
    """Delete all messages for a session."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM messages WHERE sessionId = ?', (sessionId,))
    conn.commit()
    return cursor.rowcount

def recordUsage(sessionId: str, model: str, inputTokens: int=0, outputTokens: int=0, contextTokens: int=0) -> int:
    """Record a usage event.

    ``contextTokens`` captures the provider-reported ``inputTokens`` of the
    FINAL sub-call in the agentic turn — i.e. the true current context fill
    (system prompt + tools + messages, counted once). The cumulative
    ``inputTokens``/``outputTokens`` are still recorded for Usage-page totals.
    """
    conn = _conn()
    cursor = conn.execute('INSERT INTO usageEvents (sessionId, model, inputTokens, outputTokens, contextTokens) VALUES (?, ?, ?, ?, ?)', (sessionId, model, inputTokens, outputTokens, contextTokens))
    conn.commit()
    return cursor.lastrowid

def getUsage(sessionId: str) -> dict[str, object]:
    """Get aggregated usage for a session.

    Returns cumulative totals (for the Usage page) plus ``latestContextTokens``
    — the ``contextTokens`` of the most recent usage event, which equals the
    provider-reported inputTokens of the final sub-call of the latest turn
    (the true current context fill). Also returns the per-event list ordered
    newest-first so the caller can derive the same value independently.
    """
    conn = _conn()
    row = conn.execute('SELECT SUM(inputTokens) as totalInput, SUM(outputTokens) as totalOutput, COUNT(*) as requestCount FROM usageEvents WHERE sessionId = ?', (sessionId,)).fetchone()
    totals = dict(row) if row else {'totalInput': 0, 'totalOutput': 0, 'requestCount': 0}
    latest = conn.execute('SELECT contextTokens, inputTokens FROM usageEvents WHERE sessionId = ? ORDER BY createdAt DESC, id DESC LIMIT 1', (sessionId,)).fetchone()
    if latest:
        latestCtx = latest['contextTokens'] or latest['inputTokens']
    else:
        latestCtx = 0
    events = [{'id': e['id'], 'model': e['model'], 'inputTokens': e['inputTokens'], 'outputTokens': e['outputTokens'], 'contextTokens': e['contextTokens'] or e['inputTokens'], 'totalTokens': (e['inputTokens'] or 0) + (e['outputTokens'] or 0), 'createdAt': e['createdAt']} for e in conn.execute('SELECT id, model, inputTokens, outputTokens, contextTokens, createdAt FROM usageEvents WHERE sessionId = ? ORDER BY createdAt DESC, id DESC', (sessionId,)).fetchall()]
    return {'sessionId': sessionId, 'totalEvents': totals.get('requestCount', 0) or 0, 'totalInputTokens': totals.get('totalInput', 0) or 0, 'totalOutputTokens': totals.get('totalOutput', 0) or 0, 'totalTokens': (totals.get('totalInput', 0) or 0) + (totals.get('totalOutput', 0) or 0), 'totalCost': 0.0, 'model': events[0]['model'] if events else None, 'provider': None, 'contextTokens': latestCtx, 'latestContextTokens': latestCtx, 'events': events}

def vacuum() -> None:
    """Vacuum the database to reclaim space."""
    conn = _conn()
    conn.execute('VACUUM')
    conn.commit()

def getStats() -> dict[str, object]:
    """Get database statistics."""
    conn = _conn()
    stats = {}
    for table in ['memoryStore', 'facts', 'proposals', 'sessions', 'messages', 'usageEvents', 'sessionTopics']:
        try:
            row = conn.execute(f'SELECT COUNT(*) as count FROM {table}').fetchone()
            stats[table] = row['count'] if row else 0
        except Exception:
            stats[table] = 0
    stats['db_size_bytes'] = _dbPath().stat().st_size if _dbPath().exists() else 0
    return stats
_BRAINStores: dict[str, dict[str, object]] = {'memory': {'table': 'memoryStore', 'fts': 'memoryStore_fts', 'columns': 'key, value, updatedAt', 'search_cols': ['key', 'value'], 'label': 'key-value memory store'}, 'autoMemories': {'table': 'autoMemories', 'fts': 'autoMemories_fts', 'columns': 'id, key, content, category, importance, createdAt', 'search_cols': ['key', 'content'], 'label': 'auto-captured memories'}, 'heuristics': {'table': 'learnedHeuristics', 'fts': None, 'columns': 'id, rule, source, category, createdAt, updatedAt', 'search_cols': ['rule', 'source'], 'label': 'learned behavioral rules'}, 'facts': {'table': 'facts', 'fts': None, 'columns': 'id, factKey, factValue, category, source, confidence, createdAt, updatedAt', 'search_cols': ['factKey', 'factValue'], 'label': 'structured semantic facts'}, 'sessions': {'table': 'sessions', 'fts': None, 'columns': 'id, title, startedAt, messageCount, provider, model, workspacePath', 'search_cols': ['title', 'id'], 'label': 'conversation sessions'}, 'messages': {'table': 'messages', 'fts': None, 'columns': 'id, sessionId, role, content, createdAt', 'search_cols': ['content'], 'label': 'chat messages'}, 'timeline': {'table': 'episodicTimeline', 'fts': None, 'columns': 'id, timestamp, sessionId, eventSummary, category', 'search_cols': ['eventSummary', 'category', 'sessionId'], 'label': 'episodic timeline entries'}, 'blackboard': {'table': 'blackboard', 'fts': None, 'columns': 'id, sessionId, agent, key, value, priority, createdAt, expiresAt', 'search_cols': ['agent', 'key', 'value'], 'label': 'inter-agent blackboard notes'}, 'exams': {'table': 'exams', 'fts': None, 'columns': 'id, title, topic, createdAt, source, sourceFiles', 'search_cols': ['title', 'topic'], 'label': 'exam sessions'}, 'examAttempts': {'table': 'examAttempts', 'fts': None, 'columns': 'id, examId, questionId, selectedIndex, isCorrect, askedForHelp, answeredAt', 'search_cols': ['examId'], 'label': 'exam attempt history'}}

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

    Returns list of {sessionId, name, status, watchCondition, lastCheck, error} rows.
    If no daemons are running, returns an empty list.
    Gracefully degrades if daemon_manager is unavailable (returns []).
    """
    import json as _json
    try:
        from app.services import daemon_manager
    except ImportError:
        return _json.dumps([])
    try:
        internal = getattr(daemon_manager, '_daemons', None)
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
                row = {'sessionId': sessionId, 'name': info.get('name', ''), 'status': info.get('status', 'unknown'), 'watchCondition': info.get('watch_condition'), 'lastCheck': info.get('last_check'), 'error': info.get('error')}
                if filters and filters.get('sessionId') and (filters['sessionId'] != sessionId):
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
        params: list[object] = []
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
    """v2: Append an entry to episodicTimeline. Returns the new row's id."""
    conn = _conn()
    cur = conn.execute("INSERT INTO episodicTimeline (timestamp, sessionId, eventSummary, category) VALUES (datetime('now'), ?, ?, ?)", (sessionId, eventSummary, category))
    conn.commit()
    return cur.lastrowid

def timelineSweep() -> int:
    """v2: Hourly sweep. For sessions with no timeline entry, generate one.

    Returns the number of new entries created.
    """
    conn = _conn()
    rows = conn.execute('\n        SELECT s.id FROM sessions s\n        LEFT JOIN episodicTimeline t ON t.sessionId = s.id\n        WHERE t.id IS NULL\n        LIMIT 20\n    ').fetchall()
    if not rows:
        return 0
    count = 0
    for r in rows:
        sid = r['id']
        msgs = conn.execute('SELECT role, content FROM messages WHERE sessionId = ? ORDER BY id DESC LIMIT 10', (sid,)).fetchall()
        if not msgs:
            continue
        try:
            from app.services.workbench import model_fleet
            from app.providers import resolver as providerResolver
            from app.providers.clients import getClient
            model = model_fleet.getModelForRole('hippocampus')
            if not model:
                continue
            provider = providerResolver.resolve(model)
            if not provider:
                continue
            client = getClient(provider)
            if client and hasattr(client, 'generate'):
                transcript = '\n'.join((f"{m['role']}: {m['content'][:200]}" for m in msgs))
                prompt = f'Summarize this session in one line (under 100 words):\n\n{transcript}'
                try:
                    loop = asyncio.get_event_loop()
                    summary = loop.run_until_complete(client.generate(prompt))
                except Exception:
                    summary = None
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