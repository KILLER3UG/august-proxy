"""Export the FastAPI OpenAPI schema to docs/api/openapi.json (audit P1#7).

The committed schema is a BUILD ARTIFACT, not a hand-edited file: regenerate
with `backend-py/.venv/Scripts/python.exe backend-py/scripts/export_openapi.py`
and commit the result. scripts/check-api.mjs re-runs this into a temp file and
fails on drift, so a router change without a schema refresh cannot merge.

The export runs with AUGUST_DATA_DIR pointed at a throwaway dir — importing
the app must not touch a real data dir, and the schema does not depend on
user state.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


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
            'backend-py/.venv/Scripts/python.exe backend-py/scripts/export_openapi.py '
            'and commit the result.'
        )
        return 1
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, 'utf-8')
    paths = len(schema.get('paths', {}))
    print(f'[export-openapi] wrote {target.relative_to(REPO)} ({paths} paths)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
