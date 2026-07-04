#!/usr/bin/env python3
"""
SQLite schema migration: snake_case → camelCase for both columns and table names.

Creates a backup, renames all columns, drops FTS virtual tables for content
tables being renamed, renames tables, and lets the app recreate FTS on startup.

Usage:
    python scripts/migrate_db_columns.py                           # use default path
    python scripts/migrate_db_columns.py --db path/to/brain.sqlite # explicit path
    python scripts/migrate_db_columns.py --dry-run                 # preview only
"""

import argparse
import sqlite3
import shutil
import sys
from pathlib import Path


COLUMN_MAP: dict[str, list[tuple[str, str]]] = {
    "memory_store": [
        ("updated_at", "updatedAt"),
    ],
    "facts": [
        ("fact_key", "factKey"),
        ("fact_value", "factValue"),
        ("created_at", "createdAt"),
        ("updated_at", "updatedAt"),
    ],
    "proposals": [
        ("session_id", "sessionId"),
        ("proposal_type", "proposalType"),
        ("created_at", "createdAt"),
        ("decided_at", "decidedAt"),
        ("decided_by", "decidedBy"),
    ],
    "lifecycle": [
        ("session_id", "sessionId"),
        ("event_type", "eventType"),
        ("created_at", "createdAt"),
    ],
    "session_topics": [
        ("session_id", "sessionId"),
        ("parent_topic", "parentTopic"),
        ("classified_at", "classifiedAt"),
    ],
    "sessions": [
        ("started_at", "startedAt"),
        ("message_count", "messageCount"),
        ("folder_id", "folderId"),
        ("is_archived", "isArchived"),
        ("workspace_path", "workspacePath"),
    ],
    "messages": [
        ("session_id", "sessionId"),
        ("created_at", "createdAt"),
    ],
    "usage_events": [
        ("session_id", "sessionId"),
        ("input_tokens", "inputTokens"),
        ("output_tokens", "outputTokens"),
        ("context_tokens", "contextTokens"),
        ("created_at", "createdAt"),
    ],
    "config_audit": [
        ("before_json", "beforeJson"),
        ("after_json", "afterJson"),
        ("created_at", "createdAt"),
    ],
    "learned_heuristics": [
        ("created_at", "createdAt"),
        ("updated_at", "updatedAt"),
    ],
    "auto_memories": [
        ("created_at", "createdAt"),
        ("updated_at", "updatedAt"),
    ],
    "episodic_timeline": [
        ("session_id", "sessionId"),
        ("event_summary", "eventSummary"),
    ],
    "blackboard": [
        ("session_id", "sessionId"),
        ("created_at", "createdAt"),
        ("expires_at", "expiresAt"),
    ],
    "exams": [
        ("created_at", "createdAt"),
        ("source_files", "sourceFiles"),
    ],
    "exam_questions": [
        ("exam_id", "examId"),
        ("correct_index", "correctIndex"),
        ("source_snippet", "sourceSnippet"),
    ],
    "exam_attempts": [
        ("exam_id", "examId"),
        ("question_id", "questionId"),
        ("selected_index", "selectedIndex"),
        ("is_correct", "isCorrect"),
        ("asked_for_help", "askedForHelp"),
        ("answered_at", "answeredAt"),
    ],
    "pending_skills": [
        ("trigger_text", "triggerText"),
        ("draft_path", "draftPath"),
        ("source_session_id", "sourceSessionId"),
        ("source_workflow", "sourceWorkflow"),
    ],
}

# Tables that need renaming (only those with actual snake_case names)
TABLE_MAP: dict[str, str] = {
    "memory_store": "memoryStore",
    "session_topics": "sessionTopics",
    "usage_events": "usageEvents",
    "config_audit": "configAudit",
    "learned_heuristics": "learnedHeuristics",
    "auto_memories": "autoMemories",
    "episodic_timeline": "episodicTimeline",
    "exam_questions": "examQuestions",
    "exam_attempts": "examAttempts",
    "pending_skills": "pendingSkills",
}

# Tables that have FTS virtual tables pointing to them
_FTSContentTables = {"memory_store", "auto_memories"}


def findDbPath() -> Path:
    envPath = Path(__file__).resolve().parent.parent / "data" / "august_brain.sqlite"
    return envPath


def _tableExists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,)
    ).fetchone()
    return row is not None


