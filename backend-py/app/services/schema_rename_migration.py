"""
Idempotent camelCase → snake_case SQLite schema migration for the brain DB.

Inverts ``scripts/migrateDbColumns.py`` maps (which went snake → camel).
Called from ``memory_schema.ensure_schema`` **before** CREATE TABLE IF NOT EXISTS
so fresh DBs skip this path and only hit snake_case DDL.

Safety:
  * Detects camelCase tables (e.g. ``memoryStore``) via sqlite_master
  * Drops FTS content-sync tables/triggers before renaming content tables
  * Uses busy_timeout / WAL like ``memory_store._conn``
  * No-op when schema is already snake_case
  * When **both** camel and snake tables exist: merge missing camel rows into
    snake (never overwrite conflicting snake rows). Camel tables are **not**
    dropped here — that is a separate confirmation step
    (``drop_legacy_camel_tables``).
"""

from __future__ import annotations

import logging
import sqlite3
from typing import Any

logger = logging.getLogger(__name__)

# Natural key per camel table for dual-table merge identity.
# Prefer logical keys over autoincrement ids when both sides may have
# independently allocated the same integer for different rows.
_MERGE_KEY_COLS: dict[str, tuple[str, ...]] = {
    'memoryStore': ('key',),
    'sessionTopics': ('session_id',),
    'usageEvents': ('id',),
    'configAudit': ('id',),
    'learnedHeuristics': ('id',),
    'autoMemories': ('id',),
    'episodicTimeline': ('id',),
    'examQuestions': ('id',),
    'examAttempts': ('id',),
    'pendingSkills': ('id',),
}
# Secondary logical key used when id conflicts but content differs (auto_memories).
_MERGE_ALT_KEY: dict[str, tuple[str, ...]] = {
    'autoMemories': ('key',),
}

# camelCase table → snake_case (inverse of migrateDbColumns.TABLE_MAP + full plan inventory)
TABLE_MAP: dict[str, str] = {
    'memoryStore': 'memory_store',
    'sessionTopics': 'session_topics',
    'usageEvents': 'usage_events',
    'configAudit': 'config_audit',
    'learnedHeuristics': 'learned_heuristics',
    'autoMemories': 'auto_memories',
    'episodicTimeline': 'episodic_timeline',
    'examQuestions': 'exam_questions',
    'examAttempts': 'exam_attempts',
    'pendingSkills': 'pending_skills',
}

# Per current (camel) table name: (camelColumn → snakeColumn)
COLUMN_MAP: dict[str, list[tuple[str, str]]] = {
    'memoryStore': [('updatedAt', 'updated_at')],
    'facts': [
        ('factKey', 'fact_key'),
        ('factValue', 'fact_value'),
        ('createdAt', 'created_at'),
        ('updatedAt', 'updated_at'),
    ],
    'proposals': [
        ('sessionId', 'session_id'),
        ('proposalType', 'proposal_type'),
        ('createdAt', 'created_at'),
        ('decidedAt', 'decided_at'),
        ('decidedBy', 'decided_by'),
    ],
    'lifecycle': [
        ('sessionId', 'session_id'),
        ('eventType', 'event_type'),
        ('createdAt', 'created_at'),
    ],
    'sessionTopics': [
        ('sessionId', 'session_id'),
        ('parentTopic', 'parent_topic'),
        ('classifiedAt', 'classified_at'),
    ],
    'sessions': [
        ('startedAt', 'started_at'),
        ('messageCount', 'message_count'),
        ('folderId', 'folder_id'),
        ('isArchived', 'is_archived'),
        ('workspacePath', 'workspace_path'),
    ],
    'messages': [
        ('sessionId', 'session_id'),
        ('createdAt', 'created_at'),
    ],
    'usageEvents': [
        ('sessionId', 'session_id'),
        ('inputTokens', 'input_tokens'),
        ('outputTokens', 'output_tokens'),
        ('contextTokens', 'context_tokens'),
        ('createdAt', 'created_at'),
    ],
    'configAudit': [
        ('beforeJson', 'before_json'),
        ('afterJson', 'after_json'),
        ('createdAt', 'created_at'),
    ],
    'learnedHeuristics': [
        ('createdAt', 'created_at'),
        ('updatedAt', 'updated_at'),
    ],
    'autoMemories': [
        ('createdAt', 'created_at'),
        ('updatedAt', 'updated_at'),
    ],
    'episodicTimeline': [
        ('sessionId', 'session_id'),
        ('eventSummary', 'event_summary'),
    ],
    'blackboard': [
        ('sessionId', 'session_id'),
        ('createdAt', 'created_at'),
        ('expiresAt', 'expires_at'),
    ],
    'exams': [
        ('createdAt', 'created_at'),
        ('sourceFiles', 'source_files'),
    ],
    'examQuestions': [
        ('examId', 'exam_id'),
        ('correctIndex', 'correct_index'),
        ('sourceSnippet', 'source_snippet'),
    ],
    'examAttempts': [
        ('examId', 'exam_id'),
        ('questionId', 'question_id'),
        ('selectedIndex', 'selected_index'),
        ('isCorrect', 'is_correct'),
        ('askedForHelp', 'asked_for_help'),
        ('answeredAt', 'answered_at'),
    ],
    'pendingSkills': [
        ('triggerText', 'trigger_text'),
        ('draftPath', 'draft_path'),
        ('sourceSessionId', 'source_session_id'),
        ('sourceWorkflow', 'source_workflow'),
        ('createdBy', 'created_by'),
        ('createdAt', 'created_at'),
        ('useCount', 'use_count'),
        ('lastSurfacedAt', 'last_surfaced_at'),
    ],
}

