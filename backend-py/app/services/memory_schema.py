"""SQLite schema setup for the August brain database.

Extracted from ``memory_store`` so table / FTS / trigger / index DDL lives in
one place. Connection management stays in ``memory_store``; this module only
mutates a provided ``sqlite3.Connection``.

Schema identifiers are **snake_case**. Wire/API rows stay camelCase via
``memory_store._row_as_wire`` (snakeToCamel). On startup, ``ensure_schema``
runs the idempotent camel→snake migration before CREATE TABLE IF NOT EXISTS.
"""

from __future__ import annotations

import logging
import sqlite3

from app.services.schema_rename_migration import migrate_camel_to_snake

_CORE_SCHEMA_SQL = """
        CREATE TABLE IF NOT EXISTS memory_store (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );

        -- FTS5 on memory_store (content-sync table — triggers added below)
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_store_fts USING fts5(
            key, value, content='memory_store', content_rowid='rowid'
        );

        CREATE TABLE IF NOT EXISTS facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fact_key TEXT UNIQUE NOT NULL,
            fact_value TEXT NOT NULL,
            category TEXT DEFAULT 'general',
            source TEXT DEFAULT '',
            confidence REAL DEFAULT 1.0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            proposal_type TEXT NOT NULL,
            content TEXT,
            status TEXT DEFAULT 'pending',
            created_at TEXT DEFAULT (datetime('now')),
            decided_at TEXT,
            decided_by TEXT
        );

        CREATE TABLE IF NOT EXISTS lifecycle (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            event_type TEXT NOT NULL,
            detail TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS session_topics (
            session_id TEXT PRIMARY KEY,
            topic TEXT NOT NULL,
            parent_topic TEXT,
            confidence REAL DEFAULT 0.75,
            classified_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT,
            started_at TEXT,
            message_count INTEGER DEFAULT 0,
            provider TEXT DEFAULT '',
            model TEXT DEFAULT '',
            folder_id TEXT,
            is_archived INTEGER DEFAULT 0,
            workspace_path TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE TABLE IF NOT EXISTS usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            model TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            context_tokens INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS config_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            action TEXT NOT NULL,
            actor TEXT DEFAULT '',
            before_json TEXT,
            after_json TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS learned_heuristics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule TEXT NOT NULL,
            source TEXT DEFAULT '',
            category TEXT DEFAULT 'general',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS auto_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT,
            content TEXT,
            category TEXT DEFAULT 'auto',
            importance REAL DEFAULT 0.5,
            source TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS auto_memories_fts USING fts5(
            key, content, content='auto_memories', content_rowid='rowid'
        );

        -- FTS5 triggers — CRITICAL — without these FTS indexes stay empty
        -- memory_store_fts triggers
        CREATE TRIGGER IF NOT EXISTS memory_store_fts_ai AFTER INSERT ON memory_store BEGIN
            INSERT INTO memory_store_fts(rowid, key, value)
            VALUES (new.rowid, new.key, new.value);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_store_fts_ad AFTER DELETE ON memory_store BEGIN
            INSERT INTO memory_store_fts(memory_store_fts, rowid, key, value)
            VALUES('delete', old.rowid, old.key, old.value);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_store_fts_au AFTER UPDATE ON memory_store BEGIN
            INSERT INTO memory_store_fts(memory_store_fts, rowid, key, value)
            VALUES('delete', old.rowid, old.key, old.value);
            INSERT INTO memory_store_fts(rowid, key, value)
            VALUES (new.rowid, new.key, new.value);
        END;

        -- auto_memories_fts triggers
        CREATE TRIGGER IF NOT EXISTS auto_memories_ai AFTER INSERT ON auto_memories BEGIN
            INSERT INTO auto_memories_fts(rowid, key, content)
            VALUES (new.id, new.key, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS auto_memories_ad AFTER DELETE ON auto_memories BEGIN
            INSERT INTO auto_memories_fts(auto_memories_fts, rowid, key, content)
            VALUES('delete', old.id, old.key, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS auto_memories_au AFTER UPDATE ON auto_memories BEGIN
            INSERT INTO auto_memories_fts(auto_memories_fts, rowid, key, content)
            VALUES('delete', old.id, old.key, old.content);
            INSERT INTO auto_memories_fts(rowid, key, content)
            VALUES (new.id, new.key, new.content);
        END;

        CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
        CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updated_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(session_id);
        CREATE INDEX IF NOT EXISTS idx_lifecycle_session ON lifecycle(session_id);
        CREATE INDEX IF NOT EXISTS idx_lifecycle_event ON lifecycle(event_type);
        CREATE INDEX IF NOT EXISTS idx_config_audit_category ON config_audit(category);
        CREATE INDEX IF NOT EXISTS idx_config_audit_created ON config_audit(created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(is_archived);
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
    # Cheap no-op path: only rebuild FTS when base has rows and FTS is empty.
    # Avoids a full count on both sides when the brain is empty (common cold start).
    base_any = conn.execute('SELECT 1 FROM memory_store LIMIT 1').fetchone()
    if base_any is not None:
        fts_any = conn.execute('SELECT 1 FROM memory_store_fts LIMIT 1').fetchone()
        if fts_any is None:
            conn.execute(
                """
                INSERT INTO memory_store_fts(rowid, key, value)
                SELECT rowid, key, value FROM memory_store
            """
            )
    conn.commit()
    try:
        cols = [r['name'] for r in conn.execute('PRAGMA table_info(auto_memories)').fetchall()]
        if 'updated_at' not in cols:
            conn.execute('ALTER TABLE auto_memories ADD COLUMN updated_at TEXT')
    except Exception as exc:
        logging.warning('auto_memories updated_at migration failed: %s', exc)


def create_extended_tables(conn: sqlite3.Connection) -> None:
    """Create extended tables (timeline, blackboard, exams, pending skills) and their indexes."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS episodic_timeline (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            session_id TEXT,
            event_summary TEXT,
            category TEXT DEFAULT 'general'
        )
    """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS blackboard (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            agent TEXT NOT NULL DEFAULT 'main',
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            priority INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT
        )
    """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS exams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            topic TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            source TEXT DEFAULT 'model',
            source_files TEXT DEFAULT ''
        )
    """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS exam_questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            position INTEGER NOT NULL,
            stem TEXT NOT NULL,
            options TEXT NOT NULL,
            correct_index INTEGER NOT NULL,
            rationale TEXT DEFAULT '',
            source_snippet TEXT DEFAULT '',
            origin TEXT DEFAULT 'generated',
            FOREIGN KEY (exam_id) REFERENCES exams(id)
        )
    """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS exam_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            question_id INTEGER NOT NULL,
            selected_index INTEGER,
            is_correct INTEGER DEFAULT 0,
            asked_for_help INTEGER DEFAULT 0,
            answered_at TEXT DEFAULT (datetime('now'))
        )
    """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS pending_skills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            description TEXT,
            trigger_text TEXT,
            draft_path TEXT NOT NULL,
            source_session_id TEXT,
            source_workflow TEXT,
            created_by TEXT DEFAULT 'auto-gen',
            created_at TEXT DEFAULT (datetime('now')),
            status TEXT DEFAULT 'pending',
            use_count INTEGER DEFAULT 0,
            last_surfaced_at TEXT
        )
    """
    )
    # Indexes for tables created after the main executescript (must run after CREATE TABLE).
    conn.execute('CREATE INDEX IF NOT EXISTS idx_blackboard_session ON blackboard(session_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_exam_attempts_exam ON exam_attempts(exam_id)')
    conn.commit()
    ensure_column(conn, 'usage_events', 'context_tokens', 'INTEGER DEFAULT 0')


# Bump when DDL / indexes change in a way that requires re-running create_*.
# user_version is set after a successful ensure_schema so warm boots can skip
# the heavy CREATE IF NOT EXISTS + migration probe when already current.
_SCHEMA_USER_VERSION = 5


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Idempotently migrate camel→snake (if needed) then create the full brain schema.

    Warm path: if ``PRAGMA user_version`` already matches ``_SCHEMA_USER_VERSION``
    and core tables exist, skip migration + DDL (indexes already present).
    """
    try:
        ver = int(conn.execute('PRAGMA user_version').fetchone()[0])
    except Exception:
        ver = 0
    if ver >= _SCHEMA_USER_VERSION:
        # Still verify one core table exists (corrupt / empty file edge).
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_store' LIMIT 1"
        ).fetchone()
        if row is not None:
            return
    migrate_camel_to_snake(conn)
    create_core_schema(conn)
    create_extended_tables(conn)
    conn.execute(f'PRAGMA user_version={_SCHEMA_USER_VERSION}')
    conn.commit()
