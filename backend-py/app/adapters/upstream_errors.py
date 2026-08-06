"""Upstream error normalization for the /v1 proxy adapters.

Upstream failure bodies come in many shapes (OpenAI ``{"error": {...}}``,
Anthropic ``{"type": "error", "error": {...}}``, plain text, FastAPI-style
``{"detail": ...}``). Before this module, adapters returned those raw bodies
as success — the router saw no top-level ``error`` key and answered HTTP 200
with an error payload. ``normalize_upstream_error`` always produces the
router-friendly ``{error, type, status}`` shape so ``_endNonStream`` can
surface a real non-2xx response.
"""

from __future__ import annotations

from app.json_narrowing import as_dict, as_str


class UpstreamError(Exception):
    """Raised by adapter internals when an upstream call fails.

    Carries the failed :class:`ProviderResponse` so the adapter boundary can
    normalize it into the router error shape at the right layer.
    """

    def __init__(self, resp: object) -> None:
        super().__init__(f'Upstream request failed (HTTP {getattr(resp, "status", 0)})')
        self.resp = resp


def normalize_upstream_error(resp: object) -> dict[str, object]:
    """Build a router-friendly ``{error, type, status}`` dict from a failure.

    Always returns a dict with an ``error`` key — never raises — so the
    router's ``_endNonStream`` error branch reliably fires.
    """
    status = getattr(resp, 'status', None) or 502
    try:
        status = int(status)
    except (TypeError, ValueError):
        status = 502
    body = as_dict(getattr(resp, 'body_json', None), {})
    # Direct {error: ...} (OpenAI) or {type: error, error: {...}} (Anthropic)
    if 'error' in body:
        err = body['error']
        if isinstance(err, dict):
            message = as_str(err.get('message'), '') or as_str(err.get('type'), '')
        else:
            message = as_str(err)
        return {
            'error': message or 'Upstream request failed',
            'type': 'error',
            'status': status,
        }
    if as_str(body.get('type'), '') == 'error':
        return {'error': 'Upstream request failed', 'type': 'error', 'status': status}
    # Plain-text error bodies (gateways that do not speak JSON errors)
    raw = getattr(resp, 'body', None)
    if isinstance(raw, str) and raw.strip():
        return {'error': raw.strip()[:500], 'type': 'error', 'status': status}
    return {'error': f'Upstream request failed (HTTP {status})', 'type': 'error', 'status': status}