# Also rename columns when tables are already snake-named but columns still camel
# (partial migration / mixed history). Keys are snake table names.
_SNAKE_TABLE_COLUMN_MAP: dict[str, list[tuple[str, str]]] = {
    'memory_store': COLUMN_MAP['memoryStore'],
    'facts': COLUMN_MAP['facts'],
    'proposals': COLUMN_MAP['proposals'],
    'lifecycle': COLUMN_MAP['lifecycle'],
    'session_topics': COLUMN_MAP['sessionTopics'],
    'sessions': COLUMN_MAP['sessions'],
    'messages': COLUMN_MAP['messages'],
    'usage_events': COLUMN_MAP['usageEvents'],
    'config_audit': COLUMN_MAP['configAudit'],
    'learned_heuristics': COLUMN_MAP['learnedHeuristics'],
    'auto_memories': COLUMN_MAP['autoMemories'],
    'episodic_timeline': COLUMN_MAP['episodicTimeline'],
    'blackboard': COLUMN_MAP['blackboard'],
    'exams': COLUMN_MAP['exams'],
    'exam_questions': COLUMN_MAP['examQuestions'],
    'exam_attempts': COLUMN_MAP['examAttempts'],
    'pending_skills': COLUMN_MAP['pendingSkills'],
}

_FTS_CONTENT_TABLES_CAMEL = ('memoryStore', 'autoMemories')

# Legacy camelCase index names → drop so ensure_schema recreates snake-named ones
_LEGACY_INDEXES = (
    'idx_configAudit_category',
    'idx_configAudit_created',
    'idx_usageEvents_session',
    'idx_usageEvents_created',
    'idx_examAttempts_exam',
)


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def _needs_migration(conn: sqlite3.Connection) -> bool:
    """True if any camelCase table name from TABLE_MAP still exists."""
    for camel in TABLE_MAP:
        if _table_exists(conn, camel):
            return True
    # Or snake tables with residual camel columns
    for table, columns in _SNAKE_TABLE_COLUMN_MAP.items():
        if not _table_exists(conn, table):
            continue
        col_names = {row[1] for row in conn.execute(f'PRAGMA table_info({table})').fetchall()}
        for camel_col, _snake in columns:
            if camel_col in col_names:
                return True
    return False


def _drop_fts_for_content_table(conn: sqlite3.Connection, content_table: str) -> None:
    """Drop FTS virtual table and content-sync triggers for a content table."""
    fts_name = f'{content_table}_fts'
    # Triggers may be named {table}_fts_* or {table}_* (autoMemories_ai style)
    triggers = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND (tbl_name=? OR name LIKE ?)",
        (content_table, f'{content_table}%'),
    ).fetchall()
    for (t_name,) in triggers:
        conn.execute(f'DROP TRIGGER IF EXISTS "{t_name}"')
        logger.info('Dropped FTS trigger %s', t_name)
    if _table_exists(conn, fts_name):
        conn.execute(f'DROP TABLE IF EXISTS "{fts_name}"')
        logger.info('Dropped FTS table %s', fts_name)
    # Shadow FTS internals (fts5 content tables sometimes leave artifacts)
    for suffix in ('_data', '_idx', '_content', '_docsize', '_config'):
        shadow = f'{fts_name}{suffix}'
        if _table_exists(conn, shadow):
            try:
                conn.execute(f'DROP TABLE IF EXISTS "{shadow}"')
            except sqlite3.OperationalError:
                pass


