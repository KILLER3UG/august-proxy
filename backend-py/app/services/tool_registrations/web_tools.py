"""Web search/fetch and headless browser tool handlers + registration."""

from __future__ import annotations
import asyncio
from collections.abc import Awaitable, Callable
from app.json_narrowing import as_str
from app.services import tool_registry
from app.services.tool_html import html_to_markdown, unescape_html

# Private aliases for minimal churn (match prior tool_definitions aliases)
_htmlToMarkdown = html_to_markdown
_unescapeHtml = unescape_html

_DDG_SEARCH_TIMEOUT_S = 15.0
_FETCH_BODY_CAP_BYTES = 300_000
_FETCH_MARKDOWN_MAX = 8000
_WEB_FETCH_MARKDOWN_MAX = 50000

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


async def _fetchUrlContent(url: str, maxLength: int = 50000) -> str:
    """Fetch a URL and return its content as Markdown (shared helper for web_fetch and web_search auto-fetch)."""
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
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.get(
                url, headers={'User-Agent': 'August-Proxy/1.0', 'Accept': 'text/html,text/markdown,text/plain,*/*'}
            )
            resp.raise_for_status()
            contentType = as_str(resp.headers.get('content-type'), '')
            # Cap raw body before expensive HTML→markdown conversion.
            raw = resp.content[:_FETCH_BODY_CAP_BYTES]
            text = raw.decode(resp.encoding or 'utf-8', errors='replace')
            if 'text/html' in contentType:
                text = _htmlToMarkdown(text)
            return f'URL: {url}\nStatus: {resp.status_code}\n\n{text[:maxLength]}'
    except httpx.HTTPStatusError as exc:
        return f'Error: HTTP {exc.response.status_code} fetching {url}'
    except httpx.RequestError as exc:
        return f'Error: Request failed: {exc}'
    except Exception as exc:
        return f'Error: {exc}'


async def _webFetch(url: str) -> str:
    """Fetch a URL and return its content as Markdown."""
    return await _fetchUrlContent(url, maxLength=_WEB_FETCH_MARKDOWN_MAX)


