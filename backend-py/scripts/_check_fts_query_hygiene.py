"""Permanent FTS5 query hygiene checks (app SQL + live schema probes).

Why this exists
---------------
``_verify_fts_sync.py`` proves index *coverage* (base rows appear in FTS) using
*correct* table-level MATCH. It never executes application search functions.
That left a blind spot: app code could use ``WHERE content MATCH`` or
``WHERE <alias> MATCH`` and still leave the sync script green while production
fell back to LIKE / full-table scans.

This script checks two layers:

1. **Static (source)** — scan ``backend-py/app/**/*.py`` for FTS anti-patterns:
   * ``WHERE content MATCH`` (wrong column on memory_store_fts; fragile elsewhere)
   * ``WHERE <short_alias> MATCH`` after ``AS <short_alias>`` / bare alias
     (SQLite FTS5 often requires the *real table name* on the left of MATCH)

2. **Runtime (optional, live DB)** — for each known FTS virtual table, prove:
   * intentional-bad SQL fails (content MATCH / over-SELECT)
   * correct table-level MATCH works
   * JOIN + base table MATCH form works when a content table exists

Usage:
  python backend-py/scripts/_check_fts_query_hygiene.py
  python backend-py/scripts/_check_fts_query_hygiene.py --no-db   # static only
  python backend-py/scripts/_check_fts_query_hygiene.py --db path

Exit 0 only if all checks pass.
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / 'backend-py' / 'app'
DEFAULT_DB = ROOT / 'data' / 'august_brain.sqlite'

# Known FTS5 tables in the brain schema (extend when new FTS tables ship).
KNOWN_FTS: dict[str, dict[str, object]] = {
    'memory_store_fts': {
        'columns': ('key', 'value'),
        'bad_match_column': 'content',  # never existed on this FTS
        'content_table': 'memory_store',
        'sample_token': 'agent',
    },
    'auto_memories_fts': {
        'columns': ('key', 'content'),
        'bad_select_extra': ('category', 'importance', 'created_at'),
        'content_table': 'auto_memories',
        'sample_token': 'tool',
    },
}

# Static anti-patterns (applied to app/ only — tests may intentionally use bad SQL).
_RE_CONTENT_MATCH = re.compile(
    r'WHERE\s+content\s+MATCH\b',
    re.IGNORECASE,
)
# Alias MATCH: WHERE fts MATCH / WHERE t MATCH (1–4 char or common aliases)
_RE_ALIAS_MATCH = re.compile(
    r'WHERE\s+(fts|t|f|a|m|v|x)\s+MATCH\b',
    re.IGNORECASE,
)
# FROM fts_table AS alias ... WHERE alias MATCH  (same bug class, longer alias)
_RE_AS_ALIAS_THEN_MATCH = re.compile(
    r'FROM\s+(\w+_fts)\s+AS\s+(\w+)\s+.*?WHERE\s+\2\s+MATCH\b',
    re.IGNORECASE | re.DOTALL,
)


def _iter_app_py() -> list[Path]:
    return sorted(APP.rglob('*.py'))


def static_scan() -> list[str]:
    """Return human-readable failure lines for source anti-patterns."""
    fails: list[str] = []
    for path in _iter_app_py():
        text = path.read_text(encoding='utf-8', errors='replace')
        rel = path.relative_to(ROOT)
        # Skip pure comments? Still flag — comments with bad SQL are confusing.
        for i, line in enumerate(text.splitlines(), 1):
            stripped = line.lstrip()
            if stripped.startswith('#'):
                continue
            if _RE_CONTENT_MATCH.search(line):
                fails.append(f'{rel}:{i}: WHERE content MATCH (prefer table-level TABLE MATCH)')
            if _RE_ALIAS_MATCH.search(line):
                fails.append(
                    f'{rel}:{i}: WHERE <alias> MATCH — use real FTS table name on left of MATCH'
                )
        # Multi-line AS alias then alias MATCH
        for m in _RE_AS_ALIAS_THEN_MATCH.finditer(text):
            # Allow if WHERE also uses real table name on another clause? Flag always.
            fails.append(
                f'{rel}: AS {m.group(2)} then WHERE {m.group(2)} MATCH '
                f'(use WHERE {m.group(1)} MATCH instead)'
            )
    return fails


def runtime_probes(db: Path) -> list[str]:
    fails: list[str] = []
    if not db.exists():
        fails.append(f'DB missing: {db} (pass --no-db to skip runtime)')
        return fails
    conn = sqlite3.connect(str(db))
    try:
        names = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' OR type='view'"
            )
        }
        for fts_name, meta in KNOWN_FTS.items():
            if fts_name not in names:
                print(f'  SKIP {fts_name} (not in DB)')
                continue
            cols = [r[1] for r in conn.execute(f'PRAGMA table_info({fts_name})')]
            print(f'  {fts_name} columns={cols}')
            expected = list(meta['columns'])  # type: ignore[arg-type]
            for c in expected:
                if c not in cols:
                    fails.append(f'{fts_name}: expected column {c!r} missing; have {cols}')

            bad_col = meta.get('bad_match_column')
            if bad_col and bad_col not in cols:
                try:
                    conn.execute(
                        f'SELECT * FROM {fts_name} WHERE {bad_col} MATCH ?',
                        ('x',),
                    ).fetchall()
                    fails.append(f'{fts_name}: unexpected success for bad column MATCH {bad_col}')
                except sqlite3.Error as exc:
                    print(f'  OK bad column MATCH rejected: {exc}')

            extra = meta.get('bad_select_extra')
            if extra:
                sel = ', '.join(['rowid', *expected, *list(extra)])  # type: ignore[arg-type]
                try:
                    conn.execute(
                        f'SELECT {sel} FROM {fts_name} WHERE {fts_name} MATCH ? LIMIT 1',
                        (str(meta.get('sample_token') or 'x'),),
                    ).fetchall()
                    fails.append(f'{fts_name}: over-SELECT should fail for extras {extra}')
                except sqlite3.Error as exc:
                    print(f'  OK over-SELECT rejected: {exc}')

            token = str(meta.get('sample_token') or 'a')
            try:
                rows = conn.execute(
                    f'SELECT rowid FROM {fts_name} WHERE {fts_name} MATCH ? LIMIT 3',
                    (token,),
                ).fetchall()
                print(f'  OK table-level MATCH {fts_name} token={token!r} hits={len(rows)}')
            except sqlite3.Error as exc:
                fails.append(f'{fts_name}: good MATCH failed: {exc}')

            # Alias MATCH must fail or be avoided — probe the bug class
            try:
                conn.execute(
                    f'SELECT rowid FROM {fts_name} AS fts WHERE fts MATCH ? LIMIT 1',
                    (token,),
                ).fetchall()
                # Some SQLite builds may accept alias; warn but do not fail if it works
                print(f'  NOTE: alias MATCH accepted on this SQLite for {fts_name} (prefer table name anyway)')
            except sqlite3.Error as exc:
                print(f'  OK alias MATCH rejected on this SQLite: {exc}')

            content_table = meta.get('content_table')
            if content_table and content_table in names:
                try:
                    rows = conn.execute(
                        f'SELECT t.rowid FROM {fts_name} AS fts '
                        f'JOIN {content_table} AS t ON fts.rowid = t.rowid '
                        f'WHERE {fts_name} MATCH ? LIMIT 3',
                        (token,),
                    ).fetchall()
                    print(f'  OK JOIN + table MATCH hits={len(rows)}')
                except sqlite3.Error as exc:
                    fails.append(f'{fts_name}: JOIN+table MATCH failed: {exc}')
    finally:
        conn.close()
    return fails


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--db', type=Path, default=DEFAULT_DB)
    ap.add_argument('--no-db', action='store_true', help='Static scan only')
    args = ap.parse_args()

    print('=== FTS query hygiene (static app/ scan) ===')
    static_fails = static_scan()
    if static_fails:
        for line in static_fails:
            print('  FAIL', line)
    else:
        print('  OK no content-MATCH / alias-MATCH anti-patterns in app/')

    runtime_fails: list[str] = []
    if not args.no_db:
        print('=== FTS query hygiene (live DB probes) ===')
        runtime_fails = runtime_probes(args.db)
        for line in runtime_fails:
            print('  FAIL', line)

    n = len(static_fails) + len(runtime_fails)
    print(f'RESULT: {"PASS" if n == 0 else "FAIL"} errors={n}')
    return 0 if n == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
