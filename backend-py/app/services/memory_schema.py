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
import re
import sqlite3
import threading

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
            -- The scope axis lives in the base DDL, not in a follow-up ALTER:
            -- it is part of the row's identity (UNIQUE below), and a fresh
            -- database should be born with the constraint rather than inherit
            -- it from a rebuild. Migration 032 still ALTERs `scope` on a legacy
            -- DB and gets "duplicate column name", which the runner records as
            -- already-applied — the documented double-ownership pattern.
            fact_key TEXT NOT NULL,
            fact_value TEXT NOT NULL,
            category TEXT DEFAULT 'general',
            source TEXT DEFAULT '',
            confidence REAL DEFAULT 1.0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT,
            title TEXT DEFAULT '',
            kind TEXT DEFAULT 'fact',
            use_count INTEGER DEFAULT 0,
            last_used_at TEXT,
            status TEXT DEFAULT 'active',
            scope TEXT NOT NULL DEFAULT 'global',
            description TEXT DEFAULT '',
            -- 055: the supersession lineage (M-3) and the trust/recall
            -- signals (M-7, M-8). A fresh database is born with them; the
            -- 055 migration ALTERs them onto a legacy one and gets
            -- "duplicate column name", which the runner records as
            -- already-applied — the documented double-ownership pattern.
            superseded_by TEXT,
            supersedes TEXT DEFAULT '[]',
            injected_count INTEGER DEFAULT 0,
            last_injected_at TEXT,
            verified_at TEXT,
            contradicts TEXT,
            -- One key per SCOPE, not one key in the whole store. The old
            -- column-level UNIQUE forced every per-scope memory to be
            -- hand-namespaced by the caller, and the namespacing changed the
            -- consolidation slug — so the same content saved globally and by a
            -- Bot became two rows that could never be merged. See
            -- `_ensure_fact_scope_key` for the rebuild on existing databases.
            UNIQUE (scope, fact_key)
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
            -- 047: structured transcript payload (block timeline + thinking /
            -- tools / attachments / todos / usage …). NULL = legacy text-only
            -- row; `content` stays the FTS-indexed text either way.
            blocks_json TEXT,
            -- 048: stable join key for the desktop-authored block timeline.
            -- NULL on every legacy / server-derived row; the unique index
            -- below makes POST /api/sessions/{id}/messages idempotent when the
            -- client replays the same message.
            client_message_id TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        -- FTS5 on messages (content-sync; triggers below)
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content, session_id, role, content='messages', content_rowid='id'
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
            confidence REAL DEFAULT 0.5,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        -- auto_memories RETIRED (Part 21 OQ1 ruling, 2026-09-04): the table
        -- + its FTS + triggers are no longer created. Migration 033 drops
        -- them from legacy DBs. No live writer existed; the privacy export is
        -- the documented preservation path; production's rows were stale
        -- conv_summary junk. Fresh DBs never have it; every reader is
        -- table-existence guarded.

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

        -- messages_fts triggers (rowid = messages.id)
        CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content, session_id, role)
            VALUES (new.id, new.content, new.session_id, new.role);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content, session_id, role)
            VALUES('delete', old.id, old.content, old.session_id, old.role);
        END;
        -- 048: scoped to the INDEXED columns. A blocks-only enrichment write
        -- (UPDATE messages SET blocks_json) must not churn the FTS payload —
        -- the search index does not contain blocks_json at all. The DROP is
        -- needed for a pre-048 database: CREATE ... IF NOT EXISTS would keep
        -- the old unscoped trigger.
        DROP TRIGGER IF EXISTS messages_fts_au;
        CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content, session_id, role ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content, session_id, role)
            VALUES('delete', old.id, old.content, old.session_id, old.role);
            INSERT INTO messages_fts(rowid, content, session_id, role)
            VALUES (new.id, new.content, new.session_id, new.role);
        END;

        CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
        CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updated_at);
        -- 055: the lineage and the conflict lookups. A fresh database is born
        -- with them; a legacy one gets them from the 055 migration (and a
        -- missing index costs a scan, never a lock — which is why the
        -- per-boot `ensure_column` helper does NOT create indexes).
        CREATE INDEX IF NOT EXISTS idx_facts_superseded_by ON facts(superseded_by);
        CREATE INDEX IF NOT EXISTS idx_facts_contradicts ON facts(contradicts);
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


def _facts_has_scope_key(conn: sqlite3.Connection) -> bool:
    """True when `facts` already carries UNIQUE(scope, fact_key)."""
    try:
        for idx in conn.execute('PRAGMA index_list(facts)').fetchall():
            # seq=1 is the autoindex a table-level UNIQUE creates; a named
            # unique index created by hand is equivalent for this purpose.
            if not idx[2]:
                continue
            cols = [r[2] for r in conn.execute(f'PRAGMA index_info("{idx[1]}")').fetchall()]
            if cols == ['scope', 'fact_key']:
                return True
    except Exception:
        return False
    return False


def _facts_table_columns(conn: sqlite3.Connection) -> list[tuple[str, str, int, int, object]]:
    """``(name, decl, pk, notnull, dflt)`` for every column of ``facts``."""
    rows = conn.execute('PRAGMA table_info(facts)').fetchall()
    return [(r[1], r[2], r[5], r[3], r[4]) for r in rows]


