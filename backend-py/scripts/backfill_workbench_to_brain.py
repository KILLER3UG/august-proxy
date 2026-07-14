#!/usr/bin/env python3
"""CLI: backfill workbench-sessions.json into august_brain.sqlite.

Usage (from backend-py/):
  python scripts/backfill_workbench_to_brain.py
  python scripts/backfill_workbench_to_brain.py --path ../data/workbench-sessions.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Ensure app package is importable when run as a script.
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description='Backfill workbench sessions into brain SQLite')
    parser.add_argument('--path', type=Path, default=None, help='Path to workbench-sessions.json')
    parser.add_argument('--max', type=int, default=500, help='Max sessions to copy')
    args = parser.parse_args()

    from app.services import memory_store
    from app.services.workbench.brain_sync import backfill_workbench_json_to_brain

    memory_store.init()
    result = backfill_workbench_json_to_brain(sessions_path=args.path, max_sessions=args.max)
    print(json.dumps(result, indent=2, default=str))
    failed = int(result.get('failed') or 0)
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
