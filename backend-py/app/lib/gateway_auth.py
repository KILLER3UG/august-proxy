"""
Gateway authentication — protect external proxy endpoints behind a Bearer key.

The August Proxy exposes two surfaces:

  1. ``/api/*``         — management API used by the local SPA (no auth).
  2. ``/v1/*``          — OpenAI/Anthropic-compatible proxy endpoint intended
                          for external clients (Claude Code, OpenAI SDKs,
                          Cursor, etc.).

When the user enables external access (``gateway.externalAccess.enabled``
in ``config.json``) we gate the proxy endpoints with the ``GATEWAY_API_KEY``
env var. Same-origin SPA traffic is unaffected because it doesn't hit
``/v1/*``.

    Disabled → 403 on /v1/* (closed)
    Enabled + no key  → 503 (proxy misconfigured)
    Enabled + header missing/wrong → 401
    Enabled + valid key → request is forwarded upstream
"""
from __future__ import annotations
import logging
from fastapi import Header, HTTPException
from app.config import settings
log = logging.getLogger(__name__)


def _emit_security(code: str, message: str) -> None:
    """Surface gateway auth failures in the Backend Monitor (security category)."""
    try:
        from app.services import logger as _tl
        _tl.emitLogEvent({'category': 'security', 'level': 'warn', 'message': f'Gateway auth rejected: {code}', 'metadata': {'code': code, 'detail': message}})
    except Exception:
        pass

def _external_access_enabled() -> bool:
    """Return True when the user has opted-in to external proxy access."""
    try:
        cfg = settings.config or {}
    except Exception:
        return False
    gw = cfg.get('gateway', {}) or {}
    ea = gw.get('externalAccess', {}) or {}
    return bool(ea.get('enabled', False))

async def require_gateway_key(authorization: str | None=Header(default=None)) -> bool:
    """FastAPI dependency that protects ``/v1/*`` proxy endpoints.

    When external access is disabled the gateway is closed and we reject the
    request with ``403``. When enabled we require a Bearer token matching
    ``settings.gatewayApiKey`` (which is bound to the ``GATEWAY_API_KEY``
    env var by ``pydantic-settings``).
    """
    if not _external_access_enabled():
        _emit_security('external_access_disabled', 'External API access is disabled.')
        raise HTTPException(status_code=403, detail={'code': 'external_access_disabled', 'message': 'External API access is disabled. Enable it in Settings → API Access.'})
    key = settings.gatewayApiKey
    if not key:
        log.warning('gateway: external access enabled but GATEWAY_API_KEY is not set')
        _emit_security('gateway_key_unconfigured', 'GATEWAY_API_KEY is not configured.')
        raise HTTPException(status_code=503, detail={'code': 'gateway_key_unconfigured', 'message': 'Gateway is enabled but GATEWAY_API_KEY is not configured on the server.'})
    if not authorization:
        _emit_security('auth_missing', 'Missing Authorization header.')
        raise HTTPException(status_code=401, detail={'code': 'auth_missing', 'message': 'Missing Authorization header. Send: Authorization: Bearer <GATEWAY_API_KEY>'}, headers={'WWW-Authenticate': 'Bearer'})
    scheme, __, token = authorization.partition(' ')
    if scheme.lower() != 'bearer' or not token:
        _emit_security('auth_invalid_format', 'Authorization header must be: Bearer <key>.')
        raise HTTPException(status_code=401, detail={'code': 'auth_invalid_format', 'message': 'Authorization header must be: Bearer <key>'}, headers={'WWW-Authenticate': 'Bearer'})
    if token != key:
        _emit_security('auth_invalid_key', 'Invalid API key.')
        raise HTTPException(status_code=401, detail={'code': 'auth_invalid_key', 'message': 'Invalid API key.'}, headers={'WWW-Authenticate': 'Bearer'})
    return True