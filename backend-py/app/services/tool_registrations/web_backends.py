"""Pluggable web search backends (DuckDuckGo / Brave / SearXNG)."""

from __future__ import annotations

import logging
from typing import Any

from app.json_narrowing import as_str
from app.services.web_config_service import get_web_config, resolve_search_backend

logger = logging.getLogger(__name__)


class SearchBackendError(Exception):
    """Raised when a backend cannot return results."""


def _normalize_hits(
    raw: list[dict[str, Any]], *, title_key: str, url_key: str, snippet_key: str
) -> list[dict[str, object]]:
    out: list[dict[str, object]] = []
    for i, r in enumerate(raw):
        if not isinstance(r, dict):
            continue
        title = as_str(r.get(title_key), '').strip()
        url = as_str(r.get(url_key), '').strip()
        snippet = as_str(r.get(snippet_key), '').strip()
        if title and url:
            out.append({'index': i + 1, 'title': title, 'url': url, 'snippet': snippet})
    return out


def search_ddgs(query: str, max_results: int) -> list[dict[str, object]]:
    from ddgs import DDGS

    with DDGS() as ddgs:
        raw = list(ddgs.text(query, max_results=max_results))
    return _normalize_hits(raw, title_key='title', url_key='href', snippet_key='body')


async def search_brave(query: str, max_results: int, api_key: str) -> list[dict[str, object]]:
    import httpx

    if not api_key:
        raise SearchBackendError('Brave Search requires BRAVE_SEARCH_API_KEY or auxiliary.web.braveApiKey')
    headers = {
        'Accept': 'application/json',
        'X-Subscription-Token': api_key,
    }
    params = {'q': query, 'count': min(max_results, 20)}
    async with httpx.AsyncClient(timeout=12.0) as client:
        resp = await client.get(
            'https://api.search.brave.com/res/v1/web/search',
            headers=headers,
            params=params,
        )
        resp.raise_for_status()
        data = resp.json()
    web = data.get('web') if isinstance(data, dict) else None
    results = web.get('results') if isinstance(web, dict) else None
    if not isinstance(results, list):
        return []
    return _normalize_hits(results, title_key='title', url_key='url', snippet_key='description')


async def search_searxng(query: str, max_results: int, base_url: str) -> list[dict[str, object]]:
    import httpx

    if not base_url:
        raise SearchBackendError('SearXNG requires SEARXNG_URL or auxiliary.web.searxngUrl')
    url = base_url.rstrip('/') + '/search'
    params = {'q': query, 'format': 'json'}
    async with httpx.AsyncClient(timeout=12.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()
    results = data.get('results') if isinstance(data, dict) else None
    if not isinstance(results, list):
        return []
    hits = _normalize_hits(results[:max_results], title_key='title', url_key='url', snippet_key='content')
    return hits


async def run_search(
    query: str,
    max_results: int = 10,
    *,
    backend: str | None = None,
) -> tuple[str, list[dict[str, object]]]:
    """Execute search. Returns ``(backend_id, results)``."""
    cfg = get_web_config()
    bid = (backend or resolve_search_backend(cfg)).strip().lower()
    if bid == 'brave':
        hits = await search_brave(query, max_results, as_str(cfg.get('braveApiKey')))
        return bid, hits
    if bid == 'searxng':
        hits = await search_searxng(query, max_results, as_str(cfg.get('searxngUrl')))
        return bid, hits
    # ddgs is sync (thread); caller wraps with executor + timeout
    hits = search_ddgs(query, max_results)
    return 'ddgs', hits


async def duckduckgo_instant_answer(query: str) -> dict[str, object] | None:
    """Fallback abstract when a backend returns zero hits."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            ia_resp = await client.get(
                'https://api.duckduckgo.com/',
                params={'q': query, 'format': 'json', 'no_html': '1', 'skip_disambig': '1'},
            )
            ia_resp.raise_for_status()
            ia_data = ia_resp.json()
        abstract = as_str(ia_data.get('Abstract'), '')
        if not abstract:
            return None
        return {
            'search_query': query,
            'result_count': 0,
            'abstract': abstract,
            'source': as_str(ia_data.get('AbstractURL'), ''),
        }
    except Exception:
        return None
