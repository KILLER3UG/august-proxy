"""Web search/fetch and headless browser tool handlers + registration."""

from __future__ import annotations
import asyncio
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Awaitable, Callable
from app.json_narrowing import as_str
from app.services import tool_registry
from app.services.tool_html import html_to_markdown, unescape_html

# Private aliases for minimal churn (match prior tool_definitions aliases)
_htmlToMarkdown = html_to_markdown
_unescapeHtml = unescape_html

# Keep total tool wall time bounded so chat never sits on web_search forever.
_DDG_SEARCH_TIMEOUT_S = 12.0
_FETCH_TIMEOUT_S = 8.0
_FETCH_PHASE_BUDGET_S = 18.0
_TOTAL_BUDGET_S = 28.0
_FETCH_BODY_CAP_BYTES = 200_000
_FETCH_MARKDOWN_MAX = 8000
_WEB_FETCH_MARKDOWN_MAX = 50000
_AUTO_FETCH_COUNT = 10

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
    """Fetch a URL and return its content as Markdown."""
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


async def _webFetch(url: str) -> str:
    """Fetch a URL and return its content as Markdown."""
    return await _fetchUrlContent(url, maxLength=_WEB_FETCH_MARKDOWN_MAX, timeout_s=30.0)


async def _webSearch(
    query: str,
    maxResults: int = 10,
    on_progress: ProgressCb | None = None,
) -> str:
    """Search DuckDuckGo, then auto-fetch top pages under a hard wall-clock budget.

    Always returns within roughly ``_TOTAL_BUDGET_S``. Slow page fetches are
    abandoned; snippet results are still returned so chat is not hung.
    """
    import json as _json
    from ddgs import DDGS

    started = asyncio.get_running_loop().time()
    maxResults = min(max(1, int(maxResults or 10)), 20)
    searchResults: list[dict[str, object]] = []
    errorHint: str | None = None
    timedOut = False

    await _emit_progress(
        on_progress,
        'reading',
        {'paths': ['DuckDuckGo search'], 'message': 'Searching the web…'},
    )
    try:

        def _search() -> list[dict[str, str]]:
            with DDGS() as ddgs:
                return list(ddgs.text(query, max_results=maxResults))

        loop = asyncio.get_running_loop()
        try:
            rawResults: list[dict[str, str]] = await asyncio.wait_for(
                loop.run_in_executor(_search_pool, _search),
                timeout=_DDG_SEARCH_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            timedOut = True
            await _emit_progress(on_progress, 'done', {'message': 'Search timed out'})
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
        await _emit_progress(
            on_progress,
            'read',
            {'path': 'DuckDuckGo search', 'message': f'Found {len(searchResults)} results'},
        )
    except Exception as exc:
        errorHint = str(exc)

    if not searchResults and not errorHint:
        try:
            import httpx

            async with httpx.AsyncClient(timeout=8.0) as client:
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

    elapsed = asyncio.get_running_loop().time() - started
    remaining = max(0.5, _TOTAL_BUDGET_S - elapsed)
    fetchBudget = min(_FETCH_PHASE_BUDGET_S, remaining)
    fetchCount = min(_AUTO_FETCH_COUNT, len(searchResults))
    fetchTargets = searchResults[:fetchCount]
    urls = [as_str(r['url']) for r in fetchTargets]

    await _emit_progress(
        on_progress,
        'reading',
        {
            'paths': urls,
            'message': f'Fetching top {fetchCount} pages…',
            'total': fetchCount,
        },
    )

    fetchedContent: list[dict[str, object]] = []
    if fetchCount > 0 and fetchBudget > 0.5:

        async def _one(i: int, url: str) -> tuple[int, str, str]:
            content = await _fetchUrlContent(
                url, maxLength=_FETCH_MARKDOWN_MAX, timeout_s=min(_FETCH_TIMEOUT_S, fetchBudget)
            )
            await _emit_progress(
                on_progress,
                'read',
                {
                    'path': url,
                    'index': i + 1,
                    'total': fetchCount,
                    'message': f'Fetched {i + 1}/{fetchCount}',
                },
            )
            return i, url, content

        tasks = [
            asyncio.create_task(_one(i, as_str(r['url'])))
            for i, r in enumerate(fetchTargets)
        ]
        done, pending = await asyncio.wait(tasks, timeout=fetchBudget)
        for task in pending:
            task.cancel()
            timedOut = True
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

        for task in done:
            try:
                item = task.result()
            except Exception:
                continue
            i, url, content = item
            if isinstance(content, str) and content.startswith('Error:'):
                continue
            fetchedContent.append(
                {'index': fetchTargets[i]['index'], 'url': url, 'content': content}
            )

    await _emit_progress(
        on_progress,
        'done',
        {
            'result_count': len(searchResults),
            'fetched': len(fetchedContent),
            'message': (
                f'Search complete — {len(fetchedContent)}/{fetchCount} pages fetched'
                + (' (timed out remaining)' if timedOut else '')
            ),
        },
    )
    payload: dict[str, object] = {
        'search_query': query,
        'result_count': len(searchResults),
        'results': searchResults,
        'fetched_content': fetchedContent,
        'fetched_count': len(fetchedContent),
        'fetch_requested': fetchCount,
    }
    if timedOut or len(fetchedContent) < fetchCount:
        payload['partial'] = True
        payload['message'] = (
            f'Returned {len(searchResults)} results; fetched {len(fetchedContent)}/{fetchCount} '
            f'pages before the {_TOTAL_BUDGET_S:.0f}s budget.'
        )
    return _json.dumps(payload, ensure_ascii=False)


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
        'Search the web using DuckDuckGo. Returns up to 10 results (max 20) with titles/URLs/snippets and auto-fetches page content from the top 10 under a ~28s budget (slow pages are skipped so chat does not hang). Use web_fetch for specific URLs that were skipped.',
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
