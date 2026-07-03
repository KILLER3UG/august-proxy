#!/usr/bin/env python3
"""
SQLite column migration: snake_case → camelCase.

Creates a backup and renames all columns in the August brain database.

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
        ("key", "key"),
        ("value", "value"),
        ("updated_at", "updatedAt"),
    ],
    "facts": [
        ("id", "id"),
        ("fact_key", "factKey"),
        ("fact_value", "factValue"),
        ("category", "category"),
        ("source", "source"),
        ("confidence", "confidence"),
        ("created_at", "createdAt"),
        ("updated_at", "updatedAt"),
    ],
    "proposals": [
        ("id", "id"),
        ("session_id", "sessionId"),
        ("proposal_type", "proposalType"),
        ("content", "content"),
        ("status", "status"),
        ("created_at", "createdAt"),
        ("decided_at", "decidedAt"),
        ("decided_by", "decidedBy"),
    ],
    "lifecycle": [
        ("id", "id"),
        ("session_id", "sessionId"),
        ("event_type", "eventType"),
        ("detail", "detail"),
        ("created_at", "createdAt"),
    ],
    "session_topics": [
        ("session_id", "sessionId"),
        ("topic", "topic"),
        ("parent_topic", "parentTopic"),
        ("confidence", "confidence"),
        ("classified_at", "classifiedAt"),
    ],
    "sessions": [
        ("id", "id"),
        ("title", "title"),
        ("started_at", "startedAt"),
        ("message_count", "messageCount"),
        ("provider", "provider"),
        ("model", "model"),
        ("folder_id", "folderId"),
        ("is_archived", "isArchived"),
        ("workspace_path", "workspacePath"),
    ],
    "messages": [
        ("id", "id"),
        ("session_id", "sessionId"),
        ("role", "role"),
        ("content", "content"),
        ("created_at", "createdAt"),
    ],
    "usage_events": [
        ("id", "id"),
        ("session_id", "sessionId"),
        ("model", "model"),
        ("input_tokens", "inputTokens"),
        ("output_tokens", "outputTokens"),
        ("context_tokens", "contextTokens"),
        ("created_at", "createdAt"),
    ],
    "config_audit": [
        ("id", "id"),
        ("category", "category"),
        ("action", "action"),
        ("actor", "actor"),
        ("before_json", "beforeJson"),
        ("after_json", "afterJson"),
        ("created_at", "createdAt"),
    ],
    "learned_heuristics": [
        ("id", "id"),
        ("rule", "rule"),
        ("source", "source"),
        ("category", "category"),
        ("created_at", "createdAt"),
        ("updated_at", "updatedAt"),
    ],
    "auto_memories": [
        ("id", "id"),
        ("key", "key"),
        ("content", "content"),
        ("category", "category"),
        ("importance", "importance"),
        ("source", "source"),
        ("created_at", "createdAt"),
        ("updated_at", "updatedAt"),
    ],
    "episodic_timeline": [
        ("id", "id"),
        ("timestamp", "timestamp"),
        ("session_id", "sessionId"),
        ("event_summary", "eventSummary"),
        ("category", "category"),
    ],
    "blackboard": [
        ("id", "id"),
        ("session_id", "sessionId"),
        ("agent", "agent"),
        ("key", "key"),
        ("value", "value"),
        ("priority", "priority"),
        ("created_at", "createdAt"),
        ("expires_at", "expiresAt"),
    ],
    "exams": [
        ("id", "id"),
        ("title", "title"),
        ("topic", "topic"),
        ("created_at", "createdAt"),
        ("source", "source"),
        ("source_files", "sourceFiles"),
    ],
    "exam_questions": [
        ("id", "id"),
        ("exam_id", "examId"),
        ("position", "position"),
        ("stem", "stem"),
        ("options", "options"),
        ("correct_index", "correctIndex"),
        ("rationale", "rationale"),
        ("source_snippet", "sourceSnippet"),
        ("origin", "origin"),
    ],
    "exam_attempts": [
        ("id", "id"),
        ("exam_id", "examId"),
        ("question_id", "questionId"),
        ("selected_index", "selectedIndex"),
        ("is_correct", "isCorrect"),
        ("asked_for_help", "askedForHelp"),
        ("answered_at", "answeredAt"),
    ],
    "pending_skills": [
        ("id", "id"),
        ("name", "name"),
        ("description", "description"),
        ("trigger_text", "triggerText"),
        ("draft_path", "draftPath"),
        ("source_session_id", "sourceSessionId"),
        ("source_workflow", "sourceWorkflow"),
    ],
}


def findDbPath() -> Path:
    envPath = Path(__file__).resolve().parent.parent / "data" / "august_brain.sqlite"
    return envPath


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
    totalRenames = 0

    try:
        existingTables = [row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()]

        for tableName, columns in COLUMN_MAP.items():
            if tableName not in existingTables:
                print(f"  Table '{tableName}' not found — skipping")
                continue

            for oldName, newName in columns:
                if oldName == newName:
                    continue

                pragma = conn.execute(f"PRAGMA table_info({tableName})").fetchall()
                colNames = [row[1] for row in pragma]
                if oldName not in colNames:
                    print(f"    Column '{oldName}' not found in '{tableName}' -- skipping")
                    continue
                if newName in colNames:
                    print(f"    Column '{newName}' already exists in '{tableName}' -- skipping")
                    continue

                if dryRun:
                    print(f"  [DRY-RUN] {tableName}: {oldName} -> {newName}")
                else:
                    conn.execute(f"ALTER TABLE {tableName} RENAME COLUMN {oldName} TO {newName}")
                    print(f"  {tableName}: {oldName} -> {newName}")
                totalRenames += 1

        if not dryRun:
            conn.commit()
            print("\nVerification:")
            for tableName in existingTables:
                pragma = conn.execute(f"PRAGMA table_info({tableName})").fetchall()
                colList = ", ".join(f"{row[1]}" for row in pragma)
                print(f"  {tableName}: {colList}")

    finally:
        conn.close()

    return totalRenames


def main():
    parser = argparse.ArgumentParser(description="Migrate SQLite columns from snake_case to camelCase")
    parser.add_argument("--db", help="Path to SQLite database (default: data/august_brain.sqlite)")
    parser.add_argument("--dry-run", action="store_true", dest="dryRun", help="Preview changes without modifying")
    args = parser.parse_args()

    dbPath = Path(args.db) if args.db else findDbPath()
    print(f"Database: {dbPath}")

    total = migrateDatabase(dbPath, dryRun=args.dryRun)
    print(f"\nTotal columns renamed: {total}")


if __name__ == "__main__":
    main()