def _dropFtsTable(conn: sqlite3.Connection, contentTable: str, *, dryRun: bool) -> None:
    """Drop FTS virtual table and its content-sync triggers for a content table."""
    ftsName = f"{contentTable}_fts"
    if not _tableExists(conn, ftsName):
        return

    # Drop triggers on the content table that sync to the FTS table
    triggers = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?",
        (contentTable,)
    ).fetchall()
    for (tName,) in triggers:
        if dryRun:
            print(f"  [DRY-RUN] DROP TRIGGER {tName}")
        else:
            conn.execute(f"DROP TRIGGER IF EXISTS {tName}")
            print(f"  Dropped trigger {tName}")

    # Drop the FTS virtual table itself
    if dryRun:
        print(f"  [DRY-RUN] DROP TABLE {ftsName}")
    else:
        conn.execute(f"DROP TABLE IF EXISTS {ftsName}")
        print(f"  Dropped FTS table {ftsName}")


def _renameColumns(conn: sqlite3.Connection, *, dryRun: bool) -> int:
    total = 0
    existingTables = [row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()]

    for tableName, columns in COLUMN_MAP.items():
        if tableName not in existingTables:
            print(f"  Table '{tableName}' not found -- skipping")
            continue

        for oldName, newName in columns:
            if oldName == newName:
                continue

            pragma = conn.execute(f"PRAGMA table_info({tableName})").fetchall()
            colNames = [row[1] for row in pragma]
            if oldName not in colNames:
                # print(f"    Column '{oldName}' not found in '{tableName}' -- skipping")
                continue
            if newName in colNames:
                print(f"    Column '{newName}' already exists in '{tableName}' -- skipping")
                continue

            if dryRun:
                print(f"  [DRY-RUN] {tableName}: {oldName} -> {newName}")
            else:
                conn.execute(f"ALTER TABLE {tableName} RENAME COLUMN {oldName} TO {newName}")
                print(f"  {tableName}: {oldName} -> {newName}")
            total += 1

    return total


def _renameTables(conn: sqlite3.Connection, *, dryRun: bool) -> int:
    total = 0
    for oldName, newName in TABLE_MAP.items():
        if not _tableExists(conn, oldName):
            print(f"  Table '{oldName}' not found -- skipping")
            continue
        if _tableExists(conn, newName):
            print(f"  Table '{newName}' already exists -- skipping")
            continue

        if dryRun:
            print(f"  [DRY-RUN] ALTER TABLE {oldName} RENAME TO {newName}")
        else:
            conn.execute(f"ALTER TABLE {oldName} RENAME TO {newName}")
            print(f"  {oldName} -> {newName}")
        total += 1

    return total


def migrateDatabase(dbPath: Path, *, dryRun: bool = False) -> int:
    if not dbPath.exists():
        print(f"Database not found: {dbPath}")
        return 0

    if not dryRun:
        backupPath = dbPath.with_suffix(dbPath.suffix + ".bak")
        if not backupPath.exists():
            shutil.copy2(dbPath, backupPath)
            print(f"Backup created: {backupPath}")
        else:
            print(f"Backup already exists: {backupPath}")

    conn = sqlite3.connect(str(dbPath))
    totalChanges = 0

    try:
        # Step 1: Rename columns (uses old table names)
        print("\n--- Renaming columns ---")
        totalChanges += _renameColumns(conn, dryRun=dryRun)

        # Step 2: Drop FTS virtual tables + triggers for content tables being renamed
        print("\n--- Dropping FTS tables for renamed content tables ---")
        for oldName in TABLE_MAP:
            if oldName in _FTSContentTables:
                _dropFtsTable(conn, oldName, dryRun=dryRun)

        # Step 3: Rename tables
        print("\n--- Renaming tables ---")
        totalChanges += _renameTables(conn, dryRun=dryRun)

        if not dryRun:
            conn.commit()
            print("\n--- Verification ---")
            tables = [row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()]
            for tName in tables:
                pragma = conn.execute(f"PRAGMA table_info({tName})").fetchall()
                colList = ", ".join(f"{row[1]}" for row in pragma)
                print(f"  {tName}: {colList}")

    finally:
        conn.close()

    return totalChanges


def main():
    parser = argparse.ArgumentParser(description="Migrate SQLite schema from snake_case to camelCase (columns + table names)")
    parser.add_argument("--db", help="Path to SQLite database (default: data/august_brain.sqlite)")
    parser.add_argument("--dry-run", action="store_true", dest="dryRun", help="Preview changes without modifying")
    args = parser.parse_args()

    dbPath = Path(args.db) if args.db else findDbPath()
    print(f"Database: {dbPath}")

    total = migrateDatabase(dbPath, dryRun=args.dryRun)
    print(f"\nTotal schema changes applied: {total}")
    print("FTS virtual tables will be recreated automatically on next app startup.")


if __name__ == "__main__":
    main()