def _rename_columns_on_table(
    conn: sqlite3.Connection, table: str, columns: list[tuple[str, str]]
) -> int:
    total = 0
    if not _table_exists(conn, table):
        return 0
    col_names = {row[1] for row in conn.execute(f'PRAGMA table_info({table})').fetchall()}
    for old_name, new_name in columns:
        if old_name not in col_names:
            continue
        if new_name in col_names:
            continue
        conn.execute(f'ALTER TABLE "{table}" RENAME COLUMN "{old_name}" TO "{new_name}"')
        logger.info('%s: %s → %s', table, old_name, new_name)
        total += 1
        col_names.discard(old_name)
        col_names.add(new_name)
    return total


def migrate_camel_to_snake(conn: sqlite3.Connection) -> int:
    """Rename camelCase tables/columns to snake_case. Idempotent. Returns change count."""
    # Match memory_store connection safety for concurrent writers
    try:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA busy_timeout=10000')
    except sqlite3.Error:
        pass

    if not _needs_migration(conn):
        return 0

    total = 0
    logger.info('Brain schema migration: camelCase → snake_case starting')

    # 1) Drop FTS on camel content tables before column/table renames
    for content in _FTS_CONTENT_TABLES_CAMEL:
        if _table_exists(conn, content):
            _drop_fts_for_content_table(conn, content)

    # Also drop FTS if somehow content table is already snake but FTS still camel
    for camel, snake in (('memoryStore', 'memory_store'), ('autoMemories', 'auto_memories')):
        if _table_exists(conn, snake) and _table_exists(conn, f'{camel}_fts'):
            _drop_fts_for_content_table(conn, camel)

    # 2) Rename columns on camel-named tables (while table names still match COLUMN_MAP keys)
    for table, columns in COLUMN_MAP.items():
        total += _rename_columns_on_table(conn, table, columns)

    # 3) Rename tables camel → snake, or merge when both already exist
    for camel, snake in TABLE_MAP.items():
        if not _table_exists(conn, camel):
            continue
        if _table_exists(conn, snake):
            merged = _merge_camel_into_snake(conn, camel, snake)
            if merged:
                logger.info(
                    "Merged %s camel-only row(s) from '%s' into '%s' (camel table retained)",
                    merged,
                    camel,
                    snake,
                )
            total += merged
            continue
        conn.execute(f'ALTER TABLE "{camel}" RENAME TO "{snake}"')
        logger.info('%s → %s', camel, snake)
        total += 1

    # 4) Rename residual camel columns on snake tables
    for table, columns in _SNAKE_TABLE_COLUMN_MAP.items():
        total += _rename_columns_on_table(conn, table, columns)

    # 5) Drop legacy camelCase index names (ensure_schema recreates snake indexes)
    for idx in _LEGACY_INDEXES:
        try:
            conn.execute(f'DROP INDEX IF EXISTS "{idx}"')
        except sqlite3.OperationalError:
            pass

    # Drop orphaned camel FTS names if any remain (not content tables)
    for fts in ('memoryStore_fts', 'autoMemories_fts'):
        if _table_exists(conn, fts):
            try:
                conn.execute(f'DROP TABLE IF EXISTS "{fts}"')
            except sqlite3.OperationalError:
                pass

    conn.commit()
    # Rebuild FTS after merge inserts (content tables may have grown)
    _rebuild_snake_fts(conn)
    logger.info('Brain schema migration complete (%s changes)', total)
    return total


def _col_names(conn: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in conn.execute(f'PRAGMA table_info("{table}")').fetchall()]


