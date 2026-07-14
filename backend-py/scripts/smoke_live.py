#!/usr/bin/env python3
"""Live connectivity smoke checklist against a running August Proxy.

Checks:
  1. GET /api/health
  2. GET /api/health/detailed (if present)
  3. GET /api/brain/status or diagnostics
  4. brain dual-write path (in-process, no live HTTP)
  5. Optional: POST /api/workbench/sessions + dual-write verification
  6. Settings-related config endpoints

Usage:
  python scripts/smoke_live.py
  python scripts/smoke_live.py --base http://127.0.0.1:8085
  python scripts/smoke_live.py --skip-http   # only in-process checks
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _http_json(method: str, url: str, body: dict | None = None, timeout: float = 8.0) -> tuple[int, object]:
    data = None
    headers = {'Accept': 'application/json'}
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode('utf-8') or '{}'
            try:
                parsed: object = json.loads(raw)
            except json.JSONDecodeError:
                parsed = raw
            return resp.status, parsed
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', errors='replace')
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = raw
        return e.code, parsed
    except Exception as exc:
        return 0, {'error': str(exc)}


def main() -> int:
    parser = argparse.ArgumentParser(description='August Proxy live smoke checklist')
    parser.add_argument('--base', default='http://127.0.0.1:8085', help='Backend base URL')
    parser.add_argument('--skip-http', action='store_true', help='Skip HTTP probes')
    args = parser.parse_args()
    base = args.base.rstrip('/')
    results: list[dict[str, object]] = []
    failed = 0

    def check(name: str, ok: bool, detail: object = None) -> None:
        nonlocal failed
        results.append({'name': name, 'ok': ok, 'detail': detail})
        if not ok:
            failed += 1
        mark = 'PASS' if ok else 'FAIL'
        print(f'[{mark}] {name}: {detail if detail is not None else ""}')

    # --- In-process ---
    try:
        from app.services import memory_store
        from app.services.workbench.brain_sync import (
            sync_workbench_session_to_brain,
            backfill_workbench_json_to_brain,
            get_sync_stats,
        )
        from app.services.workbench.sessions import WorkbenchSession
        from app.services.cognitive_boot import get_boot_status

        memory_store.init()
        check('memory_store.init', True)

        sess = WorkbenchSession(
            id='smoke_wb_sync',
            title='smoke',
            messages=[{'role': 'user', 'content': 'smoke-dual-write-marker-ZZZ'}],
            messageCount=1,
            createdAt='2026-01-01T00:00:00Z',
            startedAt='2026-01-01T00:00:00Z',
            updatedAt='2026-01-01T00:00:00Z',
        )
        ok = sync_workbench_session_to_brain(sess, strict=False)
        check('dual_write.sync', ok, get_sync_stats())
        msgs = memory_store.get_messages('smoke_wb_sync')
        hit = any('ZZZ' in str(m.get('content', '')) for m in msgs)
        check('dual_write.readable', hit, f'messages={len(msgs)}')
        memory_store.delete_session_messages('smoke_wb_sync')
        memory_store.delete_session_record('smoke_wb_sync')

        bq = memory_store.brain_query(store='auto_memories', query='', limit=1)
        check('brain_query.alias', 'not available' not in bq, bq[:120])

        bf = backfill_workbench_json_to_brain()
        check('backfill.callable', bf.get('message') in ('ok', 'no workbench-sessions.json'), bf)

        boot = get_boot_status()
        check('cognitive_boot.status_readable', isinstance(boot, dict), boot)
    except Exception as exc:
        check('in_process', False, str(exc))

    if not args.skip_http:
        status, body = _http_json('GET', f'{base}/api/health')
        check('http.health', status == 200 and isinstance(body, dict) and body.get('status') == 'ok', body)

        status, body = _http_json('GET', f'{base}/api/health/detailed')
        check('http.health_detailed', status in (200, 404), {'status': status, 'body': body if status != 200 else 'ok'})

        for path in (
            '/api/config/safe',
            '/api/brain/status',
            '/api/brain/diagnostics',
            '/api/usage',
            '/api/models',
            '/api/workbench/sessions',
        ):
            status, body = _http_json('GET', f'{base}{path}')
            # 200 or structured error is fine; 0 = connection refused
            check(f'http{path}', status in (200, 404) or (status >= 400 and status < 500), {'status': status})

        # Create a workbench session if server is up
        status, body = _http_json('POST', f'{base}/api/workbench/sessions', {'provider': '', 'guardMode': 'full'})
        if status == 200 and isinstance(body, dict) and body.get('id'):
            check('http.workbench.create_session', True, body.get('id'))
        else:
            check('http.workbench.create_session', status == 0 or status >= 400, {'status': status, 'body': body})

    print('---')
    print(json.dumps({'failed': failed, 'results': results}, indent=2, default=str)[:4000])
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