# A column default that can be emitted verbatim: a quoted string literal or a
# plain number. Anything else (a function call such as ``datetime('now')``)
# needs parentheses — SQLite requires ``DEFAULT (expr)``, and PRAGMA reports the
# default WITHOUT them, so emitting it raw is a syntax error at the ``(``.
_SIMPLE_DEFAULT_RE = re.compile(r"^(-?'[^']*'|-?\d+(?:\.\d+)?)$")


def _default_clause(dflt: object) -> str:
    """``DEFAULT ...`` for a column, safe for expression defaults."""
    if dflt is None:
        return ''
    text = str(dflt)
    if _SIMPLE_DEFAULT_RE.match(text):
        return f' DEFAULT {text}'
    return f' DEFAULT ({text})'


def _ensure_fact_scope_key(conn: sqlite3.Connection) -> None:
    """Rebuild `facts` with UNIQUE(scope, fact_key) — one key per scope.

    Why a rebuild and not an ALTER: SQLite cannot add a constraint to a
    column, and the old ``fact_key TEXT UNIQUE`` is exactly the constraint that
    has to go. Nothing else in the schema can do this.

    Why HERE and not in a .sql migration: ``run_migrations`` applies files
    with ``conn.executescript``, which commits any open transaction before it
    runs, and its own failure bookkeeping commits again afterwards — so a
    half-applied rebuild in a .sql file could be *committed* by the runner
    treating the failure. Holding the transaction here means a failure
    ROLLS BACK and leaves the original table exactly as it was.

    What it fixes (measured 2026-10-17): ``fact_key`` unique store-wide forced
    the only per-scope mechanism to be caller-side key namespacing
    (``_deriveFactKey`` prefixes non-global keys with the scope). That prefix
    also changes the consolidation slug, so the same content stored globally and
    by a Bot became two rows that could never be merged — the workaround
    manufactured the near-duplicates the merge pass exists to remove. The
    composite key makes the namespacing unnecessary.

    Resumable: if a previous attempt died between DROP and RENAME (only a
    process kill can do that, and SQLite rolls back the transaction anyway),
    the staging table is detected and the rename is finished instead of
    rebuilding from a missing source.

    NULL scope is collapsed to 'global' on copy — the value it has always been
    READ as (``_visibility_where``), so this removes the fourth answer to
    "whose memory is this row?" rather than inventing one.
    """
    log = logging.getLogger('august.memory_schema')
    try:
        tables = {
            r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    except Exception:
        return
    if 'facts' not in tables:
        return  # a fresh DB is created with the constraint in create_core_schema

    if _facts_has_scope_key(conn):
        # Already rebuilt. Drop a staging table an aborted attempt left behind
        # (harmless: the rebuild either completed or rolled back).
        if 'facts_v2' in tables:
            conn.execute('DROP TABLE facts_v2')
            conn.commit()
        return

    try:
        conn.execute('BEGIN IMMEDIATE')
        if 'facts_v2' in tables and 'facts' not in tables:
            # Resume: the source is gone but the copy exists.
            conn.execute('ALTER TABLE facts_v2 RENAME TO facts')
        else:
            cols = _facts_table_columns(conn)
            if not cols:
                conn.execute('ROLLBACK')
                return
            decls: list[str] = []
            names: list[str] = []
            selects: list[str] = []
            has_scope = False
            for name, decl, pk, _notnull, dflt in cols:
                names.append(f'"{name}"')
                if pk:
                    decls.append(f'"{name}" INTEGER PRIMARY KEY AUTOINCREMENT')
                else:
                    decls.append(f'"{name}" {decl}{_default_clause(dflt)}')
                if name == 'scope':
                    has_scope = True
                    selects.append("COALESCE(scope, 'global')")
                else:
                    selects.append(f'"{name}"')
            if not has_scope:
                # A database older than migration 032 with no scope column at
                # all: every row is a global row, which is what it was read as.
                decls.append("scope TEXT NOT NULL DEFAULT 'global'")
                names.append('"scope"')
                selects.append("'global'")
            conn.execute(
                'CREATE TABLE facts_v2 (' + ', '.join(decls) + ', UNIQUE (scope, fact_key))'
            )
            before = conn.execute('SELECT COUNT(*) FROM facts').fetchone()[0]
            conn.execute(
                f'INSERT INTO facts_v2 ({", ".join(names)}) '
                f'SELECT {", ".join(selects)} FROM facts'
            )
            copied = conn.execute('SELECT COUNT(*) FROM facts_v2').fetchone()[0]
            if copied != before:
                raise RuntimeError(f'fact rebuild lost rows: {before} -> {copied}')
            conn.execute('DROP TABLE facts')
            conn.execute('ALTER TABLE facts_v2 RENAME TO facts')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updated_at)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope, status)')
        conn.commit()
        log.info('facts rebuilt with UNIQUE(scope, fact_key)')
    except Exception as exc:
        try:
            conn.execute('ROLLBACK')
        except Exception:  # noqa: BLE001
            pass
        log.warning('facts scope-key rebuild skipped: %s', exc)