def _merge_camel_into_snake(conn: sqlite3.Connection, camel: str, snake: str) -> int:
    """Copy camel-only rows into snake. Never overwrite conflicting snake rows.

    Returns number of rows inserted. Does not drop ``camel``.
    """
    key_cols = _MERGE_KEY_COLS.get(camel, ('id',))
    camel_cols = _col_names(conn, camel)
    snake_cols = _col_names(conn, snake)
    shared = [c for c in snake_cols if c in camel_cols]
    if not all(k in shared for k in key_cols):
        logger.warning('Cannot merge %s → %s: key cols %s missing from shared', camel, snake, key_cols)
        return 0

    camel_rows = conn.execute(f'SELECT * FROM "{camel}"').fetchall()
    snake_rows = conn.execute(f'SELECT * FROM "{snake}"').fetchall()
    snake_by_key: dict[tuple[Any, ...], dict[str, Any]] = {}
    for r in snake_rows:
        d = {c: r[i] for i, c in enumerate(snake_cols)}
        snake_by_key[tuple(d.get(k) for k in key_cols)] = d

    # For alt-key tables, also index snake by logical key
    alt = _MERGE_ALT_KEY.get(camel)
    snake_by_alt: dict[tuple[Any, ...], dict[str, Any]] = {}
    if alt and all(a in snake_cols for a in alt):
        for r in snake_rows:
            d = {c: r[i] for i, c in enumerate(snake_cols)}
            ak = tuple(d.get(a) for a in alt)
            if ak[0] not in (None, ''):
                snake_by_alt[ak] = d

    inserted = 0
    for r in camel_rows:
        d = {c: r[i] for i, c in enumerate(camel_cols)}
        k = tuple(d.get(c) for c in key_cols)
        if k in snake_by_key:
            # Same primary key — if payload differs, keep snake; if alt key differs
            # (id collision with different logical identity), re-insert without id.
            snake_d = snake_by_key[k]
            payload_cols = [c for c in shared if c not in key_cols]
            if all(snake_d.get(c) == d.get(c) for c in payload_cols):
                continue  # identical
            if alt and all(a in shared for a in alt):
                camel_alt = tuple(d.get(a) for a in alt)
                snake_alt = tuple(snake_d.get(a) for a in alt)
                if camel_alt != snake_alt and camel_alt[0] not in (None, ''):
                    if camel_alt in snake_by_alt:
                        continue  # already present under logical key
                    # Insert as new row without forcing conflicting id
                    cols = [c for c in shared if c != 'id' and c in d]
                    placeholders = ', '.join('?' for _ in cols)
                    col_list = ', '.join(f'"{c}"' for c in cols)
                    conn.execute(
                        f'INSERT INTO "{snake}" ({col_list}) VALUES ({placeholders})',
                        [d[c] for c in cols],
                    )
                    inserted += 1
                    logger.info(
                        '%s: id collision key=%s — inserted camel logical key %s without id',
                        snake,
                        k,
                        camel_alt,
                    )
                    continue
            logger.warning(
                '%s: conflict on key %s — keeping snake row, not overwriting from camel',
                snake,
                k,
            )
            continue

        # Missing primary key on snake — insert (preserve id when possible)
        if alt and all(a in shared for a in alt):
            camel_alt = tuple(d.get(a) for a in alt)
            if camel_alt[0] not in (None, '') and camel_alt in snake_by_alt:
                continue  # already present by logical key under another id

        cols = [c for c in shared if c in d]
        placeholders = ', '.join('?' for _ in cols)
        col_list = ', '.join(f'"{c}"' for c in cols)
        try:
            conn.execute(
                f'INSERT INTO "{snake}" ({col_list}) VALUES ({placeholders})',
                [d[c] for c in cols],
            )
            inserted += 1
        except sqlite3.IntegrityError as exc:
            logger.warning('%s insert from camel key=%s failed: %s', snake, k, exc)

    return inserted


def _rebuild_snake_fts(conn: sqlite3.Connection) -> None:
    for fts in ('memory_store_fts', 'auto_memories_fts'):
        if not _table_exists(conn, fts):
            continue
        try:
            conn.execute(f"INSERT INTO {fts}({fts}) VALUES('rebuild')")
            conn.commit()
        except sqlite3.Error as exc:
            logger.warning('FTS rebuild %s failed: %s', fts, exc)


def drop_legacy_camel_tables(conn: sqlite3.Connection, *, confirm: bool = False) -> int:
    """Drop leftover camelCase content tables after merge verification.

    Requires ``confirm=True``. Does not run from ``ensure_schema`` automatically.
    """
    if not confirm:
        raise ValueError('drop_legacy_camel_tables requires confirm=True')
    dropped = 0
    for camel in TABLE_MAP:
        if not _table_exists(conn, camel):
            continue
        # Refuse if snake twin missing
        snake = TABLE_MAP[camel]
        if not _table_exists(conn, snake):
            logger.error('Refusing to drop %s — snake twin %s missing', camel, snake)
            continue
        conn.execute(f'DROP TABLE IF EXISTS "{camel}"')
        logger.info('Dropped legacy camel table %s', camel)
        dropped += 1
    conn.commit()
    return dropped
