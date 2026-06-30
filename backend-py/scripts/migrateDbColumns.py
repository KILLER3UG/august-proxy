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


def find_db_path() -> Path:
    env_path = Path(__file__).resolve().parent.parent / "data" / "august_brain.sqlite"
    return env_path


def migrate_database(db_path: Path, *, dry_run: bool = False) -> int:
    if not db_path.exists():
        print(f"Database not found: {db_path}")
        return 0

    if not dry_run:
        backup_path = db_path.with_suffix(db_path.suffix + ".bak")
        if not backup_path.exists():
            shutil.copy2(db_path, backup_path)
            print(f"Backup created: {backup_path}")
        else:
            print(f"Backup already exists: {backup_path}")

    conn = sqlite3.connect(str(db_path))
    total_renames = 0

    try:
        existing_tables = [row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()]

        for table_name, columns in COLUMN_MAP.items():
            if table_name not in existing_tables:
                print(f"  Table '{table_name}' not found — skipping")
                continue

            for old_name, new_name in columns:
                if old_name == new_name:
                    continue

                pragma = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
                col_names = [row[1] for row in pragma]
                if old_name not in col_names:
                    print(f"    Column '{old_name}' not found in '{table_name}' — skipping")
                    continue
                if new_name in col_names:
                    print(f"    Column '{new_name}' already exists in '{table_name}' — skipping")
                    continue

                if dry_run:
                    print(f"  [DRY-RUN] {table_name}: {old_name} → {new_name}")
                else:
                    conn.execute(f"ALTER TABLE {table_name} RENAME COLUMN {old_name} TO {new_name}")
                    print(f"  {table_name}: {old_name} → {new_name}")
                total_renames += 1

        if not dry_run:
            conn.commit()
            print("\nVerification:")
            for table_name in existing_tables:
                pragma = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
                col_list = ", ".join(f"{row[1]}" for row in pragma)
                print(f"  {table_name}: {col_list}")

    finally:
        conn.close()

    return total_renames


def main():
    parser = argparse.ArgumentParser(description="Migrate SQLite columns from snake_case to camelCase")
    parser.add_argument("--db", help="Path to SQLite database (default: data/august_brain.sqlite)")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without modifying")
    args = parser.parse_args()

    db_path = Path(args.db) if args.db else find_db_path()
    print(f"Database: {db_path}")

    total = migrate_database(db_path, dry_run=args.dry_run)
    print(f"\nTotal columns renamed: {total}")


if __name__ == "__main__":
    main()
