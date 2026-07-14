"""SQLite schema setup for the August brain database.

Extracted from ``memory_store`` so table / FTS / trigger / index DDL lives in
one place. Connection management stays in ``memory_store``; this module only
mutates a provided ``sqlite3.Connection``.
"""

from __future__ import annotations

import logging
import sqlite3

_CORE_SCHEMA_SQL = """
        CREATE TABLE IF NOT EXISTS memoryStore (
            key TEXT PRIMARY KEY,
            value TEXT,
            updatedAt TEXT DEFAULT (datetime('now'))
        );

        -- FTS5 on memoryStore (content-sync table — triggers added below)
        CREATE VIRTUAL TABLE IF NOT EXISTS memoryStore_fts USING fts5(
            key, value, content='memoryStore', content_rowid='rowid'
        );

        CREATE TABLE IF NOT EXISTS facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            factKey TEXT UNIQUE NOT NULL,
            factValue TEXT NOT NULL,
            category TEXT DEFAULT 'general',
            source TEXT DEFAULT '',
            confidence REAL DEFAULT 1.0,
            createdAt TEXT DEFAULT (datetime('now')),
            updatedAt TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sessionId TEXT NOT NULL,
            proposalType TEXT NOT NULL,
            content TEXT,
            status TEXT DEFAULT 'pending',
            createdAt TEXT DEFAULT (datetime('now')),
            decidedAt TEXT,
            decidedBy TEXT
        );

        CREATE TABLE IF NOT EXISTS lifecycle (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sessionId TEXT,
            eventType TEXT NOT NULL,
            detail TEXT,
            createdAt TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sessionTopics (
            sessionId TEXT PRIMARY KEY,
            topic TEXT NOT NULL,
            parentTopic TEXT,
            confidence REAL DEFAULT 0.75,
            classifiedAt TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT,
            startedAt TEXT,
            messageCount INTEGER DEFAULT 0,
            provider TEXT DEFAULT '',
            model TEXT DEFAULT '',
            folderId TEXT,
            isArchived INTEGER DEFAULT 0,
            workspacePath TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sessionId TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            createdAt TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (sessionId) REFERENCES sessions(id)
        );

        CREATE TABLE IF NOT EXISTS usageEvents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sessionId TEXT,
            model TEXT,
            inputTokens INTEGER DEFAULT 0,
            outputTokens INTEGER DEFAULT 0,
            contextTokens INTEGER DEFAULT 0,
            createdAt TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS configAudit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            action TEXT NOT NULL,
            actor TEXT DEFAULT '',
            beforeJson TEXT,
            afterJson TEXT,
            createdAt TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS learnedHeuristics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule TEXT NOT NULL,
            source TEXT DEFAULT '',
            category TEXT DEFAULT 'general',
            createdAt TEXT DEFAULT (datetime('now')),
            updatedAt TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS autoMemories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT,
            content TEXT,
            category TEXT DEFAULT 'auto',
            importance REAL DEFAULT 0.5,
            source TEXT DEFAULT '',
            createdAt TEXT DEFAULT (datetime('now')),
            updatedAt TEXT DEFAULT (datetime('now'))
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS autoMemories_fts USING fts5(
            key, content, content='autoMemories', content_rowid='rowid'
        );

        -- FTS5 triggers — CRITICAL — without these FTS indexes stay empty
        -- memoryStore_fts triggers
        CREATE TRIGGER IF NOT EXISTS memoryStore_fts_ai AFTER INSERT ON memoryStore BEGIN
            INSERT INTO memoryStore_fts(rowid, key, value)
            VALUES (new.rowid, new.key, new.value);
        END;
        CREATE TRIGGER IF NOT EXISTS memoryStore_fts_ad AFTER DELETE ON memoryStore BEGIN
            INSERT INTO memoryStore_fts(memoryStore_fts, rowid, key, value)
            VALUES('delete', old.rowid, old.key, old.value);
        END;
        CREATE TRIGGER IF NOT EXISTS memoryStore_fts_au AFTER UPDATE ON memoryStore BEGIN
            INSERT INTO memoryStore_fts(memoryStore_fts, rowid, key, value)
            VALUES('delete', old.rowid, old.key, old.value);
            INSERT INTO memoryStore_fts(rowid, key, value)
            VALUES (new.rowid, new.key, new.value);
        END;

        -- autoMemories_fts triggers
        CREATE TRIGGER IF NOT EXISTS autoMemories_ai AFTER INSERT ON autoMemories BEGIN
            INSERT INTO autoMemories_fts(rowid, key, content)
            VALUES (new.id, new.key, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS autoMemories_ad AFTER DELETE ON autoMemories BEGIN
            INSERT INTO autoMemories_fts(autoMemories_fts, rowid, key, content)
            VALUES('delete', old.id, old.key, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS autoMemories_au AFTER UPDATE ON autoMemories BEGIN
            INSERT INTO autoMemories_fts(autoMemories_fts, rowid, key, content)
            VALUES('delete', old.id, old.key, old.content);
            INSERT INTO autoMemories_fts(rowid, key, content)
            VALUES (new.id, new.key, new.content);
        END;

        CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
        CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updatedAt);
        CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(sessionId);
        CREATE INDEX IF NOT EXISTS idx_lifecycle_session ON lifecycle(sessionId);
        CREATE INDEX IF NOT EXISTS idx_lifecycle_event ON lifecycle(eventType);
        CREATE INDEX IF NOT EXISTS idx_configAudit_category ON configAudit(category);
        CREATE INDEX IF NOT EXISTS idx_configAudit_created ON configAudit(createdAt);
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId);
        CREATE INDEX IF NOT EXISTS idx_usageEvents_session ON usageEvents(sessionId);
        CREATE INDEX IF NOT EXISTS idx_usageEvents_created ON usageEvents(createdAt);
        CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(isArchived);
    """


