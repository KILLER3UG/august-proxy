"""Authentication for the backend's SENSITIVE local routes.

The management API on ``/api/*`` has no authentication by design: it is the
local SPA's surface, and the SPA is a browser page on the same machine. That
is a reasonable default for reading a setting.

It is not a reasonable default for the routes that **start work** or
**approve something**:

    POST /api/subagents/spawn
    POST /api/subagents/{taskId}/steer
    POST /api/subagents/workstreams/{name}/continue
    POST /api/subagents/{taskId}/resume
    POST /api/harness/proposals/{pid}/decide

``/api/*`` listens on ``127.0.0.1``, which means "any local process" — not
"the August app". ``curl http://127.0.0.1:8085/api/subagents/spawn`` works
from any program on the machine, and so does a model that has ``run_command``
and can reach loopback. A model that could call those routes could start a
worker fleet outside the tool restrictions of its turn, or approve a harness
proposal it had itself proposed — which is the self-correction loop closing
on itself.

So those routes require a per-install token. The desktop shell generates it
(``backend.rs::local_api_token``), hands it to the backend through
``AUGUST_LOCAL_API_TOKEN`` in the environment, and hands it to the webview
through the Tauri IPC. Neither channel is reachable by another local process:
the IPC is bound to the webview, and another process cannot read this
process's environment on Windows without process-access rights.

The token is deliberately **not** written to disk. A file under the app's data
directory would be readable by a model with ``run_command``, which is exactly
the threat this exists to stop.

When the backend is not running under the desktop shell — Docker, a bare
``uvicorn app.main:app``, the mobile app — there is no token and therefore
nothing to check, and the routes behave as they always have. The gate is
therefore a no-op outside the desktop app by construction, and not by a flag
someone can forget to set.
"""

from __future__ import annotations

import hmac
import logging
import os

from fastapi import Header, HTTPException

log = logging.getLogger(__name__)

#: The header the desktop shell sends the per-install token in.
LOCAL_AUTH_HEADER = 'X-August-Local-Token'

#: The environment variable the shell passes the token to the backend in.
LOCAL_AUTH_ENV = 'AUGUST_LOCAL_API_TOKEN'


def _expected_token() -> str:
    return (os.environ.get(LOCAL_AUTH_ENV) or '').strip()


def local_token_configured() -> bool:
    """True when the backend is running under the desktop shell."""
    return bool(_expected_token())


async def require_local_token(
    x_august_local_token: str | None = Header(default=None, alias=LOCAL_AUTH_HEADER),
) -> bool:
    """FastAPI dependency protecting the sensitive local routes.

    No token configured → the backend is not under the desktop shell, so
    there is nothing to check and the route behaves as before.

    A token configured and the header missing or wrong → 401. The message
    names the header, because the failure mode of getting this wrong is the
    SPA silently not working, and a vague 401 sends whoever is debugging it
    looking in the wrong place.
    """
    expected = _expected_token()
    if not expected:
        return True
    if not x_august_local_token:
        raise HTTPException(
            status_code=401,
            detail={
                'code': 'local_token_missing',
                'message': (
                    'This endpoint requires the desktop shell. Send the '
                    f'{LOCAL_AUTH_HEADER} header, or run the backend without the '
                    f'{LOCAL_AUTH_ENV} environment variable.'
                ),
            },
        )
    if not hmac.compare_digest(x_august_local_token, expected):
        raise HTTPException(
            status_code=401,
            detail={
                'code': 'local_token_invalid',
                'message': f'The {LOCAL_AUTH_HEADER} header is not valid for this install.',
            },
        )
    return True
