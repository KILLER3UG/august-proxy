"""
One-time migration: august_core_memory.json → SQLite memory_store.

Reads the legacy JSON file and upserts user_profile, current_context, and
active_projects into the memory_store table. Supports --dry-run and
--source json|sqlite|merge flags per the Phase 0 spec.

Usage:
    python scripts/migrate_core_memory.py [--dry-run] [--source json|sqlite|merge]
"""
from __future__ import annotations
import argparse
import json
import sqlite3
import sys
from pathlib import Path

def _dbPath() -> Path:
    """Resolve brain DB path (mirrors memory_store._db_path)."""
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

def _readJson(path: Path) -> dict | None:
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)

def _readSqliteKey(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute('SELECT value FROM memory_store WHERE key = ?', (key,)).fetchone()
    if row:
        try:
            return json.loads(row['value'])
        except (json.JSONDecodeError, TypeError):
            return row['value']
    return None

def _upsert(conn: sqlite3.Connection, key: str, value: dict) -> None:
    conn.execute("INSERT OR REPLACE INTO memory_store (key, value, updated_at) VALUES (?, ?, datetime('now'))", (key, json.dumps(value)))

def _mergeValues(jsonVal, sqliteVal) -> dict:
    """Field-level merge: prefer non-empty, prefer JSON on conflict."""
    if jsonVal is None and sqliteVal is None:
        return {}
    if jsonVal is None:
        return sqliteVal or {}
    if sqliteVal is None:
        return jsonVal or {}
    if not isinstance(jsonVal, dict) or not isinstance(sqliteVal, dict):
        return jsonVal or sqliteVal
    merged = {}
    allKeys = set(jsonVal.keys()) | set(sqliteVal.keys())
    for k in allKeys:
        jv = jsonVal.get(k)
        sv = sqliteVal.get(k)
        if jv and sv and (jv != sv):
            merged[k] = jv
        elif jv:
            merged[k] = jv
        else:
            merged[k] = sv
    return merged

def runMigration(source: str='merge', dryRun: bool=False) -> dict:
    """Run the core memory migration. Returns stats dict."""
    jsonPath = Path('data/august_core_memory.json')
    stats = {'json_found': False, 'sqlite_source_count': 0, 'upserted': 0, 'errors': []}
    conn = _connect()
    jsonData = _readJson(jsonPath)
    if jsonData is not None:
        stats['json_found'] = True
    sqliteProfile = _readSqliteKey(conn, 'userProfile')
    sqliteContext = _readSqliteKey(conn, 'current_context')
    sqliteProjects = _readSqliteKey(conn, 'active_projects')
    stats['sqlite_source_count'] = sum((1 for v in [sqliteProfile, sqliteContext, sqliteProjects] if v))
    jsonProfile = (jsonData or {}).get('userProfile')
    jsonContext = (jsonData or {}).get('global_context')
    jsonProjects = (jsonData or {}).get('active_projects')
    if source == 'json':
        profileVal = jsonProfile
        contextVal = jsonContext
        projectsVal = jsonProjects
    elif source == 'sqlite':
        profileVal = sqliteProfile
        contextVal = sqliteContext
        projectsVal = sqliteProjects
    else:
        profileVal = _mergeValues(jsonProfile, sqliteProfile)
        contextVal = _mergeValues(jsonContext, sqliteContext)
        projectsVal = _mergeValues(jsonProjects, sqliteProjects)
    if profileVal is not None:
        if dryRun:
            print(f'[dry-run] Would upsert user_profile: {str(profileVal)[:100]}...')
        else:
            _upsert(conn, 'userProfile', profileVal)
        stats['upserted'] += 1
    if contextVal is not None:
        if dryRun:
            print(f'[dry-run] Would upsert current_context: {str(contextVal)[:100]}...')
        else:
            _upsert(conn, 'current_context', contextVal)
        stats['upserted'] += 1
    if projectsVal is not None:
        if dryRun:
            print(f'[dry-run] Would upsert active_projects: {str(projectsVal)[:100]}...')
        else:
            _upsert(conn, 'active_projects', projectsVal)
        stats['upserted'] += 1
    if not dryRun:
        conn.commit()
    for key in ('userProfile', 'current_context', 'active_projects'):
        stored = _readSqliteKey(conn, key)
        if stored is not None:
            stats[f'verified_{key}'] = True
    conn.close()
    return stats

def main():
    parser = argparse.ArgumentParser(description='Migrate august_core_memory.json to SQLite memory_store')
    parser.add_argument('--dry-run', action='store_true', help='Show what would change without writing')
    parser.add_argument('--source', choices=['json', 'sqlite', 'merge'], default='merge', help='Source priority for merge conflicts (default: merge)')
    args = parser.parse_args()
    print(f'Core memory migration (--source={args.source}, dry_run={args.dry_run})')
    print('=' * 50)
    stats = runMigration(source=args.source, dry_run=args.dry_run)
    print('\nResults:')
    for k, v in stats.items():
        print(f'  {k}: {v}')
    if not args.dry_run:
        print('\nMigration complete.')
    else:
        print('\nDry-run complete — no data written.')
if __name__ == '__main__':
    main()