def ensure_column(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    """Add a column to a table if it does not already exist (idempotent)."""
    cols = {row['name'] for row in conn.execute(f'PRAGMA table_info({table})').fetchall()}
    if column not in cols:
        conn.execute(f'ALTER TABLE {table} ADD COLUMN {column} {decl}')
        conn.commit()


def create_core_schema(conn: sqlite3.Connection) -> None:
    """Create core tables, FTS virtual tables, sync triggers, and primary indexes."""
    conn.executescript(_CORE_SCHEMA_SQL)
    conn.commit()
    rowCount = conn.execute('SELECT count(*) FROM memoryStore_fts').fetchone()[0]
    if rowCount == 0:
        conn.execute(
            """
            INSERT INTO memoryStore_fts(rowid, key, value)
            SELECT rowid, key, value FROM memoryStore
        """
        )
    conn.commit()
    try:
        cols = [r['name'] for r in conn.execute('PRAGMA table_info(autoMemories)').fetchall()]
        if 'updatedAt' not in cols:
            conn.execute('ALTER TABLE autoMemories ADD COLUMN updatedAt TEXT')
    except Exception as exc:
        logging.warning('autoMemories updatedAt migration failed: %s', exc)


def create_extended_tables(conn: sqlite3.Connection) -> None:
    """Create extended tables (timeline, blackboard, exams, pending skills) and their indexes."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS episodicTimeline (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            sessionId TEXT,
            eventSummary TEXT,
            category TEXT DEFAULT 'general'
        )
    """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS blackboard (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sessionId TEXT NOT NULL,
            agent TEXT NOT NULL DEFAULT 'main',
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            priority INTEGER DEFAULT 0,
            createdAt TEXT DEFAULT (datetime('now')),
            expiresAt TEXT
        )
    """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS exams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            topic TEXT DEFAULT '',
            createdAt TEXT DEFAULT (datetime('now')),
            source TEXT DEFAULT 'model',
            sourceFiles TEXT DEFAULT ''
        )
    """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS examQuestions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            examId INTEGER NOT NULL,
            position INTEGER NOT NULL,
            stem TEXT NOT NULL,
            options TEXT NOT NULL,
            correctIndex INTEGER NOT NULL,
            rationale TEXT DEFAULT '',
            sourceSnippet TEXT DEFAULT '',
            origin TEXT DEFAULT 'generated',
            FOREIGN KEY (examId) REFERENCES exams(id)
        )
    """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS examAttempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            examId INTEGER NOT NULL,
            questionId INTEGER NOT NULL,
            selectedIndex INTEGER,
            isCorrect INTEGER DEFAULT 0,
            askedForHelp INTEGER DEFAULT 0,
            answeredAt TEXT DEFAULT (datetime('now'))
        )
    """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS pendingSkills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            description TEXT,
            triggerText TEXT,
            draftPath TEXT NOT NULL,
            sourceSessionId TEXT,
            sourceWorkflow TEXT,
            createdBy TEXT DEFAULT 'auto-gen',
            createdAt TEXT DEFAULT (datetime('now')),
            status TEXT DEFAULT 'pending',
            useCount INTEGER DEFAULT 0,
            lastSurfacedAt TEXT
        )
    """
    )
    # Indexes for tables created after the main executescript (must run after CREATE TABLE).
    conn.execute('CREATE INDEX IF NOT EXISTS idx_blackboard_session ON blackboard(sessionId)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_examAttempts_exam ON examAttempts(examId)')
    conn.commit()
    ensure_column(conn, 'usageEvents', 'contextTokens', 'INTEGER DEFAULT 0')


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Idempotently create the full brain schema on ``conn``."""
    create_core_schema(conn)
    create_extended_tables(conn)
