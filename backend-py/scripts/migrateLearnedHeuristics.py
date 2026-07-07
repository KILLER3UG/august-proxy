"""
One-time migration: august_learned_guidelines.json → learned_heuristics table.

Reads the legacy JSON file and inserts each entry as a row in the
learned_heuristics table. Idempotent — checks for existing rows first.

Usage:
    python scripts/migrate_learned_heuristics.py [--dry-run]
"""
from __future__ import annotations
import argparse
import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

def _dbPath() -> Path:
    envPath = __import__('os').environ.get('AUGUST_BRAIN_SQLITE_FILE')
    if envPath:
        return Path(envPath)
    from app.lib.paths import dataPath
    return dataPath('august_brain.sqlite')

def _connect() -> sqlite3.Connection:
    db = _dbPath()
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    return conn

def _normalizeIso(ts: str | None) -> str:
    """Normalize an ISO timestamp to SQLite datetime format."""
    if not ts:
        return datetime.utcnow().isoformat()
    return ts.replace('Z', '').split('+')[0].split('.')[0] or datetime.utcnow().isoformat()

def runMigration(dryRun: bool=False) -> dict[str, Any]:
    """Run the learned guidelines migration. Returns stats dict."""
    jsonPath = Path('data/august_learned_guidelines.json')
    stats = {'json_found': False, 'json_count': 0, 'existing_count': 0, 'inserted': 0, 'skipped_duplicates': 0, 'errors': []}
    if not jsonPath.exists():
        stats['errors'].append(f'File not found: {jsonPath}')
        return stats
    with open(jsonPath) as f:
        guidelines = json.load(f)
    if not isinstance(guidelines, list):
        stats['errors'].append(f'Expected list, got {type(guidelines).__name__}')
        return stats
    stats['json_found'] = True
    stats['json_count'] = len(guidelines)
    conn = _connect()
    existing = conn.execute('SELECT COUNT(*) FROM learned_heuristics').fetchone()
    stats['existing_count'] = existing[0] if existing else 0
    for entry in guidelines:
        if not isinstance(entry, dict):
            continue
        text = entry.get('text', '') or ''
        if not text.strip():
            stats['skipped_duplicates'] += 1
            continue
        source = entry.get('source', '') or ''
        category = 'general'
        createdRaw = entry.get('createdAt', '')
        created = _normalizeIso(createdRaw)
        dup = conn.execute('SELECT id FROM learned_heuristics WHERE rule = ?', (text,)).fetchone()
        if dup:
            stats['skipped_duplicates'] += 1
            continue
        if dryRun:
            print(f'[dry-run] Would insert rule: {text[:80]}...')
            stats['inserted'] += 1
            continue
        conn.execute('INSERT INTO learned_heuristics (rule, source, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', (text, source, category, created, created))
        stats['inserted'] += 1
    if not dryRun:
        conn.commit()
    after = conn.execute('SELECT COUNT(*) FROM learned_heuristics').fetchone()
    stats['total_after'] = after[0] if after else 0
    conn.close()
    return stats

def main():
    parser = argparse.ArgumentParser(description='Migrate august_learned_guidelines.json to learned_heuristics table')
    parser.add_argument('--dry-run', action='store_true', help='Show what would change without writing')
    args = parser.parse_args()
    print(f'Learned heuristics migration (dry_run={args.dry_run})')
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