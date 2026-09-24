"""Opt-in provider quota endpoints — user-declared, data-driven, truthful.

Some providers publish no rate-limit headers at all but do expose an account
usage endpoint. August ships no adapters for them (an adapter nobody has
verified against a real response is a made-up number), so the user declares
the endpoint and the JSON paths themselves:

```json
"quotaEndpoint": {
  "url": "https://api.example.com/usage",     // absolute, or relative to baseUrl
  "method": "GET",                             // GET | POST
  "kind": "json",                              // only JSON is supported
  "headers": { "x-tenant": "acme" },           // optional, non-secret
  "body": null,                                // optional JSON body for POST
  "model": "",                                 // optional model id for the reading
  "extract": {                                 // dotted JSON paths
    "model": "data.model",
    "limit": "data.quota.limit",
    "remaining": "data.quota.remaining",
    "used": "data.quota.used",
    "reset": "data.quota.reset_at"
  }
},
"quotaAuth": { "type": "bearer", "useProviderKey": true }
```

Rules that keep this honest:
  * The endpoint is opt-in — absent config means August never calls it.
  * A relative ``url`` is joined onto the provider's baseUrl under the same
    exact-base rule as chat (no invented ``/v1``); an absolute ``url`` is used
    exactly as written.
  * Only paths that resolve to a real number become quota values. A missing
    path means "not stated", never zero, and a reading without a limit is not
    returned at all.
"""

from __future__ import annotations

import logging
import re
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from app.json_narrowing import as_dict, as_str
from app.providers.api_format import join_provider_url
from app.services.quota_observation import BUCKET_GENERIC, QuotaObservation, parse_reset_seconds, quota_observations

logger = logging.getLogger(__name__)

# Only one wire shape is supported. Adding a second kind means adding a real
# parser for it, not guessing at one.
QuotaEndpointKind = Literal['json']
_QUOTA_ENDPOINT_KINDS: frozenset[str] = frozenset({'json'})

# This runs inside the quota read path, so a hung provider must not hold the
# UI hostage.
_QUOTA_FETCH_TIMEOUT_S = 8.0

_TOKEN_RE = re.compile(r'([^.\[\]]+)|\[(\d+)\]')

_AUTH_TYPES = frozenset({'none', 'bearer', 'header', 'query'})


def _flag(value: object, default: bool) -> bool:
    """Tolerant boolean for hand-edited config (``"true"`` counts as true)."""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    text = as_str(value).strip().lower()
    if text in ('1', 'true', 'yes', 'on'):
        return True
    if text in ('0', 'false', 'no', 'off'):
        return False
    return default


def normalize_quota_endpoint_kind(value: object) -> QuotaEndpointKind | None:
    """Canonical quota endpoint kind, or None when unsupported/unspecified."""
    kind = as_str(value).strip().lower()
    if not kind:
        return None
    return kind if kind in _QUOTA_ENDPOINT_KINDS else None  # type: ignore[return-value]


def quota_endpoint_config(entry: dict) -> dict:
    """The quotaEndpoint block of a provider store entry (camel or snake)."""
    row = as_dict(entry)
    return as_dict(row.get('quotaEndpoint') or row.get('quota_endpoint'))


def quota_auth_config(entry: dict) -> dict:
    """The quotaAuth block of a provider store entry (camel or snake)."""
    row = as_dict(entry)
    return as_dict(row.get('quotaAuth') or row.get('quota_auth'))


def is_quota_endpoint_enabled(entry: dict) -> bool:
    """True only when a usable, opt-in endpoint is declared."""
    config = quota_endpoint_config(entry)
    if normalize_quota_endpoint_kind(config.get('kind', 'json')) is None:
        return False
    return bool(as_str(config.get('url')).strip())


def resolve_quota_url(base_url: str, endpoint: dict) -> str:
    """Absolute URLs are used verbatim; relative paths join the exact base.

    Same rule as every other provider call: August never invents ``/v1`` on a
    base the user pasted, so ``usage`` against a base ending in ``/v1`` hits
    ``…/v1/usage``. Paste the full path when the host wants it elsewhere.
    """
    url = as_str(endpoint.get('url')).strip()
    if not url:
        return ''
    if url.startswith('http://') or url.startswith('https://'):
        return url
    return join_provider_url(base_url, url)


def _auth_token(auth: dict, api_key: str) -> str:
    explicit = as_str(auth.get('token')).strip()
    if explicit:
        return explicit
    return api_key if _flag(auth.get('useProviderKey'), True) else ''


def build_quota_headers(entry: dict, *, api_key: str = '') -> dict[str, str]:
    """Headers for the declared quota endpoint.

    ``quotaAuth`` is opt-in per provider. ``useProviderKey`` (the default when
    a type is declared) reuses the provider's stored key; ``header`` +
    ``prefix`` sends it under a custom name instead.
    """
    endpoint = quota_endpoint_config(entry)
    auth = quota_auth_config(entry)
    authType = as_str(auth.get('type')).strip().lower()
    headers = {'Accept': 'application/json'}
    for name, value in as_dict(endpoint.get('headers')).items():
        key = as_str(name).strip()
        if key:
            headers[key] = as_str(value)
    if authType and authType != 'none' and authType in _AUTH_TYPES:
        token = _auth_token(auth, api_key)
        if token:
            if authType == 'bearer':
                headers['Authorization'] = f'Bearer {token}'
            elif authType == 'header':
                name = as_str(auth.get('header')).strip()
                if name:
                    headers[name] = f'{as_str(auth.get("prefix"))}{token}'
    return headers