def _ensure_fact_signal_columns(conn: sqlite3.Connection) -> None:
    """The 055 columns: fact lineage, the trust/recall signals, the source stamp.

    Called from BOTH paths of :func:`ensure_schema`, so the columns exist
    before anything writes a fact — ``save_fact``'s UPSERT names
    ``verified_at``, and a database missing it would refuse every fact write.

    Why the code path owns this and not only the ``.sql`` migration: the
    runner applies a ``.sql`` file with ``conn.executescript``, which ABORTS
    at the first failing statement, and its own bookkeeping then records the
    version as applied even though the REST of the script never ran. A
    multi-column migration whose first statement is already satisfied (which
    is exactly what the ``ensure_column`` fast path guarantees) therefore
    skips its remaining statements — and a migration that half-ran is worse
    than one that did not run, because the version table says it is done.

    This is the same reasoning as :func:`_ensure_fact_scope_key`, for the
    same family of reasons. The ``.sql`` file (055) is the numbered RECORD
    of the change and the cold-path owner; this helper is the guarantee. The
    two cover the SAME columns, so the executescript abort on a warm boot is
    harmless.
    """
    ensure_column(conn, 'facts', 'superseded_by', 'TEXT')
    ensure_column(conn, 'facts', 'supersedes', "TEXT DEFAULT '[]'")
    ensure_column(conn, 'facts', 'injected_count', 'INTEGER DEFAULT 0')
    ensure_column(conn, 'facts', 'last_injected_at', 'TEXT')
    ensure_column(conn, 'facts', 'verified_at', 'TEXT')
    ensure_column(conn, 'facts', 'contradicts', 'TEXT')
    # 055: the automation SOURCE stamp (M-12). `episodes.scope` is "whose
    # memory is this?"; the source is "what produced this?".
    ensure_column(conn, 'episodes', 'source', 'TEXT')
    ensure_column(conn, 'turn_outcomes', 'source', 'TEXT')
    # NO index creation here. This helper runs on EVERY `memory_store.init()`
    # — which the session snapshot writer calls on every save — and a
    # `CREATE INDEX` takes a schema lock, so creating them here made the
    # snapshot thread lose a race with the main thread's write and fail with
    # "database is locked". The indexes belong to the 055 migration (once)
    # and to the core DDL (a fresh database); a missing index costs a scan,
    # not a lock.


def ensure_column(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    """Add a column to a table if it does not already exist (idempotent).

    Tolerates the concurrent-init race: two connections (e.g. the debounced
    session-snapshot thread and the main loop during startup) can both see
    the column missing and both ALTER — the loser gets "duplicate column
    name", which is harmless and must not abort schema setup.

    No-op when the table itself is absent (e.g. learned_heuristics after the
    empty-legacy-table drop): the table's creator owns its columns then.
    """
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", (table,)
    ).fetchone()
    if exists is None:
        return
    cols = {row['name'] for row in conn.execute(f'PRAGMA table_info({table})').fetchall()}
    if column not in cols:
        try:
            conn.execute(f'ALTER TABLE {table} ADD COLUMN {column} {decl}')
            conn.commit()
        except sqlite3.OperationalError as exc:
            if 'duplicate column' in str(exc).lower():
                return
            raise


def create_core_schema(conn: sqlite3.Connection) -> None:
    """Create core tables, FTS virtual tables, sync triggers, and primary indexes.

    Serialized process-wide. `CREATE VIRTUAL TABLE ... USING fts5` is not a
    single atomic step: SQLite constructs the virtual table and its shadow
    tables (`_content`, `_idx`, `_docsize`, `_config`) as part of opening it.
    Two connections running this against one file concurrently can interleave
    so that one creates the sync triggers against a half-built vtable, and the
    file is left with a `memory_store_fts` entry in `sqlite_master` whose
    shadow tables are incomplete.

    That state is permanent and self-reinforcing, because
    `CREATE VIRTUAL TABLE IF NOT EXISTS` then sees the surviving entry and
    skips it. Every later write to `memory_store` fails, because the AFTER
    INSERT trigger cannot open the index — so a rebuildable search index takes
    durable rows down with it — and every search returns nothing, which reads
    as "no matches" rather than as a broken database.

    DDL against one SQLite file should be serialized regardless; this is the
    cheapest place to say so. Re-entrant because `ensure_schema` calls into
    helpers that may reach back here.
    """
    with _SCHEMA_LOCK:
        _create_core_schema_locked(conn)


