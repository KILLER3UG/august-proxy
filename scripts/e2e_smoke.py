"""Live end-to-end exercise of the features changed this session.

Runs against a REAL uvicorn backend over HTTP, because the unit tests call
functions directly and therefore cannot catch the things that only break on
the way in: lifespan initialisation, route wiring, request serialisation, the
actual `buildSystemPrompt` call path, and a cold brain database.

This is deliberately a script and not a test file — it talks to a server the
user started, so it cannot live in the suite.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = os.environ.get('AUGUST_E2E_BASE', 'http://127.0.0.1:18999')
WORKSPACE = Path(os.environ['AUGUST_DATA_DIR']) / 'e2e-workspace'

passed: list[str] = []
failed: list[tuple[str, str]] = []


def check(name: str, ok: bool, detail: str = '') -> None:
    (passed if ok else failed).append(name if ok else (name, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f'  -- {detail}' if detail and not ok else ''))


def call(method: str, path: str, body: dict | None = None, origin: str | None = None) -> tuple[int, object]:
    """Return (status, decoded body). Non-2xx is a value, not an exception.

    `origin=None` sends NO Origin header, which is what a local non-browser
    client does and what the trust guard treats as trusted. That is the whole
    threat model: every `/api/*` route is a local-process primitive, and the
    guard exists to stop a malicious *web page* — which always sends an
    Origin — from reaching it. `origin` is set only where the guard is the
    thing under test.
    """
    url = f'{BASE}{path}'
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if origin is not None:
        req.add_header('Origin', origin)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode('utf-8', 'replace')
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode('utf-8', 'replace')
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw
    except Exception as exc:  # noqa: BLE001 - a probe script, not production
        return 0, f'{type(exc).__name__}: {exc}'


print('\n=== 1. Cold boot and health ===')
status, health = call('GET', '/api/health')
check('health responds 200', status == 200, str(health))
check('python flag true', isinstance(health, dict) and health.get('python') is True, str(health))

print("\n=== 2. Origin guard still refuses what a browser can be made to send ===")


def browser_style(origin: str) -> int:
    """Issue a GET carrying `origin` and return the status code."""
    req = urllib.request.Request(f'{BASE}/api/hooks')
    req.add_header('Origin', origin)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code


check('a foreign web origin is refused', browser_style('https://evil.example.com') in (403, 400),
      f'got {browser_style("https://evil.example.com")}')
check('a null origin is refused', browser_style('null') in (403, 400), f'got {browser_style("null")}')
check('no Origin header at all is allowed (local process)', call('GET', '/api/hooks')[0] == 200,
      'the local-process case must still work or the desktop app breaks')

print('\n=== 3. Workspace hooks: the trust gate and its notice ===')
(WORKSPACE / '.aug').mkdir(parents=True, exist_ok=True)
(WORKSPACE / '.aug' / 'hooks.json').write_text(
    json.dumps({'hooks': [{'name': 'e2e-lint', 'event': 'pre_tool_use', 'command': 'echo hi'}]}),
    'utf-8',
)
status, session = call('POST', '/api/workbench/session', {'goal': 'e2e hooks', 'workspacePath': str(WORKSPACE)})
session_id = ''
if isinstance(session, dict):
    session_id = str(session.get('id') or session.get('sessionId') or '')
if not session_id:
    status, sessions = call('GET', '/api/workbench/sessions')
    if isinstance(sessions, list) and sessions:
        session_id = str(sessions[0].get('id') or '')
check('a workbench session was created', bool(session_id), f'status={status} body={str(session)[:160]}')

status, hooks = call('GET', f'/api/hooks?sessionId={session_id}')
check('GET /api/hooks responds', status == 200, str(hooks)[:160])
if isinstance(hooks, dict):
    check('reports workspaceTrusted=false', hooks.get('workspaceTrusted') is False, str(hooks)[:200])
    inactive = hooks.get('inactiveWorkspaceHooks')
    check('reports inactiveWorkspaceHooks', isinstance(inactive, list), f'got {inactive!r}')
    check(
        'the blocked workspace is named with a count',
        bool(inactive) and int(inactive[0].get('suppressed', 0)) >= 1,
        f'got {inactive!r}',
    )
    check(
        'no workspace hook is registered while untrusted',
        not [h for h in (hooks.get('userHooks') or []) if h.get('name', '').startswith('ws:')],
        str(hooks.get('userHooks'))[:200],
    )

status, trusted = call('POST', '/api/hooks/trust-workspace', {'sessionId': session_id})
check('trust-workspace accepted', status == 200 and (trusted or {}).get('ok') is not False, str(trusted)[:160])
status, hooks2 = call('GET', f'/api/hooks?sessionId={session_id}')
if isinstance(hooks2, dict):
    check('trusted after approval', hooks2.get('workspaceTrusted') is True, str(hooks2)[:200])
    check('inactive list cleared', hooks2.get('inactiveWorkspaceHooks') == [], str(hooks2.get('inactiveWorkspaceHooks')))
    check(
        'the workspace hook is now registered',
        bool([h for h in (hooks2.get('userHooks') or []) if h.get('name', '').startswith('ws:')]),
        str(hooks2.get('userHooks'))[:200],
    )

status, revoked = call('POST', '/api/hooks/revoke-workspace', {'sessionId': session_id})
check('revoke-workspace accepted', status == 200, str(revoked)[:160])
status, hooks3 = call('GET', f'/api/hooks?sessionId={session_id}')
if isinstance(hooks3, dict):
    check(
        'the notice comes back on revoke, with no extra round trip',
        bool(hooks3.get('inactiveWorkspaceHooks')),
        str(hooks3.get('inactiveWorkspaceHooks')),
    )
    check(
        'the workspace hook is unregistered again',
        not [h for h in (hooks3.get('userHooks') or []) if h.get('name', '').startswith('ws:')],
        str(hooks3.get('userHooks'))[:200],
    )

print('\n=== 4. FTS under contention (the flake area) ===')
# The FTS failure only ever appeared under CPU contention on the 4-vCPU CI
# runner — never in the serial or parallel local suite. So it is exercised
# here the only way it can be: many threads hammering the real brain database
# from real connections, which is the shape that produced it. The point of
# the fix is that a lost race no longer triggers DDL, so this asserts both
# that no write is lost and that no `vtable constructor failed` is raised.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend-py'))
os.environ['AUGUST_DATA_DIR'] = os.environ['AUGUST_DATA_DIR']
import threading  # noqa: E402

from app.services.memory_store import init as mem_init, kv  # noqa: E402

mem_init()
real = kv._conn()
mem_errors: list[str] = []
lock = threading.Lock()
WORKERS, PER_WORKER = 8, 60


def hammer(worker: int) -> None:
    for i in range(PER_WORKER):
        try:
            kv.save_internal(f'contend-{worker}-{i}', {'w': worker, 'i': i, 'pad': 'x' * 300})
        except Exception as exc:  # noqa: BLE001 - the point is to record anything raised
            with lock:
                mem_errors.append(f'{type(exc).__name__}: {exc}')


threads = [threading.Thread(target=hammer, args=(w,)) for w in range(WORKERS)]
for t in threads:
    t.start()
for t in threads:
    t.join()

check('no write raised under contention', not mem_errors, f'{len(mem_errors)} errors: {mem_errors[:2]}')
check(
    'no FTS constructor failure appeared',
    not [e for e in mem_errors if 'vtable constructor' in e],
    f'{len([e for e in mem_errors if "vtable constructor" in e])} occurrences',
)
missing = [
    f'contend-{w}-{i}'
    for w in range(WORKERS)
    for i in range(PER_WORKER)
    if kv.get_memory(f'contend-{w}-{i}') is None
]
check(
    f'all {WORKERS * PER_WORKER} contended writes landed',
    not missing,
    f'{len(missing)} missing, e.g. {missing[:3]}',
)
from app.services import memory_schema  # noqa: E402

check('the index is still structurally whole afterwards', memory_schema.fts_index_intact(real))

print(f'\n{"=" * 58}')
print(f'{len(passed)} passed, {len(failed)} failed')
for name, detail in failed:
    print(f'  FAILED: {name}\n           {detail}')
sys.exit(1 if failed else 0)