def apply_query_auth(url: str, auth: dict, *, api_key: str = '') -> str:
    """Append a query-parameter credential for ``quotaAuth.type == 'query'``."""
    if as_str(auth.get('type')).strip().lower() != 'query' or not url:
        return url
    param = as_str(auth.get('param')).strip()
    token = _auth_token(auth, api_key)
    if not param or not token:
        return url
    parsed = urlparse(url)
    query = urlencode([*parse_qsl(parsed.query), (param, token)])
    return urlunparse(parsed._replace(query=query))


def _path_tokens(path: str) -> list[str | int]:
    """``data.items[0].limit`` → ``['data', 'items', 0, 'limit']``."""
    tokens: list[str | int] = []
    for match in _TOKEN_RE.finditer(path):
        key, index = match.group(1), match.group(2)
        if key:
            tokens.append(key)
        elif index is not None:
            tokens.append(int(index))
    return tokens


def extract_path(payload: object, path: str) -> object:
    """Read a dotted/indexed path out of a decoded JSON body.

    None for any miss: a path that does not resolve means the provider did not
    state that value, which is different from stating zero.
    """
    text = as_str(path).strip()
    if not text:
        return None
    current: object = payload
    for token in _path_tokens(text):
        if isinstance(token, int):
            if not isinstance(current, list) or token >= len(current):
                return None
            current = current[token]
        else:
            if not isinstance(current, dict) or token not in current:
                return None
            current = current[token]
    return current


def _number(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = as_str(value).strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def extract_quota(endpoint: dict, *, provider: str, model: str = '') -> QuotaObservation | None:
    """Turn an already-fetched JSON body into a stored observation.

    Split from the fetch so the extractor contract is testable without a
    network. ``endpoint['_payload']`` carries the decoded body. Returns None
    when the payload states neither a limit nor a used count — August then has
    no quota to show and says so instead of reporting a fabricated cap.
    """
    payload = endpoint.get('_payload')
    if payload is None:
        return None
    extractors = as_dict(endpoint.get('extract'))
    limit = _number(extract_path(payload, as_str(extractors.get('limit'))))
    remaining = _number(extract_path(payload, as_str(extractors.get('remaining'))))
    used = _number(extract_path(payload, as_str(extractors.get('used'))))
    if remaining is None and used is not None and limit is not None:
        remaining = max(0.0, limit - used)
    if limit is None and used is None:
        return None
    if limit is None and remaining is not None:
        limit = remaining + used if used is not None else None
    resetRaw = extract_path(payload, as_str(extractors.get('reset')))
    modelId = as_str(extract_path(payload, as_str(extractors.get('model')))).strip() or as_str(model).strip()
    return quota_observations.record(
        provider=provider,
        model=modelId,
        bucket=as_str(endpoint.get('bucket')).strip() or BUCKET_GENERIC,
        limit=limit,
        remaining=remaining,
        reset_at=parse_reset_seconds(resetRaw) if resetRaw is not None else None,
    )


async def fetch_provider_quota(
    entry: dict,
    *,
    provider_name: str = '',
    base_url: str = '',
    api_key: str = '',
) -> QuotaObservation | None:
    """Fetch a declared quota endpoint and store what it states.

    Opt-in only: an entry without a usable ``quotaEndpoint`` returns None
    without touching the network. Any failure (unreachable, non-JSON, a path
    that does not resolve) is a None return, never a partial or guessed value
    — the caller keeps showing the local estimate.
    """
    endpoint = quota_endpoint_config(entry)
    if not is_quota_endpoint_enabled(entry):
        return None
    url = apply_query_auth(
        resolve_quota_url(base_url, endpoint), quota_auth_config(entry), api_key=api_key
    )
    if not url:
        return None
    method = as_str(endpoint.get('method'), 'GET').strip().upper() or 'GET'
    if method not in ('GET', 'POST'):
        logger.warning('quotaEndpoint: unsupported method %r — skipping', method)
        return None
    headers = build_quota_headers(entry, api_key=api_key)
    body = as_dict(endpoint.get('body')) or None
    try:
        import httpx

        async with httpx.AsyncClient(timeout=_QUOTA_FETCH_TIMEOUT_S, follow_redirects=True) as client:
            resp = await client.request(method, url, headers=headers, json=body if method == 'POST' else None)
        if resp.status_code >= 400:
            logger.debug('quotaEndpoint %s → HTTP %s', url, resp.status_code)
            return None
        payload = resp.json()
    except Exception as exc:
        logger.debug('quotaEndpoint %s failed: %s', url, exc)
        return None
    return extract_quota(
        {**endpoint, '_payload': payload},
        provider=provider_name or as_str(as_dict(entry).get('name')),
        model=as_str(endpoint.get('model')),
    )


__all__ = [
    'QuotaEndpointKind',
    'apply_query_auth',
    'build_quota_headers',
    'extract_path',
    'extract_quota',
    'fetch_provider_quota',
    'is_quota_endpoint_enabled',
    'normalize_quota_endpoint_kind',
    'quota_auth_config',
    'quota_endpoint_config',
    'resolve_quota_url',
]
