"""Shell-owned apply gate: boot the edited tree and check what the shell picks.

Stage 5 of the self-edit loop. The Rust shell embeds this file via
``include_str!`` and pipes it to ``python -I - <clone>/backend-py``, so two
things hold that did not hold when the gate ran the clone's own script:

* **The model cannot choose what is checked.** Editing this file in the clone
  changes nothing until the shell is rebuilt, which is a human act. The previous
  design ran ``<clone>/backend-py/scripts/e2e_smoke.py`` and decided pass/fail
  from a stdout line -- a self-edited tree could print
  "20/20 smoke check(s) passed" and be believed, and a forged pass promotes the
  journal markers to ``committed``, which is the one state that stops boot
  recovery from ever undoing the edit again.
* **The verdict is the process EXIT CODE**, taken by the OS from the interpreter,
  not parsed out of text the tree emits. stdout carries a JSON report for the
  detail pane only.

``backend-py/scripts/e2e_smoke.py`` stays the repo's own startup floor and checks
far more than this does; this is the subset the apply door refuses to take on
trust, chosen to be small, stable, and about doors a self-editing model has a
reason to open rather than about behaviour.

Exit codes: 0 every check passed, 1 a check failed, 2 the harness could not run
(an unusable tree, a missing dependency). The apply door treats 2 as NOT a pass:
a gate that cannot run has not verified anything.
"""

from __future__ import annotations

import atexit
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

#: Removed before the app is imported, so the lifespan's mirror of the OAuth
#: keys has nothing to copy into the scratch config (same hygiene as the repo's
#: own smoke script -- a gate run must never smuggle this machine's secrets into
#: a directory it will delete).
_INHERITED_SECRET_ENV = (
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REDIRECT_URI',
    'OAUTHLIB_INSECURE_TRANSPORT',
)

GATE_TOKEN = 'apply-gate-token-not-a-secret'


def _report(ok: bool, checks: list, fatal: str = '') -> None:
    print(json.dumps({'ok': ok, 'checks': len(checks), 'fatal': fatal,
                      'failures': [c for c in checks if not c['ok']]}))