def _create_core_schema_locked(conn: sqlite3.Connection) -> None:
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
        # auto_memories column migration removed.
        hcols = [r['name'] for r in conn.execute('PRAGMA table_info(learned_heuristics)').fetchall()]
        if 'confidence' not in hcols:
            conn.execute('ALTER TABLE learned_heuristics ADD COLUMN confidence REAL DEFAULT 0.5')
    except Exception as exc:
        logging.warning('heuristics column migration failed: %s', exc)


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
    # Tables probed by cognitive health selfcheck — must exist when features are on.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS execution_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            state_key TEXT NOT NULL,
            state_value TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS scratchpad (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            content TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tool_guardrail_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            tool_name TEXT,
            reason TEXT,
            created_at TEXT DEFAULT (datetime('now'))
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
    # pending_skills RETIRED (migration 043, 2026-09-11): the table had no
    # writer, reader, router, or UI consumer anywhere — human-gated skill
    # drafts go through the harness proposals queue + Review Inbox instead.
    # The sessions.py cascade delete stays (try/except) for old installs
    # until the drop lands.
    # Additive columns for blackboard workspace persistence (must run before indexes on them).
    ensure_column(conn, 'blackboard', 'workspace_path', "TEXT DEFAULT ''")
    ensure_column(conn, 'blackboard', 'folder_id', "TEXT DEFAULT ''")
    # Indexes for tables created after the main executescript (must run after CREATE TABLE).
    conn.execute('CREATE INDEX IF NOT EXISTS idx_blackboard_session ON blackboard(session_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_blackboard_workspace ON blackboard(workspace_path)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_exam_attempts_exam ON exam_attempts(exam_id)')
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS daemons (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            workspace_path TEXT DEFAULT '',
            name TEXT NOT NULL,
            spec_json TEXT DEFAULT '{}',
            result_json TEXT DEFAULT '{}',
            status TEXT DEFAULT 'running',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT
        )
        """
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_daemons_session ON daemons(session_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_daemons_workspace ON daemons(workspace_path)')
    conn.commit()
    # auto_memories ensure-columns removed.
    # facts.expires_at backs the `remember` tool's optional TTL and the boot
    # sweep that purges expired model-written facts (memory-humanization batch).
    ensure_column(conn, 'facts', 'expires_at', 'TEXT')
    # Knowledge-base redesign (plan 2026-08-27 §3.3): facts is the one durable
    # memory store — titled, typed, usage-tracked, supersede-aware.
    ensure_column(conn, 'facts', 'title', "TEXT DEFAULT ''")
    ensure_column(conn, 'facts', 'kind', "TEXT DEFAULT 'fact'")
    ensure_column(conn, 'facts', 'use_count', 'INTEGER DEFAULT 0')
    ensure_column(conn, 'facts', 'last_used_at', 'TEXT')
    ensure_column(conn, 'facts', 'status', "TEXT DEFAULT 'active'")
    # ZCode-parity (044): one-line recall hook — boot-index line + BM25 text.
    ensure_column(conn, 'facts', 'description', "TEXT DEFAULT ''")
    ensure_column(conn, 'usage_events', 'context_tokens', 'INTEGER DEFAULT 0')
    ensure_column(conn, 'usage_events', 'cache_hit_tokens', 'INTEGER DEFAULT 0')
    ensure_column(conn, 'usage_events', 'cache_miss_tokens', 'INTEGER DEFAULT 0')
    # Full workbench session JSON + last-update time (primary session store).
    ensure_column(conn, 'sessions', 'workbench_blob', 'TEXT')
    ensure_column(conn, 'sessions', 'updated_at', 'TEXT')
    # 047: durable structured transcript blocks per message. No DEFAULT — NULL
    # means "this row predates structured transcripts", not "empty transcript".
    ensure_column(conn, 'messages', 'blocks_json', 'TEXT')
    # 048: client-authored identity for the rich transcript sync. Also NULL by
    # default — absence means "server-derived row, no client identity".
    ensure_column(conn, 'messages', 'client_message_id', 'TEXT')
    conn.execute(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id '
        'ON messages(session_id, client_message_id) '
        'WHERE client_message_id IS NOT NULL'
    )
    # Per-agent todo list (JSON) for sub-agent runs — drawer parity.
    ensure_column(conn, 'subagent_runs', 'todos_json', "TEXT DEFAULT ''")
    conn.execute(
        'CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)'
    )


# Bump when DDL / indexes change in a way that requires re-running create_*.
# user_version is set after a successful ensure_schema so warm boots can skip
# the heavy CREATE IF NOT EXISTS + migration probe when already current.
# v10: vector/graph tables removed (025_memory_state_separation drops them).
# v11: knowledge-base redesign — internal_state + turn_outcomes tables (026),
#      facts title/kind/use_count/last_used_at/status columns.
# v12: turn latency telemetry (027) — turn_outcomes ttft_ms + cache hit/miss.
# v13: early-dispatch telemetry (030) — turn_outcomes.tool_args_ready_to_stream_end_ms.
# v14: facts.description column (044) — ZCode-parity recall hook.
# v15: messages.blocks_json column (047) — durable structured transcript blocks.
# v16: messages.client_message_id column + unique index (048) — client-authored
#      message identity; the FTS UPDATE trigger is narrowed to the indexed
#      columns so blocks-only enrichment writes never re-index.
_SCHEMA_USER_VERSION = 16


def _ensure_messages_fts(conn: sqlite3.Connection) -> None:
    """Idempotent messages FTS + triggers (schema v8 additive upgrade).

    Takes `_SCHEMA_LOCK` for the same reason the memory-store rebuild does.
    Round-2 review found this was the THIRD `CREATE VIRTUAL TABLE ... USING
    fts5` site against a brain file, and it was the one still outside the lock
    — `ensure_schema` calls it one line from `repair_fts_sync`, which does
    take it. Locking two of three writers leaves the class open, which is the
    whole point of having a lock: it is not a list of sites someone has to
    remember.

    `_SCHEMA_LOCK` is re-entrant, so the calls that already hold it — the
    schema path reaching here through `create_core_schema` — do not deadlock.
    """
    with _SCHEMA_LOCK:
        _ensure_messages_fts_locked(conn)


def _ensure_messages_fts_locked(conn: sqlite3.Connection) -> None:
    """Body of `_ensure_messages_fts`; callers must already hold `_SCHEMA_LOCK`."""
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content, session_id, role, content='messages', content_rowid='id'
        )
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content, session_id, role)
            VALUES (new.id, new.content, new.session_id, new.role);
        END
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content, session_id, role)
            VALUES('delete', old.id, old.content, old.session_id, old.role);
        END
        """
    )
    # 048: recreate the UPDATE trigger scoped to the INDEXED columns. An
    # older DB carries the unscoped `AFTER UPDATE ON messages` form, which
    # `CREATE TRIGGER IF NOT EXISTS` would silently leave in place.
    conn.execute('DROP TRIGGER IF EXISTS messages_fts_au')
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content, session_id, role ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content, session_id, role)
            VALUES('delete', old.id, old.content, old.session_id, old.role);
            INSERT INTO messages_fts(rowid, content, session_id, role)
            VALUES (new.id, new.content, new.session_id, new.role);
        END
        """
    )
    # Rebuild FTS if base has rows and FTS is empty (upgrade path).
    base_any = conn.execute('SELECT 1 FROM messages LIMIT 1').fetchone()
    if base_any is not None:
        fts_any = conn.execute('SELECT 1 FROM messages_fts LIMIT 1').fetchone()
        if fts_any is None:
            try:
                conn.execute(
                    "INSERT INTO messages_fts(messages_fts) VALUES('rebuild')"
                )
            except Exception:
                # Fallback: manual rebuild from content table
                conn.execute('DELETE FROM messages_fts')
                conn.execute(
                    """
                    INSERT INTO messages_fts(rowid, content, session_id, role)
                    SELECT id, content, session_id, role FROM messages
                    """
                )


_FTS_SYNC_MAP: tuple[tuple[str, str], ...] = (
    ('memory_store_fts', 'memory_store'),
    ('messages_fts', 'messages'),
)


def _run_migrations_safe(conn: sqlite3.Connection) -> None:
    """Run versioned migrations, swallowing errors so app still boots."""
    try:
        from app.lib.migrations import run_migrations

        run_migrations(conn)
    except Exception as exc:
        logging.warning('Migration runner failed (non-fatal): %s', exc)


def _drop_empty_legacy_heuristics(conn: sqlite3.Connection) -> None:
    """Drop learned_heuristics once it holds no rows.

    025 purged the immutable turn-lessons; any remaining rows are deletable
    from the Memory UI. Once the store drains empty there is no writer and
    no reader left, so the table goes away for good. Best-effort: a locked
    table simply survives until the next boot.
    """
    try:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='learned_heuristics' LIMIT 1"
        ).fetchone()
        if exists is None:
            return
        row = conn.execute('SELECT COUNT(*) AS c FROM learned_heuristics').fetchone()
        if row is not None and int(row['c']) == 0:
            conn.execute('DROP TABLE learned_heuristics')
            conn.commit()
            logging.info('Dropped empty legacy table learned_heuristics')
    except Exception as exc:
        logging.debug('learned_heuristics drop skipped: %s', exc)


def repair_fts_sync(conn: sqlite3.Connection) -> None:
    """Rebuild any FTS index whose docsize count diverges from its base table.

    ``count(*)`` on an external-content FTS table reads the *content* table,
    so stale index entries (left behind by pre-trigger deletes) are invisible
    to naive checks. Compare against the ``<fts>_docsize`` shadow table (one
    row per indexed document) to detect desync.

    Cost: 6 tiny count queries per boot. Self-heals any future desync.

    Takes `_SCHEMA_LOCK` for the same reason `rebuild_fts_index` does: this
    writes to the FTS vtables, and the schema application holds that lock
    while creating them. Boot-time repair racing schema creation is the same
    cross-connection interleaving that produced the FTS corruption, so it
    belongs behind the same door.
    """
    with _SCHEMA_LOCK:
        _repair_fts_sync_locked(conn)


def _repair_fts_sync_locked(conn: sqlite3.Connection) -> None:
    """Body of `repair_fts_sync`; callers must already hold `_SCHEMA_LOCK`."""
    for fts, base in _FTS_SYNC_MAP:
        try:
            idx_n = conn.execute(f'SELECT count(*) FROM {fts}_docsize').fetchone()[0]
            base_n = conn.execute(f'SELECT count(*) FROM {base}').fetchone()[0]
            if idx_n == base_n:
                continue
            logging.warning(
                'FTS desync %s: index=%s base=%s — rebuilding', fts, idx_n, base_n
            )
            conn.execute(f"INSERT INTO {fts}({fts}) VALUES('rebuild')")
            conn.commit()
        except Exception as exc:
            # Shadow table may not exist if FTS table was never created; skip.
            logging.debug('FTS repair skipped for %s: %s', fts, exc)


_SCHEMA_LOCK = threading.RLock()


_FTS_SHADOWS = ('data', 'idx', 'docsize', 'config')


def fts_index_intact(conn: sqlite3.Connection, fts: str = 'memory_store_fts') -> bool:
    """True when this FTS vtable is STRUCTURALLY whole.

    An FTS5 table is not one object: the vtable entry plus four shadow tables
    — `_data`, `_idx`, `_docsize`, `_config`. A create that was interrupted
    leaves some of them missing, and the next statement to touch the index
    then raises `vtable constructor failed`. So the presence of all five is
    the structural test — and it is a BEHAVIOURAL one, asking the database
    what exists rather than parsing what an error said.

    The names were wrong before this function existed: the rebuild had been
    dropping `memory_store_fts_content`, which is not a table FTS5 creates,
    while the real `memory_store_fts_data` was left to the vtable's own drop.
    It worked by accident, because `DROP TABLE <vtable>` takes the shadows
    with it. Both lists now name what is actually in `sqlite_master`, checked
    against a live database rather than reasoned about.

    Why this exists: `_write_with_fts_recovery` used to run a DROP-and-CREATE
    on ANY SQLite error from a `memory_store` write. A write that failed
    because the file was momentarily busy is not a corrupt index, and
    answering it with destructive DDL on a shared file — from a request path,
    on one of several connections — is how lock contention manufactures the
    very `vtable constructor failed` the recovery path existed to fix.

    Repair what is broken, not everything that touched it. If the index is
    whole, the error was something else and only the write needs retrying.

    Deliberately does NOT inspect error text. That is the mistake an earlier
    version of this path made, and it shipped a fix that passed locally and
    did nothing in CI because the same corrupt state reports a different
    message on each SQLite build.
    """
    try:
        # The vtable AND its shadows. Querying for `name = ?` alone returns
        # only the vtable row, which then fails its own shadow check on a
        # perfectly healthy index — the first version of this did exactly that.
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE name = ? OR name LIKE ? ESCAPE '\\'",
            (fts, _like_prefix(fts)),
        ).fetchall()
        if not rows:
            return False
        present = {str(r[0]) for r in rows}
        return f'{fts}_{_FTS_SHADOWS[0]}' in present and all(
            f'{fts}_{s}' in present for s in _FTS_SHADOWS
        )
    except sqlite3.Error:
        # Cannot read the schema at all: treat as not intact, which routes to
        # the rebuild. A rebuild is idempotent, so the false positive costs a
        # wasted rebuild rather than a lost write.
        return False


def _like_prefix(name: str) -> str:
    """`name` as a LIKE prefix with the wildcards in `name` itself escaped.

    A table name may legally contain `_` and `%`, both of which are LIKE
    wildcards — and `_` is in every FTS shadow name, so an unescaped prefix
    would silently match unrelated tables.
    """
    escaped = name.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    return f'{escaped}\\_%'


def rebuild_fts_index(
    conn: sqlite3.Connection, fts: str = 'memory_store_fts', base: str = 'memory_store'
) -> bool:
    """Drop and recreate one external-content FTS index from its base table.

    The escalation above ``repair_fts_sync``, which can only re-index a vtable
    that still opens. This is for the state where the vtable entry survives in
    ``sqlite_master`` but its shadow tables (``_content``, ``_idx``,
    ``_docsize``, ``_config``) are gone or inconsistent — which is what a
    partial or interrupted schema application leaves behind. Because
    ``CREATE VIRTUAL TABLE IF NOT EXISTS`` sees the surviving entry and skips
    it, the broken index is permanent for that file: every later write that
    fires the sync trigger fails, and every search silently returns nothing.

    The index is DERIVED — it can always be rebuilt from ``base`` — so
    recreating it loses nothing. Returns True when the index is usable
    afterwards.

    Trigger names are recreated too: they are what keeps the index in step
    going forward, and a fresh vtable without them would drift on the very
    next write. The ``IF NOT EXISTS`` form keeps this safe to call twice.

    The drop and the create are not split apart. Build-then-swap was tried —
    build under a temporary name, then `ALTER TABLE ... RENAME` — and it does
    not work for an external-content FTS5 table: renaming the vtable leaves
    its shadow tables (``_content``, ``_idx``, ``_docsize``, ``_config``)
    under the OLD name prefix, and FTS5 resolves them by the vtable's own
    name at open time. The result is an index that exists and is malformed.
    So this stays drop-then-create, which is the only shape SQLite supports
    for a vtable here.

    What this version does add is a bounded retry, because the failure being
    defended against is transient: on CI the ``CREATE`` itself has failed
    with ``vtable constructor failed`` while a healthy database was otherwise
    reachable. A second attempt costs one statement and turns a permanent
    outage of the index into a delay.

    THE RETRY IS NOW REMOVED, and keeping that decision on the record is the
    point. It was added on the theory that the failure was transient. It was
    not: adversarial review measured that the second attempt DOUBLES the
    destructive window — ten `DROP TABLE` statements against one file instead
    of five, and twice the log volume — and the flake then failed CI a fifth
    time with the retry in place, which settles the question empirically. A
    mitigation that doubles the blast radius and does not reduce the failure
    rate is a liability, so it is out. The lock below is the part that is
    actually justified; this is the part that was not.

    IT NOW ALSO TAKES ``_SCHEMA_LOCK``, and that is the part that matters.

    The lock was originally added around ``create_core_schema`` only — on the
    theory that a half-built vtable came from two threads applying the schema
    at once. Adversarial review showed the theory was pointed at the wrong
    function: this rebuild is the ONLY other place in the backend that runs
    ``CREATE VIRTUAL TABLE ... USING fts5`` against the brain file, it is
    reached from ``memory_store/kv.py`` on any write error, and it took no
    lock at all. Two connections — one inside ``create_core_schema``, one in
    here — reproduced ``vtable constructor failed`` 195 times in 200 rounds,
    and left a database that a FRESH connection could not open the index in
    167 of those. That is the exact CI signature this flake has produced four
    times, from a path the lock never touched.

    The two are the same resource (one vtable, one file) so they take the same
    lock. ``memory_conn`` hands each thread its own connection, so without a
    lock this is a genuine cross-connection race rather than a thread-safety
    question. The lock is re-entrant, and it is held for the whole drop/create
    window so two rebuilds cannot interleave.

    Honest status: this lock closes the interleaving the review reproduced,
    but the CI flake is NOT fixed. It has now failed five times, including
    once with this lock in place — so whatever else is reaching the brain file
    is still reaching it. What is known: the symptom is a `CREATE VIRTUAL
    TABLE` that raises `vtable constructor failed`, the writer is the memory
    store, and it only appears on the 4-vCPU CI runner, never in ~5,900 local
    test runs. What is not known: the other writer.

    IT IS NOW KNOWN, and it was not another connection at all: it was THIS
    function being called too eagerly. See `fts_index_intact` and the
    `_write_with_fts_recovery` docstring in `memory_store/kv.py`. A write that
    failed only because the file was momentarily busy was answered with five
    `DROP TABLE` statements on a shared file, from a request path. The fix is
    to rebuild only when the index is actually structurally broken.
    """
    with _SCHEMA_LOCK:
        return _rebuild_fts_index_locked(conn, fts, base)


def _rebuild_fts_index_locked(
    conn: sqlite3.Connection, fts: str = 'memory_store_fts', base: str = 'memory_store'
) -> bool:
    """Body of `rebuild_fts_index`; callers must already hold `_SCHEMA_LOCK`."""
    try:
        # The real shadow tables, named by `fts_index_intact` against a live
        # database. This used to drop `memory_store_fts_content`, which FTS5
        # never creates, so the real `_data` table survived on to collide with
        # the recreate. It worked only because dropping the vtable takes the
        # shadows with it.
        for shadow in _FTS_SHADOWS:
            conn.execute(f'DROP TABLE IF EXISTS {fts}_{shadow}')
        conn.execute(f'DROP TABLE IF EXISTS {fts}')
        conn.execute(
            f'CREATE VIRTUAL TABLE {fts} USING fts5('
            f'key, value, content=\'{base}\', content_rowid=\'rowid\')'
        )
        # Repopulate from the base table: the index is derived, so the rows
        # already stored are the source of truth and must come back.
        conn.execute(
            f'INSERT INTO {fts}(rowid, key, value) SELECT rowid, key, value FROM {base}'
        )
        conn.execute(f'CREATE TRIGGER IF NOT EXISTS {fts}_ai AFTER INSERT ON {base} BEGIN '
                     f'INSERT INTO {fts}(rowid, key, value) VALUES (new.rowid, new.key, new.value); END')
        conn.execute(f'CREATE TRIGGER IF NOT EXISTS {fts}_ad AFTER DELETE ON {base} BEGIN '
                     f'INSERT INTO {fts}({fts}, rowid, key, value) '
                     f"VALUES('delete', old.rowid, old.key, old.value); END")
        conn.execute(f'CREATE TRIGGER IF NOT EXISTS {fts}_au AFTER UPDATE ON {base} BEGIN '
                     f'INSERT INTO {fts}({fts}, rowid, key, value) '
                     f"VALUES('delete', old.rowid, old.key, old.value); "
                     f'INSERT INTO {fts}(rowid, key, value) VALUES (new.rowid, new.key, new.value); END')
        conn.commit()
        return True
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:
            pass
        _describe_rebuild_failure(conn, fts, base, exc)
        logging.warning('FTS index rebuild failed for %s: %s', fts, exc)
        return False


def _describe_rebuild_failure(
    conn: sqlite3.Connection, fts: str, base: str, exc: BaseException
) -> None:
    """Record what the file looked like when the rebuild failed.

    This exists because four separate fixes to this path were wrong, and the
    fifth attempt should not be another guess. The failure only appears on the
    CI runner, never across thousands of local tests, so the only place the
    evidence exists is a failing CI log — and the previous logs said only
    "vtable constructor failed", which does not distinguish "another
    connection dropped the vtable mid-create" from "this connection is in a
    bad transaction" from "the shadow tables are gone again".

    So on failure, write down the state that separates those. Logged at ERROR
    rather than embedded in the WARNING above so a grep for this module's
    diagnostics finds it, and deliberately cheap: this is a path that only
    runs when something has already gone wrong.

    The single most useful field is ``schema`` — it separates "the vtable
    entry survived with NO shadow tables" (the half-built state described
    above) from "entry and shadows are all present and the constructor failed
    for some other reason". Which is the question five CI failures have not
    answered.

    It is ALSO WRITTEN TO A FILE, because a log line is not enough. Round-2
    review established that `logging.error` is swallowed in CI: there is no
    `log_cli` in the pytest config, xdist gives each worker its own capture
    buffer, a record from a worker whose test PASSED is dropped at teardown,
    and `kv.py` re-raises the ORIGINAL error so the test's message is not even
    the FTS one. The flake has failed five different tests; the evidence
    exists only if the rebuild failure and the reported failure land in the
    same test's call phase on the same worker, which is not something to bet
    the diagnosis on. A file under the data dir survives worker teardown and
    can be uploaded as a CI artifact.
    """
    import threading as _threading

    detail: dict[str, object] = {'error': f'{type(exc).__name__}: {exc}'}
    try:
        # `sqlite3.Connection` has no `.database` attribute, so a previous
        # version of this always logged '?'. `db_path()` is the actual answer
        # to "is the interfering writer even on this database".
        from app.services.memory_conn import db_path

        detail['db'] = str(db_path())
    except Exception as probe_exc:
        detail['db'] = f'unavailable: {probe_exc}'
    try:
        rows = conn.execute(
            "SELECT type, name FROM sqlite_master WHERE name LIKE ?",
            (f'{fts}%',),
        ).fetchall()
        detail['schema'] = sorted(f'{r[0]}:{r[1]}' for r in rows)
    except Exception as probe_exc:
        detail['schema'] = f'unreadable: {probe_exc}'
    try:
        detail['base_table'] = bool(
            conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (base,)).fetchone()
        )
    except Exception as probe_exc:
        detail['base_table'] = f'unreadable: {probe_exc}'
    try:
        from app.services.memory_conn import connection_debug_snapshot

        detail['threads'] = connection_debug_snapshot()
    except Exception as probe_exc:
        detail['threads'] = f'unavailable: {probe_exc}'
    detail['current_thread'] = _threading.current_thread().name
    logging.error('FTS rebuild diagnostics: %s', detail)
    _write_fts_diagnostic(detail)


def _write_fts_diagnostic(detail: dict[str, object]) -> None:
    """Append the diagnostic to a file, so CI cannot swallow it.

    Best-effort: a failure to write the diagnostic must never turn an FTS
    error into a different one.
    """
    try:
        import time as _time

        from app.lib.paths import dataPath

        path = dataPath('fts-diagnostics.log')
        with path.open('a', encoding='utf-8') as fh:
            fh.write(f'{_time.time():.3f} {detail!r}\n')
    except Exception:
        pass


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Idempotently migrate camel→snake (if needed) then create the full brain schema.

    Warm path: if ``PRAGMA user_version`` already matches ``_SCHEMA_USER_VERSION``
    and core tables exist, skip heavy migration + DDL — but still apply
    lightweight column adds so upgrades pick up new session fields.
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
            # Re-apply additive column migrations (cheap IF NOT EXISTS).
            ensure_column(conn, 'usage_events', 'context_tokens', 'INTEGER DEFAULT 0')
            ensure_column(conn, 'usage_events', 'cache_hit_tokens', 'INTEGER DEFAULT 0')
            ensure_column(conn, 'usage_events', 'cache_miss_tokens', 'INTEGER DEFAULT 0')
            ensure_column(conn, 'sessions', 'workbench_blob', 'TEXT')
            ensure_column(conn, 'sessions', 'updated_at', 'TEXT')
            # 047: durable structured transcript blocks (see create_extended_tables).
            ensure_column(conn, 'messages', 'blocks_json', 'TEXT')
            # 048: client-authored message identity + its unique index.
            ensure_column(conn, 'messages', 'client_message_id', 'TEXT')
            conn.execute(
                'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id '
                'ON messages(session_id, client_message_id) '
                'WHERE client_message_id IS NOT NULL'
            )
            ensure_column(conn, 'subagent_runs', 'todos_json', "TEXT DEFAULT ''")
            ensure_column(conn, 'facts', 'expires_at', 'TEXT')
            ensure_column(conn, 'facts', 'title', "TEXT DEFAULT ''")
            ensure_column(conn, 'facts', 'kind', "TEXT DEFAULT 'fact'")
            ensure_column(conn, 'facts', 'use_count', 'INTEGER DEFAULT 0')
            ensure_column(conn, 'facts', 'last_used_at', 'TEXT')
            ensure_column(conn, 'facts', 'status', "TEXT DEFAULT 'active'")
            ensure_column(conn, 'facts', 'description', "TEXT DEFAULT ''")
            # M-2: scope axis. The ensure_column runs before
            # migration 032 on the fast path, so the migration's ALTER fails
            # (recorded, swallowed) — the index is created here to stay
            # guaranteed on legacy DBs regardless of that failure.
            ensure_column(conn, 'facts', 'scope', "TEXT DEFAULT 'global'")
            conn.execute(
                'CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope, status)'
            )
            # 055: the lineage/trust columns are ensured AFTER the migration
            # runner (see the helper's docstring) — not here, so the 055
            # .sql file is never a "duplicate column name" abort.
            ensure_column(conn, 'blackboard', 'workspace_path', "TEXT DEFAULT ''")
            ensure_column(conn, 'blackboard', 'folder_id', "TEXT DEFAULT ''")
            ensure_column(conn, 'learned_heuristics', 'confidence', 'REAL DEFAULT 0.5')
            # Per-turn TTFT + prompt-cache telemetry.
            ensure_column(conn, 'turn_outcomes', 'ttft_ms', 'INTEGER DEFAULT 0')
            ensure_column(conn, 'turn_outcomes', 'cache_hit_tokens', 'INTEGER DEFAULT 0')
            ensure_column(conn, 'turn_outcomes', 'cache_miss_tokens', 'INTEGER DEFAULT 0')
            # P3.1: early-dispatch measurement — trailing
            # stream tail after the last tool call's arguments arrived.
            ensure_column(
                conn, 'turn_outcomes', 'tool_args_ready_to_stream_end_ms', 'INTEGER DEFAULT 0'
            )
            _ensure_messages_fts(conn)
            repair_fts_sync(conn)
            _run_migrations_safe(conn)
            # 055: the guarantee. The .sql migration owns the columns on a
            # normal boot; this fills the gap when that migration was
            # blacklisted, and it runs AFTER the runner so the migration
            # itself never hits a "duplicate column name" abort (which
            # would skip the REST of its statements).
            _ensure_fact_signal_columns(conn)
            _ensure_fact_scope_key(conn)
            _drop_empty_legacy_heuristics(conn)
            conn.commit()
            return
    migrate_camel_to_snake(conn)
    create_core_schema(conn)
    create_extended_tables(conn)
    _ensure_messages_fts(conn)
    repair_fts_sync(conn)
    _run_migrations_safe(conn)
    # 055: after the runner, for the same reason as the warm path above.
    _ensure_fact_signal_columns(conn)
    _ensure_fact_scope_key(conn)
    _drop_empty_legacy_heuristics(conn)
    conn.execute(f'PRAGMA user_version={_SCHEMA_USER_VERSION}')
    conn.commit()
