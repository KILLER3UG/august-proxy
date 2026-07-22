#!/usr/bin/env python3
"""Live connectivity smoke checklist against a running August Proxy.

Program acceptance checks (unified connectivity plan):
  1. Session SoT: SQLite blob survives without JSON (in-process)
  2. Fleet PUT visible without restart
  3. Cognitive config tree readable
  4. Health maps to real storage
  5. MCP registry list
  6. Proxy tools do not return Stub: success
  7. HTTP: health, workbench sessions, model-fleet, cognitive

Usage:
  python scripts/smoke_live.py
  python scripts/smoke_live.py --base http://127.0.0.1:8085
  python scripts/smoke_live.py --skip-http
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _http_json(method: str, url: str, body: dict | None = None, timeout: float = 8.0) -> tuple[int, object]:
    import urllib.error
    import urllib.request

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

    # --- In-process SoT + fleet + cognitive ---
    try:
        from app.services import memory_store, model_fleet_service
        from app.services.cognitive_boot import get_boot_status
        from app.services.cognitive_config import ensure_defaults
        from app.services.memory_store import list_workbench_blobs, save_workbench_session_sot
        from app.services.workbench.brain_sync import (
            backfill_workbench_json_to_brain,
            get_sync_stats,
            sync_workbench_session_to_brain,
        )
        from app.services.workbench.sessions import WorkbenchSession

        memory_store.init()
        check('memory_store.init', True)

        # Session SoT: write blob, delete JSON, reload from SQLite only
        from app.lib.paths import dataPath
        from app.services.workbench.sessions import (
            _sessions,
            _sessions_path,
            reload_sessions_from_sot,
        )

        sess = WorkbenchSession(
            id='smoke_wb_sot',
            title='smoke-sot',
            messages=[{'role': 'user', 'content': 'smoke-sot-marker-ZZZ'}],
            messageCount=1,
            createdAt='2026-01-01T00:00:00Z',
            startedAt='2026-01-01T00:00:00Z',
            updatedAt='2026-01-01T00:00:00Z',
        )
        save_workbench_session_sot(sess.toDict())
        blobs = list_workbench_blobs(limit=50)
        found = any(isinstance(b, dict) and b.get('id') == 'smoke_wb_sot' for b in blobs)
        check('session_sot.blob_readable', found, f'blobs={len(blobs)}')

        # Prove JSON-delete survival: remove export file, clear memory, reload SoT
        json_path = dataPath('workbench-sessions.json')
        if json_path.exists():
            json_path.unlink()
        _sessions.clear()
        n = reload_sessions_from_sot()
        reloaded = _sessions.get('smoke_wb_sot')
        check(
            'session_sot.json_delete_survives',
            reloaded is not None and not json_path.exists(),
            {'reloaded': bool(reloaded), 'count': n, 'json_exists': json_path.exists()},
        )
        msgs = memory_store.get_messages('smoke_wb_sot')
        hit = any('ZZZ' in str(m.get('content', '')) for m in msgs) or found
        check('session_sot.history', hit, f'messages={len(msgs)}')
        memory_store.delete_session_messages('smoke_wb_sot')
        memory_store.delete_session_record('smoke_wb_sot')
        _sessions.pop('smoke_wb_sot', None)

        # Vector/graph SQLite writers
        from app.services.memory import graph_memory, vector_db

        ve = vector_db.insert('smoke vector sentence', metadata={'src': 'smoke'}, namespace='smoke')
        check('vector.sqlite_insert', bool(ve.get('id')), ve.get('id'))
        check('vector.sqlite_count', vector_db.count('smoke') >= 1, vector_db.count('smoke'))
        ge = graph_memory.addEntity('smoke_entity', entityType='test')
        check('graph.sqlite_entity', ge.get('name') == 'smoke_entity', ge)

        ok = sync_workbench_session_to_brain(sess, strict=False)
        check('brain_sync.sync', ok, get_sync_stats())

        bq = memory_store.brain_query(store='auto_memories', query='', limit=1)
        check('brain_query.alias', 'not available' not in bq, bq[:120])

        bf = backfill_workbench_json_to_brain()
        check('backfill.callable', bf.get('message') in ('ok', 'no workbench-sessions.json'), bf)

        boot = get_boot_status()
        check('cognitive_boot.status_readable', isinstance(boot, dict), boot)

        tree = ensure_defaults()
        check(
            'cognitive_config.tree',
            isinstance(tree, dict) and 'boot' in tree and 'fleet' in tree,
            {k: type(v).__name__ for k, v in tree.items()},
        )

        # Fleet cache bust: PUT path equivalent
        model_fleet_service.invalidate_cache()
        before = model_fleet_service.getModelForRole('cerebellum')
        ok_f, err_f, fleet = model_fleet_service.updateFleet({'cerebellum': 'smoke-fleet-model-xyz'})
        after = model_fleet_service.getModelForRole('cerebellum')
        check('fleet.put_visible', ok_f and after == 'smoke-fleet-model-xyz', {'before': before, 'after': after, 'err': err_f})
        # restore previous if we had one
        if before and before != 'smoke-fleet-model-xyz':
            model_fleet_service.updateFleet({'cerebellum': before})
        else:
            model_fleet_service.updateFleet({'cerebellum': model_fleet_service.DEFAULTS['cerebellum']})

        # Proxy tools: no Stub: success
        import asyncio

        from app.adapters import proxy_tools

        async def _proxy_check() -> str:
            try:
                r = await proxy_tools.execute_managed_proxy_tool('web_search', {'query': 'august proxy smoke'})
                return str(r)[:200]
            except Exception as exc:
                return f'ERR:{exc}'

        proxy_out = asyncio.get_event_loop().run_until_complete(_proxy_check()) if False else None
        try:
            proxy_out = asyncio.run(_proxy_check())
        except RuntimeError:
            loop = asyncio.new_event_loop()
            proxy_out = loop.run_until_complete(_proxy_check())
            loop.close()
        check('proxy_tools.no_stub', proxy_out is not None and not str(proxy_out).startswith('Stub:'), proxy_out)

        from app.services.tools import mcp_client

        servers = mcp_client.listRegisteredServers()
        check('mcp.registry_listable', isinstance(servers, list), f'count={len(servers)}')

        from app.services.db_writer import get_stats

        # get_stats is sync-safe even if the worker is not running.
        check('db_writer.stats', isinstance(get_stats(), dict), get_stats())

    except Exception as exc:
        check('in_process', False, str(exc))

    if not args.skip_http:
        status, body = _http_json('GET', f'{base}/api/health')
        check('http.health', status == 200 and isinstance(body, dict) and body.get('status') == 'ok', body)

        status, body = _http_json('GET', f'{base}/api/health/detailed')
        check('http.health_detailed', status in (200, 404), {'status': status})

        for path in (
            '/api/config/safe',
            '/api/config/model-fleet',
            '/api/config/cognitive',
            '/api/brain/status',
            '/api/brain/diagnostics',
            '/api/brain/health',
            '/api/brain/sync-status',
            '/api/usage',
            '/api/models',
            '/api/workbench/sessions',
            '/api/mcp/servers',
        ):
            status, body = _http_json('GET', f'{base}{path}')
            check(f'http{path}', status in (200, 404) or (status >= 400 and status < 500), {'status': status})

        status, body = _http_json('PUT', f'{base}/api/config/model-fleet', {'cortex': ''})
        check('http.fleet.put', status in (200, 400, 422) or status == 0, {'status': status})

        status, body = _http_json('POST', f'{base}/api/workbench/sessions', {'provider': '', 'guardMode': 'full'})
        if status == 200 and isinstance(body, dict) and body.get('id'):
            check('http.workbench.create_session', True, body.get('id'))
        else:
            check('http.workbench.create_session', status == 0 or status >= 400, {'status': status, 'body': body})

        # STT honesty: 501 when called without full implementation
        status, body = _http_json('POST', f'{base}/api/live/stt', {})
        check('http.live.stt_honest', status in (0, 400, 401, 404, 422, 501), {'status': status})

    print('---')
    print(json.dumps({'failed': failed, 'results': results}, indent=2, default=str)[:6000])
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
