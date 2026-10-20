"""Authentication for the backend's local routes.

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

---

## The scope of the token, and WHY it is this wide

The trusted-origin guard (``app/lib/local_api_guard.py``) is **not** a
security boundary for the LAN, and the difference matters:

* a request carrying neither ``Origin`` nor ``Sec-Fetch-Site`` is a
  non-browser client — curl, an SDK, a script on the next desk — and it
  "passes untouched". That is the guard's own documented rule, and it is
  deliberate;
* so the origin guard stops a **drive-by webpage**. It does not stop a
  **neighbour on the same network**. Those are two different threats, and
  the guard only answers one of them.

Therefore, when LAN access is on, **the per-install token is the boundary**,
and it has to cover the whole management API — not the five routes above.
Those five are the routes that *start work*. They are not the routes that
can *read the user's memory* or *write files*. A neighbour on the LAN
without the token could still GET the brain, the file tree, the session
transcripts and the providers list.

Widening the token is not an extra bolted onto "add a bind address". It is
the thing that makes LAN access safe, and it is the part most likely to be
forgotten by someone who reads "add a bind address" and stops there.

Three cases, not one:

* **no token presented** → 401, and the message names the header;
* **wrong token** → 401, and the message names the header;
* **no ``AUGUST_LOCAL_API_TOKEN`` configured at all** → the backend has
  nothing to check against, so in LAN mode it must **fail closed** (503)
  rather than serve the management API to the network. The startup log says
  so loudly.

With LAN access OFF, none of this applies: today's behaviour is unchanged,
and "no token configured means no gate" still holds by construction.
"""

from __future__ import annotations

import hmac
import ipaddress
import logging
import os

from fastapi import Header, HTTPException
from fastapi.requests import HTTPConnection

from app.lib.lan_access import lan_enabled
from app.lib.local_api_guard import GUARDED_EXACT, GUARDED_PREFIXES, resolve_origins

log = logging.getLogger(__name__)

#: The header the desktop shell sends the per-install token in.
LOCAL_AUTH_HEADER = 'X-August-Local-Token'

#: The environment variable the shell passes the token to the backend in.
LOCAL_AUTH_ENV = 'AUGUST_LOCAL_API_TOKEN'

#: Routes that stay OPEN even in LAN mode. Named, and each one justified:
#:
#: ``/api/health``
#:     It says "August is here" — status, version, port, uptime. It does not
#:     say "here is your brain". It is also what the desktop supervisor polls
#:     to decide the backend is alive (identity-checked, no credential) and
#:     what a phone polls to learn the LAN address, so it has to answer
#:     before anyone has a token in hand.
#:
#: Nothing else is open. Everything under ``/api/`` and ``/mcp/`` needs the
#: token from the network.
LAN_OPEN_PATHS = frozenset({'/api/health'})


def _expected_token() -> str:
    return (os.environ.get(LOCAL_AUTH_ENV) or '').strip()


def local_token_configured() -> bool:
    """True when the backend is running under the desktop shell."""
    return bool(_expected_token())


def _is_management_path(path: str) -> bool:
    """True for the paths the token gate covers.

    The same surface the origin guard covers: the management API under
    ``/api/`` and ``/mcp/``. ``/v1/*`` is deliberately absent — it is the
    *external* proxy, closed by default and gated by the gateway bearer key
    (``app/lib/gateway_auth.py``), and it is not the management API.
    """
    if path in GUARDED_EXACT:
        return True
    return any(path.startswith(prefix) for prefix in GUARDED_PREFIXES)


def _is_websocket(conn: HTTPConnection) -> bool:
    """True for a WebSocket handshake rather than an HTTP request."""
    return str(conn.scope.get('type') or '') == 'websocket'


def _has_trusted_origin(conn: HTTPConnection) -> bool:
    """True when the request carries an origin this install already trusts.

    A browser ALWAYS sends ``Origin`` — on a cross-origin request and on a
    WebSocket handshake — so it is the credential the WebSocket doors can
    use. It is checked against the ONE allowlist (``resolve_origins()``),
    which is the same list the CORS middleware and the origin guard read,
    so the socket door and the HTTP door can never disagree about who is
    trusted.

    A script can forge an ``Origin`` header. That is the residual hole and
    it is the same one the origin guard has always had: the guard stops a
    drive-by webpage, not a determined script. The token is what stops the
    script, and a socket has to present one of the two.
    """
    origin = (conn.headers.get('origin') or '').strip()
    if not origin:
        return False
    return origin.rstrip('/').lower() in resolve_origins()


