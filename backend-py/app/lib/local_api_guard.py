"""
Trusted-origin guard for the local management API.

The FastAPI app binds 127.0.0.1, so other *machines* cannot reach it. That
does not stop the more realistic local vector: any webpage open in any browser
on this machine can fire a cross-origin POST at ``http://127.0.0.1:<port>``.
CORS only stops that page from *reading* the response — it never stops the
request from being executed, and several ``/api/*`` routes have observable
side effects (desktop input synthesis, MCP server registration, hook reload,
memory purge, process restart).

The rule this enforces:

  * a request carrying an ``Origin`` header must present one the app already
    trusts — the same allowlist that makes CORS work for the Tauri webview;
  * a request with no ``Origin`` but a ``Sec-Fetch-Site`` that claims a
    cross-site or cross-origin relationship is rejected the same way;
  * requests with neither are non-browser clients (curl, SDKs, the test
    suite, ``/v1/*`` proxy consumers) and pass untouched.

Applied as a pure ASGI middleware rather than an ``http`` middleware so that
WebSocket upgrades (``/api/logs/stream``, the terminal bridge) are covered too
— those are the endpoints where an unauthenticated socket is worst, since a
live log stream leaks prompt bodies.

``OPTIONS`` preflights are passed through: CORSMiddleware is mounted outside
this guard and answers them, and a preflight carries no authority to act on.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

__all__ = ['TrustedOriginGuard', 'trusted_origins']

# Surfaces that act on the user's machine or data. `/v1/*` is deliberately
# absent: it is the *external* proxy, gated by the gateway bearer key.
GUARDED_PREFIXES = ('/api/', '/mcp/')
GUARDED_EXACT = frozenset({'/api', '/mcp'})

# `same-origin` and `none` are what the webview and non-fetch callers produce.
# `same-site`/`cross-site` are the drive-by shapes.
_SAFE_SEC_FETCH_SITES = frozenset({'same-origin', 'same-site', 'none'})

_REJECT_BODY = (
    b'{"detail":"untrusted origin","code":"untrusted_origin",'
    b'"message":"Request came from an origin this August instance does not '
    b'trust. Add it to AUGUST_CORS_ORIGINS if you are a local developer tool."}'
)


def trusted_origins(base_origins: Iterable[str]) -> frozenset[str]:
    """Normalize the CORS allowlist into a comparison set.

    Compared case-insensitively and without a trailing slash, because the
    scheme Tauri reports differs per platform (`tauri://localhost` on
    macOS/Linux, `http://tauri.localhost` on Windows).
    """
    out = set()
    for raw in base_origins:
        value = (raw or '').strip().rstrip('/').lower()
        if value:
            out.add(value)
    return frozenset(out)


def _header(scope: dict[str, Any], name: bytes) -> str | None:
    for key, value in scope.get('headers') or ():
        if key == name:
            return value.decode('latin-1')
    return None


class TrustedOriginGuard:
    """ASGI middleware rejecting management-API calls from foreign origins."""

    def __init__(self, app: Any, origins_provider: Callable[[], frozenset[str]]) -> None:
        self.app = app
        # Resolved per request: `AUGUST_CORS_ORIGINS` and the listening port
        # are both known to change between dev and packaged boots.
        self._origins_provider = origins_provider

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        scope_type = scope.get('type')
        if scope_type not in ('http', 'websocket'):
            await self.app(scope, receive, send)
            return

        path = str(scope.get('path') or '')
        if not self._is_guarded(path):
            await self.app(scope, receive, send)
            return

        if scope_type == 'http' and str(scope.get('method', '')).upper() == 'OPTIONS':
            await self.app(scope, receive, send)
            return

        origin = _header(scope, b'origin')
        if origin is not None:
            normalized = origin.strip().rstrip('/').lower()
            if normalized and normalized not in self._origins_provider():
                await self._reject(scope, receive, send, origin=normalized)
                return
        else:
            site = (_header(scope, b'sec-fetch-site') or '').strip().lower()
            if site and site not in _SAFE_SEC_FETCH_SITES:
                await self._reject(scope, receive, send, origin=f'sec-fetch-site:{site}')
                return

        await self.app(scope, receive, send)

    @staticmethod
    def _is_guarded(path: str) -> bool:
        if path in GUARDED_EXACT:
            return True
        # Query-less prefix test; `/apifoo` must not match `/api/`.
        return any(path.startswith(prefix) for prefix in GUARDED_PREFIXES)

    async def _reject(
        self, scope: dict[str, Any], receive: Any, send: Any, *, origin: str
    ) -> None:
        self._log(scope, origin)
        if scope.get('type') == 'websocket':
            # 4403 is the conventional "forbidden" close for a rejected
            # handshake; Starlette surfaces it as an HTTP 403 to the client.
            await send({'type': 'websocket.close', 'code': 4403, 'reason': 'untrusted origin'})
            return
        await send(
            {
                'type': 'http.response.start',
                'status': 403,
                'headers': [
                    (b'content-type', b'application/json'),
                    (b'content-length', str(len(_REJECT_BODY)).encode('latin-1')),
                    (b'cache-control', b'no-store'),
                ],
            }
        )
        await send({'type': 'http.response.body', 'body': _REJECT_BODY})

    @staticmethod
    def _log(scope: dict[str, Any], origin: str) -> None:
        """Mirror the rejection into the Backend Monitor's security category.

        A blocked drive-by is the event a user needs to see; without this it
        is invisible and looks like a broken third-party integration.
        """
        try:
            from app.services import logger as _tl

            _tl.emitLogEvent(
                {
                    'category': 'security',
                    'level': 'warn',
                    'message': f'Blocked cross-origin management-API call: {origin}',
                    'metadata': {'code': 'untrusted_origin', 'origin': origin},
                }
            )
        except Exception:
            pass


def resolve_origins() -> frozenset[str]:
    """The allowlist CORS already uses, plus anything the operator adds.

    Kept in one place so CORS and this guard can never disagree: an origin
    allowed to read responses must be allowed to make requests.
    """
    from app.main import _cors_allow_origins

    return trusted_origins(_cors_allow_origins())