async def _webSearch(
    query: str,
    maxResults: int = 10,
    on_progress: ProgressCb | None = None,
) -> str:
    """Search the web using DuckDuckGo. Automatically fetches content from top results.

    Uses the ``ddgs`` library. Returns JSON with:
      search_query, result_count, results[{index,title,url,snippet}],
      fetched_content[{index,url,content}] for the top 10 pages.
    """
    import json as _json
    from ddgs import DDGS

    maxResults = min(maxResults, 20)
    searchResults: list[dict[str, object]] = []
    errorHint: str | None = None
    await _emit_progress(on_progress, 'searching', {'query': query})
    try:

        def _search() -> list[dict[str, str]]:
            with DDGS() as ddgs:
                return list(ddgs.text(query, max_results=maxResults))

        loop = asyncio.get_running_loop()
        try:
            rawResults: list[dict[str, str]] = await asyncio.wait_for(
                loop.run_in_executor(None, _search),
                timeout=_DDG_SEARCH_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            return _json.dumps(
                {
                    'search_query': query,
                    'result_count': 0,
                    'message': f'DuckDuckGo search timed out after {_DDG_SEARCH_TIMEOUT_S:.0f}s',
                    'error': 'timeout',
                },
                ensure_ascii=False,
            )
        for i, r in enumerate(rawResults):
            title = as_str(r.get('title'), '').strip()
            url = as_str(r.get('href'), '').strip()
            snippet = as_str(r.get('body'), '').strip()
            if title and url:
                searchResults.append({'index': i + 1, 'title': title, 'url': url, 'snippet': snippet})
    except Exception as exc:
        errorHint = str(exc)
    if not searchResults and (not errorHint):
        try:
            import httpx

            async with httpx.AsyncClient(timeout=10.0) as client:
                iaResp = await client.get(
                    'https://api.duckduckgo.com/',
                    params={'q': query, 'format': 'json', 'no_html': '1', 'skip_disambig': '1'},
                )
                iaResp.raise_for_status()
                iaData = iaResp.json()
                abstract = as_str(iaData.get('Abstract'), '')
                if abstract:
                    await _emit_progress(on_progress, 'done', {'result_count': 0, 'abstract': True})
                    return _json.dumps(
                        {
                            'search_query': query,
                            'result_count': 0,
                            'abstract': abstract,
                            'source': as_str(iaData.get('AbstractURL'), ''),
                        },
                        ensure_ascii=False,
                    )
        except Exception:
            pass
    if not searchResults:
        msg = errorHint or f'No results found for: {query}'
        await _emit_progress(on_progress, 'done', {'result_count': 0})
        return _json.dumps({'search_query': query, 'result_count': 0, 'message': msg}, ensure_ascii=False)
    fetchCount = min(10, len(searchResults))
    fetchedContent: list[dict[str, object]] = []
    if fetchCount > 0:
        await _emit_progress(
            on_progress,
            'fetching',
            {'index': 0, 'total': fetchCount, 'message': f'Fetching 0/{fetchCount}'},
        )

        async def _one(i: int, url: str) -> tuple[int, str, str]:
            content = await _fetchUrlContent(url, maxLength=_FETCH_MARKDOWN_MAX)
            await _emit_progress(
                on_progress,
                'fetching',
                {
                    'index': i + 1,
                    'total': fetchCount,
                    'url': url,
                    'message': f'Fetching {i + 1}/{fetchCount}',
                },
            )
            return i, url, content

        fetched = await asyncio.gather(
            *[_one(i, as_str(r['url'])) for i, r in enumerate(searchResults[:fetchCount])],
            return_exceptions=True,
        )
        for item in fetched:
            if isinstance(item, BaseException):
                continue
            i, url, content = item
            fetchedContent.append(
                {'index': searchResults[i]['index'], 'url': url, 'content': content}
            )
    await _emit_progress(
        on_progress,
        'done',
        {'result_count': len(searchResults), 'fetched': len(fetchedContent)},
    )
    return _json.dumps(
        {
            'search_query': query,
            'result_count': len(searchResults),
            'results': searchResults,
            'fetched_content': fetchedContent,
        },
        ensure_ascii=False,
    )


def register() -> None:
    """Register web and browser tools."""
    tool_registry.register(
        'web_fetch',
        'Fetch a specific URL and return its content as clean Markdown. Use this to fetch additional URLs beyond those auto-fetched by web_search. Local/private network addresses are blocked. Max response ~50 KB.',
        _webFetch,
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
        'Search the web for information using DuckDuckGo. Returns a numbered list of results with titles, URLs, and snippets, and AUTOMATICALLY fetches the full content from the top 10 results (fetched content appears below the result list). Max 20 results (default 10). Search provider calls time out after 15s.',
        _webSearchHandler,
        {
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'The search query.'},
                'maxResults': {
                    'type': 'integer',
                    'description': 'Maximum results (max 20, default 10). Request at least 5-10 for thorough research.',
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
        "Click an element. Locate it by ref (e.g. '@e3'), CSS/XPath selector, or visible text.",
        _browser.browserClick,
        {
            'type': 'object',
            'properties': {
                'ref': {'type': 'string', 'description': "Snapshot ref like '@e3'."},
                'selector': {'type': 'string', 'description': 'CSS selector or XPath (//...).'},
                'text': {'type': 'string', 'description': 'Visible text of the element.'},
            },
        },
    )
    tool_registry.register(
        'browser_type',
        'Type text into a field located by ref or selector, optionally pressing Enter to submit.',
        _browser.browserType,
        {
            'type': 'object',
            'properties': {
                'ref': {'type': 'string', 'description': "Snapshot ref like '@e3'."},
                'selector': {'type': 'string', 'description': 'CSS selector or XPath.'},
                'text': {'type': 'string', 'description': 'The text to type into the field.'},
                'submit': {'type': 'boolean', 'description': 'Press Enter after typing (default false).'},
            },
            'required': ['text'],
        },
    )
    tool_registry.register(
        'browser_select',
        'Select an option value from a <select> dropdown located by ref or selector.',
        _browser.browserSelect,
        {
            'type': 'object',
            'properties': {
                'ref': {'type': 'string', 'description': "Snapshot ref like '@e3'."},
                'selector': {'type': 'string', 'description': 'CSS selector or XPath.'},
                'value': {'type': 'string', 'description': 'The option value to select.'},
            },
            'required': ['value'],
        },
    )
    tool_registry.register(
        'browser_scroll',
        'Scroll the page by a number of pixels, or scroll an element into view.',
        _browser.browserScroll,
        {
            'type': 'object',
            'properties': {
                'direction': {
                    'type': 'string',
                    'enum': ['up', 'down'],
                    'description': 'Scroll direction (default down).',
                },
                'amount': {'type': 'integer', 'description': 'Pixels to scroll (default 400).'},
                'selector': {'type': 'string', 'description': 'Scroll this element into view instead of the page.'},
            },
        },
    )
    tool_registry.register(
        'browser_wait',
        'Wait for an element to appear, a load state, or a fixed timeout.',
        _browser.browserWait,
        {
            'type': 'object',
            'properties': {
                'strategy': {
                    'type': 'string',
                    'enum': ['selector', 'load', 'networkidle', 'timeout'],
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
                'fullPage': {'type': 'boolean', 'description': 'Capture the full scrollable page (default false).'}
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
                'script': {'type': 'string', 'description': 'JavaScript expression or function body to evaluate.'}
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
                    'description': 'What to extract (default text).',
                }
            },
        },
    )
