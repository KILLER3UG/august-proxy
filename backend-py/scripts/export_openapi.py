"""Export the FastAPI OpenAPI schema to docs/api/openapi.json (audit P1#7).

The committed schema is a BUILD ARTIFACT, not a hand-edited file: regenerate
with `npm run gen:openapi` (or invoke this file with any interpreter that can
import the backend app) and commit the result. scripts/check-api.mjs re-runs
this and fails on drift, so a router change without a schema refresh cannot
merge.

The export runs with AUGUST_DATA_DIR pointed at a throwaway dir — importing
the app must not touch a real data dir, and the schema does not depend on
user state.
"""

from __future__ import annotations

import difflib
import json
import os
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
# Enough to identify a drift, short enough for a CI log.
_MAX_DIFF_LINES = 60


def build_schema() -> dict:
    data_dir = tempfile.mkdtemp(prefix='august-openapi-')
    os.environ['AUGUST_DATA_DIR'] = data_dir
    sys.path.insert(0, str(REPO / 'backend-py'))
    from app.main import app  # noqa: PLC0415 — import AFTER the env is pinned

    return app.openapi()


def main() -> int:
    target = REPO / 'docs' / 'api' / 'openapi.json'
    check = '--check' in sys.argv
    schema = build_schema()
    text = json.dumps(schema, indent=2, ensure_ascii=False, sort_keys=True) + '\n'
    if check:
        current = target.read_text('utf-8') if target.exists() else ''
        if current == text:
            print('[check-api] ok — committed OpenAPI schema matches the app')
            return 0
        print(
            '[check-api] FAIL — docs/api/openapi.json is stale. Regenerate with '
            '`npm run gen:openapi` and commit the result.'
        )
        # Always show WHAT differs. "Stale" on its own sends people to
        # regenerate a schema that was already correct, which is how a real
        # environment problem gets mistaken for a real code problem. The diff
        # is bounded because the file is ~500 KB and CI logs are not infinite.
        diff = list(
            difflib.unified_diff(
                current.splitlines(keepends=True),
                text.splitlines(keepends=True),
                fromfile='committed docs/api/openapi.json',
                tofile='regenerated from the app',
                n=1,
            )
        )
        for line in diff[:_MAX_DIFF_LINES]:
            sys.stdout.write(line if line.endswith('\n') else line + '\n')
        if len(diff) > _MAX_DIFF_LINES:
            print(f'... ({len(diff) - _MAX_DIFF_LINES} more diff lines not shown)')
        return 1
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, 'utf-8')
    paths = len(schema.get('paths', {}))
    print(f'[export-openapi] wrote {target.relative_to(REPO)} ({paths} paths)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
