"""
One-time migration: split old auto_memories JSON blob into individual FTS-indexed rows.

The original auto_memory.py stored all entries as a single JSON array under the
key "autoMemories" in the memory_store table. This script:
1. Reads that blob
2. Inserts each entry as an individual row in the auto_memories table
   (FTS triggers automatically index them)
3. Deletes the orphaned blob from memory_store

Usage:
    python scripts/migrate_auto_memories.py [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any


def _db_path() -> Path:
    envPath = __import__('os').environ.get('AUGUST_BRAIN_SQLITE_FILE')
    if envPath:
        return Path(envPath)
    from app.lib.paths import dataPath

    return dataPath('august_brain.sqlite')


def _connect() -> sqlite3.Connection:
    db = _db_path()
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


def _normalizeIso(ts: str | None) -> str:
    if not ts:
        return datetime.utcnow().isoformat()
    return ts.replace('Z', '').split('+')[0].split('.')[0] or datetime.utcnow().isoformat()


def _readBlob(conn: sqlite3.Connection) -> list[dict] | None:
    """Read the old auto_memories JSON blob from memory_store."""
    row = conn.execute('SELECT value FROM memory_store WHERE key = ?', ('autoMemories',)).fetchone()
    if not row:
        return None
    try:
        val = json.loads(row['value'])
        if isinstance(val, list):
            return val
        return None
    except (json.JSONDecodeError, TypeError):
        return None


def runMigration(dryRun: bool = False) -> dict[str, Any]:
    """Run the auto_memories migration. Returns stats dict."""
    stats = {
        'blob_found': False,
        'blob_entry_count': 0,
        'existing_auto_count': 0,
        'inserted': 0,
        'skipped_duplicates': 0,
        'blob_deleted': False,
        'errors': [],
    }
    conn = _connect()
    existing = conn.execute('SELECT COUNT(*) FROM auto_memories').fetchone()
    stats['existing_auto_count'] = existing[0] if existing else 0
    blob = _readBlob(conn)
    if blob is None:
        stats['errors'].append('No auto_memories blob found in memory_store — nothing to migrate.')
        conn.close()
        return stats
    stats['blob_found'] = True
    stats['blob_entry_count'] = len(blob)
    for entry in blob:
        if not isinstance(entry, dict):
            stats['skipped_duplicates'] += 1
            continue
        key = entry.get('key', '')
        if not key:
            stats['skipped_duplicates'] += 1
            continue
        dup = conn.execute('SELECT id FROM auto_memories WHERE key = ?', (key,)).fetchone()
        if dup:
            stats['skipped_duplicates'] += 1
            continue
        content = entry.get('content', '')
        if isinstance(content, (dict, list)):
            content = json.dumps(content)
        else:
            content = str(content)
        category = entry.get('category', 'auto')
        importance = entry.get('importance', 0.5)
        createdRaw = entry.get('created_at') or entry.get('created', '')
        created = _normalizeIso(createdRaw)
        source = entry.get('source', 'migration')
        if dryRun:
            print(f'[dry-run] Would insert: key={key}, importance={importance}')
            stats['inserted'] += 1
            continue
        conn.execute(
            'INSERT INTO auto_memories (key, content, category, importance, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            (key, content, category, importance, source, created),
        )
        stats['inserted'] += 1
    if not dryRun and stats['inserted'] > 0:
        conn.execute("DELETE FROM memory_store WHERE key = 'autoMemories'")
        stats['blob_deleted'] = True
    if not dryRun:
        conn.commit()
    try:
        ftsCount = conn.execute('SELECT COUNT(*) FROM auto_memories_fts').fetchone()
        stats['fts_count'] = ftsCount[0] if ftsCount else 0
    except Exception as e:
        stats['fts_error'] = str(e)
    if stats['blob_deleted']:
        blobCheck = conn.execute("SELECT value FROM memory_store WHERE key = 'autoMemories'").fetchone()
        stats['blob_remains'] = blobCheck is not None
    conn.close()
    return stats


def main():
    parser = argparse.ArgumentParser(description='Migrate auto_memories JSON blob to individual FTS-indexed rows')
    parser.add_argument('--dry-run', action='store_true', help='Show what would change without writing')
    args = parser.parse_args()
    print(f'Auto-memories migration (dry_run={args.dry_run})')
    print('=' * 50)
    stats = runMigration(dry_run=args.dry_run)
    print('\nResults:')
    for k, v in stats.items():
        print(f'  {k}: {v}')
    if not args.dry_run:
        print('\nMigration complete.')
    else:
        print('\nDry-run complete — no data written.')


if __name__ == '__main__':
    main()
