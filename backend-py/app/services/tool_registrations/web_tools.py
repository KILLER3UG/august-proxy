"""Web search/fetch and headless browser tool handlers + registration.

``web_search`` returns ranked snippets only (Hermes/Claude cite-then-fetch).
``web_fetch`` downloads a chosen URL with timeouts, body caps, and optional
Hermes-style aux compression for long pages.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Awaitable, Callable

from app.json_narrowing import as_float, as_str
from app.services import tool_registry
from app.services.tool_html import html_to_markdown, unescape_html
from app.services.tool_registrations.web_backends import (
    SearchBackendError,
    duckduckgo_instant_answer,
    run_search,
    search_ddgs,
)
from app.services.tool_registrations.web_extract_compress import (
    maybe_compress_page,
    strip_fetch_envelope,
)
from app.services.web_config_service import get_web_config, resolve_search_backend

# Private aliases for minimal churn (match prior tool_definitions aliases)
_htmlToMarkdown = html_to_markdown
_unescapeHtml = unescape_html

_SEARCH_TIMEOUT_S = 12.0
_FETCH_BODY_CAP_BYTES = 200_000
_WEB_FETCH_MARKDOWN_MAX = 500_000  # pre-compress cap; compress may shrink further
_DEFAULT_FETCH_TIMEOUT_S = 15.0

# Dedicated pool so a stuck DDGS thread cannot starve the default executor.
_search_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='web-search')

ProgressCb = Callable[[str, dict[str, object] | None], Awaitable[None] | None]


async def _emit_progress(
    on_progress: ProgressCb | None, phase: str, meta: dict[str, object] | None = None
) -> None:
    if not on_progress:
        return
    try:
        result = on_progress(phase, meta)
        if asyncio.iscoroutine(result):
            await result
    except Exception:
        pass


async def _fetchUrlContent(url: str, maxLength: int = 50000, timeout_s: float = 30.0) -> str:
    """Fetch a URL and return its content as Markdown (no aux compress)."""
    import httpx

    blockedPrefixes = [
        'http://localhost',
        'http://127.0.0.1',
        'http://10.',
        'http://172.16.',
        'http://192.168.',
        'https://localhost',
    ]
    if any((url.startswith(prefix) for prefix in blockedPrefixes)):
        return f'Error: Private/local network addresses are blocked: {url}'
    try:
        timeout = httpx.Timeout(timeout_s, connect=min(5.0, timeout_s))
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(
                url,
                headers={
                    'User-Agent': 'August-Proxy/1.0',
                    'Accept': 'text/html,text/markdown,text/plain,*/*',
                },
            )
            resp.raise_for_status()
            contentType = as_str(resp.headers.get('content-type'), '')
            raw = resp.content[:_FETCH_BODY_CAP_BYTES]
            text = raw.decode(resp.encoding or 'utf-8', errors='replace')
            if 'text/html' in contentType:
                loop = asyncio.get_running_loop()
                text = await loop.run_in_executor(_search_pool, _htmlToMarkdown, text)
            return f'URL: {url}\nStatus: {resp.status_code}\n\n{text[:maxLength]}'
    except httpx.TimeoutException:
        return f'Error: Timed out fetching {url}'
    except httpx.HTTPStatusError as exc:
        return f'Error: HTTP {exc.response.status_code} fetching {url}'
    except httpx.RequestError as exc:
        return f'Error: Request failed: {exc}'
    except Exception as exc:
        return f'Error: {exc}'


async def _webFetch(
    url: str,
    on_progress: ProgressCb | None = None,
) -> str:
    """Fetch a URL as Markdown; compress long pages via aux model when configured."""
    cfg = get_web_config()
    timeout_s = as_float(cfg.get('fetchTimeoutS'), _DEFAULT_FETCH_TIMEOUT_S)
    if timeout_s <= 0:
        timeout_s = _DEFAULT_FETCH_TIMEOUT_S

    await _emit_progress(
        on_progress,
        'reading',
        {'paths': [url], 'path': url, 'message': f'Fetching {url}…'},
    )
    content = await _fetchUrlContent(
        url, maxLength=_WEB_FETCH_MARKDOWN_MAX, timeout_s=timeout_s
    )
    if content.startswith('Error:'):
        await _emit_progress(on_progress, 'error', {'path': url, 'message': content[:200]})
        return content

    header, body = strip_fetch_envelope(content)
    compressed, meta = await maybe_compress_page(url, body)
    mode = as_str(meta.get('mode'), 'raw')
    if mode == 'summarized':
        # maybe_compress_page already includes a URL header
        out = compressed
    elif mode == 'refused':
        out = compressed
    elif header and not compressed.startswith('URL:'):
        out = header + compressed
    else:
        out = compressed if compressed.startswith('URL:') else (header + compressed)

    await _emit_progress(
        on_progress,
        'done',
        {
            'path': url,
            'message': (
                f'Fetched ({mode})'
                if mode != 'raw'
                else f'Fetched {as_str(meta.get("original_chars"), "?")} chars'
            ),
            **{k: v for k, v in meta.items() if k != 'url'},
        },
    )
    return out


async def _webSearch(
    query: str,
    maxResults: int = 10,
    on_progress: ProgressCb | None = None,
) -> str:
    """Search the web and return ranked titles/URLs/snippets only (no page bodies)."""
    import json as _json

    maxResults = min(max(1, int(maxResults or 10)), 20)
    cfg = get_web_config()
    backend = resolve_search_backend(cfg)
    label = {
        'ddgs': 'DuckDuckGo',
        'brave': 'Brave Search',
        'searxng': 'SearXNG',
    }.get(backend, backend)

    await _emit_progress(
        on_progress,
        'reading',
        {'paths': [f'{label} search'], 'message': f'Searching via {label}…'},
    )

    searchResults: list[dict[str, object]] = []
    errorHint: str | None = None
    used_backend = backend

    try:
        if backend == 'ddgs':
            loop = asyncio.get_running_loop()

            def _search() -> list[dict[str, object]]:
                return search_ddgs(query, maxResults)

            try:
                searchResults = await asyncio.wait_for(
                    loop.run_in_executor(_search_pool, _search),
                    timeout=_SEARCH_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                await _emit_progress(on_progress, 'done', {'message': 'Search timed out'})
                return _json.dumps(
                    {
                        'search_query': query,
                        'backend': backend,
                        'result_count': 0,
                        'message': f'{label} search timed out after {_SEARCH_TIMEOUT_S:.0f}s',
                        'error': 'timeout',
                    },
                    ensure_ascii=False,
                )
        else:
            try:
                used_backend, searchResults = await asyncio.wait_for(
                    run_search(query, maxResults, backend=backend),
                    timeout=_SEARCH_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                await _emit_progress(on_progress, 'done', {'message': 'Search timed out'})
                return _json.dumps(
                    {
                        'search_query': query,
                        'backend': backend,
                        'result_count': 0,
                        'message': f'{label} search timed out after {_SEARCH_TIMEOUT_S:.0f}s',
                        'error': 'timeout',
                    },
                    ensure_ascii=False,
                )
    except SearchBackendError as exc:
        errorHint = str(exc)
    except Exception as exc:
        errorHint = str(exc)

    if not searchResults and not errorHint:
        ia = await duckduckgo_instant_answer(query)
        if ia:
            await _emit_progress(on_progress, 'done', {'result_count': 0, 'abstract': True})
            ia['backend'] = used_backend
            return _json.dumps(ia, ensure_ascii=False)

    if not searchResults:
        msg = errorHint or f'No results found for: {query}'
        await _emit_progress(on_progress, 'done', {'result_count': 0})
        return _json.dumps(
            {
                'search_query': query,
                'backend': used_backend,
                'result_count': 0,
                'message': msg,
            },
            ensure_ascii=False,
        )

    await _emit_progress(
        on_progress,
        'read',
        {'path': f'{label} search', 'message': f'Found {len(searchResults)} results'},
    )
    await _emit_progress(
        on_progress,
        'done',
        {
            'result_count': len(searchResults),
            'message': (
                f'Search complete — {len(searchResults)} snippets via {label}. '
                'Use web_fetch for pages you need to read.'
            ),
        },
    )
    return _json.dumps(
        {
            'search_query': query,
            'backend': used_backend,
            'result_count': len(searchResults),
            'results': searchResults,
            'message': (
                'Snippets only. Call web_fetch or web_fetch_many on URLs you need in depth.'
            ),
        },
        ensure_ascii=False,
    )


def register() -> None:
    """Register web and browser tools."""

    async def _webFetchHandler(url: str, **kwargs: object) -> str:
        on_progress = kwargs.get('on_progress')
        cb = on_progress if callable(on_progress) else None
        return await _webFetch(url, on_progress=cb)  # type: ignore[arg-type]

    tool_registry.register(
        'web_fetch',
        (
            'Fetch a specific public URL and return clean Markdown. '
            'Use after web_search when you need page content — web_search returns snippets only. '
            'Long pages may be summarized to keep context small. '
            'Local/private network addresses are blocked. Prefer web_fetch_many for several URLs.'
        ),
        _webFetchHandler,
        {
            'type': 'object',
            'properties': {'url': {'type': 'string', 'description': 'The URL to fetch.'}},
            'required': ['url'],
        },
    )

    async def _webSearchHandler(query: str, maxResults: int = 10, **kwargs: object) -> str:
        on_progress = kwargs.get('on_progress')
        cb = on_progress if callable(on_progress) else None
        return await _webSearch(query, maxResults=maxResults, on_progress=cb)  # type: ignore[arg-type]

    tool_registry.register(
        'web_search',
        (
            'Search the public web (DuckDuckGo by default; Brave or SearXNG if configured). '
            'Returns ranked titles, URLs, and snippets only — does not download page bodies. '
            'Then call web_fetch / web_fetch_many on the URLs you need. Max 20 results (default 10).'
        ),
        _webSearchHandler,
        {
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'The search query.'},
                'maxResults': {
                    'type': 'integer',
                    'description': 'Maximum results (max 20, default 10).',
                },
            },
            'required': ['query'],
        },
    )
    from app.services.browser import handlers as _browser

    tool_registry.register(
        'browser_open',
        'Open a URL in the headless browser and return the page title plus an interactive-element snapshot (use the [@eN] refs for clicks/types).',
        _browser.browserOpen,
        {
            'type': 'object',
            'properties': {
                'url': {'type': 'string', 'description': 'URL to open.'},
            },
            'required': ['url'],
        },
    )
    tool_registry.register(
        'browser_click',
        'Click an interactive element by its [@eN] ref from the last snapshot (or a CSS selector).',
        _browser.browserClick,
        {
            'type': 'object',
            'properties': {
                'ref': {'type': 'string', 'description': 'Element ref like @e3 from the snapshot.'},
                'selector': {'type': 'string', 'description': 'CSS selector alternative to ref.'},
                'button': {
                    'type': 'string',
                    'enum': ['left', 'right', 'middle'],
                    'description': 'Mouse button (default left).',
                },
                'clickCount': {'type': 'integer', 'description': 'Click count (default 1).'},
            },
        },
    )
    tool_registry.register(
        'browser_type',
        'Type text into an element identified by [@eN] ref or CSS selector.',
        _browser.browserType,
        {
            'type': 'object',
            'properties': {
                'text': {'type': 'string', 'description': 'Text to type.'},
                'ref': {'type': 'string', 'description': 'Element ref like @e3.'},
                'selector': {'type': 'string', 'description': 'CSS selector alternative to ref.'},
                'clear': {
                    'type': 'boolean',
                    'description': 'Clear existing value before typing (default true).',
                },
                'submit': {
                    'type': 'boolean',
                    'description': 'Press Enter after typing (default false).',
                },
            },
            'required': ['text'],
        },
    )
    tool_registry.register(
        'browser_select',
        'Select an option in a <select> by value or label.',
        _browser.browserSelect,
        {
            'type': 'object',
            'properties': {
                'value': {'type': 'string', 'description': 'Option value or visible label.'},
                'ref': {'type': 'string', 'description': 'Element ref like @e3.'},
                'selector': {'type': 'string', 'description': 'CSS selector alternative to ref.'},
            },
            'required': ['value'],
        },
    )
    tool_registry.register(
        'browser_scroll',
        'Scroll the page or a specific element.',
        _browser.browserScroll,
        {
            'type': 'object',
            'properties': {
                'direction': {
                    'type': 'string',
                    'enum': ['up', 'down', 'left', 'right'],
                    'description': 'Scroll direction (default down).',
                },
                'amount': {'type': 'integer', 'description': 'Pixels to scroll (default 600).'},
                'ref': {
                    'type': 'string',
                    'description': 'Optional element ref to scroll into view / within.',
                },
                'selector': {'type': 'string', 'description': 'CSS selector alternative to ref.'},
            },
        },
    )
    tool_registry.register(
        'browser_wait',
        'Wait for a selector, network idle, or a fixed delay.',
        _browser.browserWait,
        {
            'type': 'object',
            'properties': {
                'strategy': {
                    'type': 'string',
                    'enum': ['selector', 'networkidle', 'timeout'],
                    'description': 'What to wait for (default selector).',
                },
                'selector': {'type': 'string', 'description': 'Required when strategy=selector.'},
                'timeout': {'type': 'integer', 'description': 'Seconds before giving up (default 30).'},
            },
        },
    )
    tool_registry.register(
        'browser_screenshot',
        'Take a screenshot, save it to disk, and return the file path + dimensions.',
        _browser.browserScreenshot,
        {
            'type': 'object',
            'properties': {
                'fullPage': {
                    'type': 'boolean',
                    'description': 'Capture the full scrollable page (default false).',
                }
            },
        },
    )
    tool_registry.register(
        'browser_evaluate',
        'Execute JavaScript in the page and return the JSON-serialised result.',
        _browser.browserEvaluate,
        {
            'type': 'object',
            'properties': {
                'script': {
                    'type': 'string',
                    'description': 'JavaScript expression or function body to evaluate.',
                }
            },
            'required': ['script'],
        },
    )
    tool_registry.register(
        'browser_get_content',
        'Extract page content. format: html | text | markdown | elements (elements returns the interactive-element snapshot).',
        _browser.browserGetContent,
        {
            'type': 'object',
            'properties': {
                'format': {
                    'type': 'string',
                    'enum': ['html', 'text', 'markdown', 'elements'],
                    'description': 'Content format (default markdown).',
                }
            },
        },
    )