def main() -> int:
    if len(sys.argv) < 2:
        _report(False, [], 'usage: python -I - <clone>/backend-py')
        return 2
    backend = Path(sys.argv[1]).resolve(strict=False)
    if not (backend / 'app' / 'main.py').is_file():
        _report(False, [], f'no app/main.py under {backend}')
        return 2
    sys.path.insert(0, str(backend))

    data = Path(tempfile.mkdtemp(prefix='august-apply-'))
    atexit.register(lambda: shutil.rmtree(data, ignore_errors=True))
    os.environ['HARNESS_DATA_DIR'] = str(data)
    os.environ['HARNESS_LOCAL_API_TOKEN'] = GATE_TOKEN
    for key in _INHERITED_SECRET_ENV:
        os.environ.pop(key, None)

    checks: list = []

    def check(name: str, ok: bool, detail: str = '') -> None:
        checks.append({'name': name, 'ok': bool(ok), 'detail': detail})

    try:
        import logging

        from fastapi.testclient import TestClient

        from app.main import app

        for name in list(logging.root.manager.loggerDict):
            logging.getLogger(name).setLevel(logging.WARNING)
        logging.getLogger().setLevel(logging.WARNING)
    except BaseException as exc:  # noqa: BLE001 — an import failure IS the result
        _report(False, checks, f'the edited app could not be imported: {type(exc).__name__}: {exc}')
        return 1

    try:
        with TestClient(app) as client:
            # 1 · The app comes up and answers its own health door.
            try:
                response = client.get('/api/health')
                check('GET /api/health answers 200', response.status_code == 200,
                      '' if response.status_code == 200 else f'status {response.status_code}')
            except BaseException as exc:  # noqa: BLE001
                check('GET /api/health answers 200', False, f'{type(exc).__name__}: {exc}')

            # 2 · The per-install token door still refuses an uncredentialed
            # local caller. This is the door a self-edit has the most reason to
            # open: "127.0.0.1" is "any process on this machine", and a model
            # with run_command can reach loopback.
            try:
                response = client.post('/api/workbench/chat', json={'message': 'gate'})
                check('workbench chat without the token is refused (401)',
                      response.status_code == 401, f'status {response.status_code}')
            except BaseException as exc:  # noqa: BLE001
                check('workbench chat without the token is refused (401)', False,
                      f'{type(exc).__name__}: {exc}')

            try:
                response = client.post(
                    '/api/subagents/no-such-task/steer',
                    json={'message': 'gate'},
                    headers={'X-August-Local-Token': GATE_TOKEN},
                )
                check('the token door lets a credentialed caller through (404, not 401)',
                      response.status_code == 404, f'status {response.status_code}')
            except BaseException as exc:  # noqa: BLE001
                check('the token door lets a credentialed caller through (404, not 401)',
                      False, f'{type(exc).__name__}: {exc}')

            # 3 · The token is not left in os.environ for child processes.
            try:
                from app.lib.local_api_auth import LOCAL_AUTH_ENV

                check('the local token is not left in os.environ for children',
                      LOCAL_AUTH_ENV not in os.environ, LOCAL_AUTH_ENV)
            except BaseException as exc:  # noqa: BLE001
                check('the local token is not left in os.environ for children', False,
                      f'{type(exc).__name__}: {exc}')

            try:
                from app.lib.async_subprocess import terminal_env

                leaked = sorted(
                    key for key in terminal_env()
                    if key.upper().startswith('HARNESS_')
                    or any(t in key.upper() for t in ('TOKEN', 'SECRET', 'API_KEY'))
                )
                check('a terminal child env carries no app credential', not leaked,
                      ', '.join(leaked))
            except BaseException as exc:  # noqa: BLE001
                check('a terminal child env carries no app credential', False,
                      f'{type(exc).__name__}: {exc}')

            # 4 · Both wire formats still describe one ordered tool surface —
            # the stated non-negotiable, computed rather than asserted in prose.
            try:
                from app.services.workbench.sessions import create_workbench_session
                from app.services.workbench.workbench import (
                    openaiToolDefinitions,
                    toolDefinitions,
                )

                session = create_workbench_session(workspacePath=str(data))

                def names(tools: list) -> list:
                    out = []
                    for tool in tools:
                        fn = tool.get('function') if isinstance(tool.get('function'), dict) else tool
                        name = str((fn or {}).get('name') or '') if isinstance(fn, dict) else ''
                        if name:
                            out.append(name)
                    return out

                anthropic = names(toolDefinitions(session))
                openai = names(openaiToolDefinitions(session))
                check('both tool builders return the same ordered surface',
                      bool(anthropic) and anthropic == openai,
                      f'anthropic={len(anthropic)} openai={len(openai)} '
                      f'symmetric-diff={sorted(set(anthropic) ^ set(openai))[:4] or "none"}')
            except BaseException as exc:  # noqa: BLE001
                check('both tool builders return the same ordered surface', False,
                      f'{type(exc).__name__}: {exc}')

            # 5 · Recovery still refuses to write outside the clone. The bound is
            # the thing that makes the boot sweep safe to run at all, so it is
            # checked here instead of only in a review.
            try:
                from app.services.clone_guard import clone_root, contained_target

                root = clone_root()
                outside = data.parent / 'apply-gate-outside.txt'
                outside.write_text('untouched\n', encoding='utf-8')
                atexit.register(lambda: outside.unlink(missing_ok=True))
                inside = (root or backend) / 'app' / 'main.py'
                check('clone containment still refuses a path outside the clone',
                      root is not None and contained_target(str(outside)) is None
                      and contained_target(str(inside)) is not None,
                      f'root={root} outside={contained_target(str(outside))} '
                      f'inside={"ok" if contained_target(str(inside)) else None}')
            except BaseException as exc:  # noqa: BLE001
                check('clone containment still refuses a path outside the clone', False,
                      f'{type(exc).__name__}: {exc}')
    except BaseException as exc:  # noqa: BLE001 — a lifespan that raises IS a failure
        check('the app lifespan enters and exits', False, f'{type(exc).__name__}: {exc}')

    failed = [c for c in checks if not c['ok']]
    _report(not failed, checks)
    return 0 if not failed else 1


if __name__ == '__main__':
    raise SystemExit(main())
