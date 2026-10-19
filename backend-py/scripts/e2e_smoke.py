"""End-to-end smoke: does the app START, and do its basic doors answer?

The test suite was deleted on 2026-10-17 at the owner's request. What
replaced it is a set of static gates — `npm run check:docs`, `check:sse`,
`check:brain-config`, `check:truncate` and friends — and they cover what
they can see: a frame nobody handles, a key nobody can write, a `truncate`
that cannot truncate.

What no static gate can see is the app **starting**. A module that fails to
import, a migration that does not apply, a lifespan hook that raises, a
router that fails to register — every one of those is invisible to a linter
and fatal at launch. This script is the floor under that: it imports the
real app, runs its lifespan, and asks a handful of read-only doors a
question.

It is deliberately NOT a behaviour test. It does not check that the app
computes the right thing; it checks that the app comes up and that the doors
the desktop shell opens on launch answer. The difference matters: a failure
here means "the app is broken", not "a rule changed".

**It never touches the user's data.** `AUGUST_DATA_DIR` is pointed at a
throwaway temp directory unless the caller says otherwise, and the temp
directory is removed afterwards. The app's own data directory holds
everything a user owns — brain database, provider keys, learned skills,
sessions — and a smoke check has no business being the thing that corrupts
it. `--data-dir` exists for the rare case of pointing it at a real
directory on purpose.

Usage:
    python scripts/e2e_smoke.py             # scratch data, throwaway
    python scripts/e2e_smoke.py --data-dir X # use X (never the default)
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'backend-py'))


def _quiet_logs() -> None:
    """Keep the app's startup logging out of the report.

    The app logs a line per migration and a line per background service at
    startup — useful when a migration breaks, noise otherwise. The report is
    the thing being read.
    """
    import logging

    for name in list(logging.root.manager.loggerDict):
        logging.getLogger(name).setLevel(logging.WARNING)
    logging.getLogger().setLevel(logging.WARNING)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--data-dir',
        default=None,
        help='use this data directory instead of a throwaway one. NEVER pass the '
        'real one by accident — it holds the user\'s brain database and keys.',
    )
    parser.add_argument(
        '--json',
        action='store_true',
        help='print the report as JSON (for a CI step to read)',
    )
    args = parser.parse_args()

    if args.data_dir:
        data_dir = Path(args.data_dir).resolve()
        data_dir.mkdir(parents=True, exist_ok=True)
        scratch = False
    else:
        data_dir = Path(tempfile.mkdtemp(prefix='august-smoke-'))
        scratch = True
        atexit.register(lambda: shutil.rmtree(data_dir, ignore_errors=True))

    os.environ['AUGUST_DATA_DIR'] = str(data_dir)

    from app.main import app
    from fastapi.testclient import TestClient

    # AFTER the import: the app configures its own logging when it is
    # imported, so quieting the loggers before that is undone by the import.
    _quiet_logs()

    results: list[dict] = []

    def check(name: str, ok: bool, detail: str = '') -> None:
        results.append({'name': name, 'ok': ok, 'detail': detail})

    with TestClient(app) as client:
        # 1. The doors the desktop shell opens on launch.
        for name, path in (
            ('health', '/api/health'),
            ('config', '/api/config/safe'),
            ('brain-config', '/api/brain/config'),
            ('agents', '/api/agents'),
            ('skills-suggestions', '/api/brain/skills/suggestions'),
            ('memory-metrics', '/api/brain/memory/metrics'),
        ):
            try:
                response = client.get(path)
                ok = response.status_code == 200
                check(
                    f'GET {path}',
                    ok,
                    '' if ok else f'status {response.status_code}',
                )
            except Exception as exc:  # noqa: BLE001 — a failure IS the result
                check(f'GET {path}', False, f'{type(exc).__name__}: {exc}')

        # 2. The brain-config panel's own keys must be WRITABLE. This is the
        #    class of bug the static gate catches, checked here as well
        #    because it is cheap and it exercises the live route rather than
        #    the validator in isolation.
        try:
            response = client.put(
                '/api/brain/config',
                json={'maxWorkbenchToolLoops': 0},
            )
            ok = response.status_code == 200
            check(
                'PUT /api/brain/config (maxWorkbenchToolLoops=0)',
                ok,
                '' if ok else f'status {response.status_code}: {response.text[:200]}',
            )
        except Exception as exc:  # noqa: BLE001
            check('PUT /api/brain/config', False, f'{type(exc).__name__}: {exc}')

        # 3. /mcp/harness must be CLOSED while external access is off. The
        #    route dispatches real model calls and real tool execution, and
        #    the browser origin guard does not cover a local script.
        try:
            response = client.post('/mcp/harness', json={'method': 'tools/list'})
            ok = response.status_code == 403
            check(
                'POST /mcp/harness is closed (403)',
                ok,
                '' if ok else f'status {response.status_code}',
            )
        except Exception as exc:  # noqa: BLE001
            check('POST /mcp/harness', False, f'{type(exc).__name__}: {exc}')

    failures = [r for r in results if not r['ok']]
    report = {
        'ok': not failures,
        'dataDir': str(data_dir),
        'scratch': scratch,
        'checks': len(results),
        'failures': failures,
    }

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for r in results:
            mark = 'ok  ' if r['ok'] else 'FAIL'
            detail = f'  ({r["detail"]})' if r['detail'] else ''
            print(f'{mark} {r["name"]}{detail}')
        print(
            f'\n{len(results) - len(failures)}/{len(results)} smoke check(s) passed '
            f'({"scratch data" if scratch else "EXPLICIT data dir"}).'
        )

    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