def _is_loopback_peer(conn: HTTPConnection) -> bool:
    """True when the request arrived over the loopback interface.

    This is the ONE exemption the LAN gate makes, and it is a transport
    fact, not a header: a TCP peer cannot forge a loopback source address.
    A request that arrives this way came from a program on THIS machine —
    the desktop shell, or another local program — which is exactly the
    client population the management API has always served without a
    credential, and the population the five per-install-token routes above
    were written to constrain (they keep their own per-route requirement,
    from every peer, loopback included).

    It has to be an exemption. The desktop shell's own workbench surface
    does not send the token: ``api/workbench/stream.ts`` and
    ``api/workbench.ts`` call ``fetch()`` directly, and only
    ``api/client.ts`` attaches the header. Requiring the token from
    loopback would break the chat, BTW and brain-config surfaces of the
    user's own app the moment LAN access was switched on.

    The token's job in LAN mode is to authenticate the NETWORK — the new
    exposure the owner opted into. It is not a redesign of the local trust
    model, and it must not become one by accident.
    """
    client = conn.client
    if not client:
        # No peer information (an in-process call, an unusual ASGI server):
        # assume the network and require the token.
        return False
    host = getattr(client, 'host', None) or ''
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


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


async def require_lan_token(conn: HTTPConnection) -> bool:
    """The GLOBAL gate: in LAN mode the whole management API needs the token.

    Installed as an app-level dependency (``FastAPI(dependencies=[...])``),
    so it covers every management route without editing hundreds of
    route signatures.

    It is a no-op when LAN access is off, which is what keeps the property
    that Docker, a bare ``uvicorn`` and the mobile app depend on: **no
    token configured means no gate, by construction**.

    The two WebSocket doors are the one exception, and the reason is a fact
    about browsers rather than a choice: **a browser's WebSocket handshake
    cannot carry a custom header.** The terminal socket
    (``/api/terminal/connect``) writes to the user's shell on every frame
    and the log stream (``/api/logs/stream``) leaks prompt bodies, so they
    are exactly the doors that must NOT be open to the network — and they
    are also the doors a phone could never authenticate to, because its
    WebView cannot present the token. Gating them on the token would leave
    the phone with no terminal and no log stream.

    So a socket from the network must present EITHER the token (a
    non-browser client CAN set a header on a handshake — only a BROWSER
    cannot) OR a trusted browser origin. A socket with neither is refused.
    A script that FORGES a trusted origin is the residual hole, and it is
    the same trust the origin guard has always given a browser request: the
    origin guard stops a drive-by webpage, not a determined script.
    """
    if not lan_enabled():
        return True
    path = str(conn.scope.get('path') or '')
    if not _is_management_path(path):
        return True
    if path in LAN_OPEN_PATHS:
        return True
    if _is_loopback_peer(conn):
        return True

    expected = _expected_token()
    if not expected:
        # Fail CLOSED. The backend was told to be reachable from the network
        # and has no credential to check against, so the network gets
        # nothing. Serving it anyway would be the worst possible reading of
        # "opt-in LAN access".
        log.error(
            'lan: LAN access is ON but %s is not set — refusing every management-API '
            'request from the network',
            LOCAL_AUTH_ENV,
        )
        raise HTTPException(
            status_code=503,
            detail={
                'code': 'local_token_unconfigured',
                'message': (
                    'LAN access is enabled but this backend has no per-install token '
                    f'configured, so the management API cannot be authenticated. Set '
                    f'{LOCAL_AUTH_ENV}, or turn LAN access off.'
                ),
            },
        )

    presented = (conn.headers.get(LOCAL_AUTH_HEADER) or '').strip()
    if presented:
        if hmac.compare_digest(presented, expected):
            return True
        raise HTTPException(
            status_code=401,
            detail={
                'code': 'local_token_invalid',
                'message': (
                    f'The {LOCAL_AUTH_HEADER} header is not valid for this install.'
                ),
            },
        )

    # No token at all.
    if _is_websocket(conn) and _has_trusted_origin(conn):
        return True
    if _is_websocket(conn):
        raise HTTPException(
            status_code=401,
            detail={
                'code': 'local_token_missing',
                'message': (
                    'This WebSocket requires the per-install token or a trusted browser '
                    f'origin. Send the {LOCAL_AUTH_HEADER} header, or open the page from '
                    'the address August reports.'
                ),
            },
        )
    raise HTTPException(
        status_code=401,
        detail={
            'code': 'local_token_missing',
            'message': (
                'LAN access is enabled, so this endpoint requires the per-install '
                f'token. Send the {LOCAL_AUTH_HEADER} header.'
            ),
        },
    )
