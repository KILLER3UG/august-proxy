"""
Base provider client — shared HTTP transport, SSE parsing, retry logic.

Port of:
  - backend/lib/upstream.js (rate limiting / retry)
  - backend/adapters/sse-parser.js (SSE event parsing)
  - backend/adapters/base.js (shared adapter utilities)
"""

from __future__ import annotations
import asyncio
import json
import random
import time
from typing import AsyncIterator, Callable
import httpx
from app.jsonUtils import as_str, as_dict, as_list


class SseStreamParser:
    """Line-based SSE stream parser.

    Port of backend/adapters/sse-parser.js. Fed chunks of text via feed(),
    emits parsed events via the on_event callback. flush() drains any
    remaining buffered data.
    """

    def __init__(self, onEvent: Callable[[str, str], None]) -> None:
        if not callable(onEvent):
            raise TypeError('SseStreamParser requires an on_event callback')
        self.onEvent = onEvent
        self._buffer = ''
        self._currentEvent: dict[str, str] = {'event': '', 'data': ''}

    def feed(self, text: str) -> None:
        if not text:
            return
        self._buffer += text
        while '\n' in self._buffer:
            boundary = self._buffer.index('\n')
            rawLine = self._buffer[:boundary]
            self._buffer = self._buffer[boundary + 1 :]
            self._handleLine(rawLine.rstrip('\r'))

    def flush(self) -> None:
        if not self._buffer and (not self._currentEvent['data']):
            return
        trailing = self._buffer.rstrip('\r')
        self._buffer = ''
        if trailing:
            self._handleLine(trailing)
        self._emitCurrentEvent()

    def _handleLine(self, line: str) -> None:
        if line == '':
            self._emitCurrentEvent()
            return
        if line.startswith(':'):
            return
        colon = line.find(':')
        field = line[:colon] if colon >= 0 else line
        value = line[colon + 1 :] if colon >= 0 else ''
        if value.startswith(' '):
            value = value[1:]
        if field == 'event':
            self._currentEvent['event'] = value
        elif field == 'data':
            if self._currentEvent['data']:
                self._currentEvent['data'] += '\n' + value
            else:
                self._currentEvent['data'] = value

    def _emitCurrentEvent(self) -> None:
        if not self._currentEvent['data']:
            self._currentEvent = {'event': '', 'data': ''}
            return
        self.onEvent(self._currentEvent['event'] or 'message', self._currentEvent['data'])
        self._currentEvent = {'event': '', 'data': ''}


def parseRetryAfterMs(retryAfterHeader: str | None) -> int | None:
    """Parse Retry-After header value into milliseconds.

    Accepts both seconds-as-integer and HTTP-date formats.
    """
    if not retryAfterHeader:
        return None
    trimmed = retryAfterHeader.strip()
    try:
        seconds = float(trimmed)
        if seconds >= 0:
            return int(seconds * 1000)
    except ValueError:
        pass
    try:
        retryAt = time.mktime(time.strptime(trimmed, '%a, %d %b %Y %H:%M:%S %Z'))
        return max(0, int((retryAt - time.time()) * 1000))
    except (ValueError, OSError):
        pass
    return None


def isRetryableStatus(status: int) -> bool:
    """True for 429 (Too Many Requests) and 503 (Service Unavailable)."""
    return status in (429, 503)


def getRetryDelayMs(response: httpx.Response, attempt: int) -> int:
    """Compute delay before the next retry attempt.

    Prefers the Retry-After header (capped at 30 s), then falls back to
    exponential backoff: min(1000 * 2^(attempt-1), 8000) + random jitter.
    """
    headerDelay = parseRetryAfterMs(response.headers.get('retry-after'))
    if headerDelay is not None:
        return min(headerDelay, 30000)
    baseDelay = min(1000 * 2 ** max(0, attempt - 1), 8000)
    jitter = random.randint(0, 400)
    return baseDelay + jitter


def buildRateLimitMessage(status: int, body: str, attempts: int) -> str:
    """Build a user-friendly rate-limit error message."""
    guidance = 'Upstream is rate-limiting this request. The proxy retried automatically. If this keeps happening, spread traffic across multiple providers or API keys, reduce parallel requests, or move this workload to a higher-capacity plan.'
    return f'Upstream Error ({status}): {body}\n\n{guidance}\nRetries attempted: {attempts}.'


class ProviderResponse:
    """Normalized response from an upstream provider API call."""

    def __init__(
        self, status: int, headers: dict[str, str] | None = None, body: dict[str, object] | str | None = None
    ) -> None:
        self.status = status
        self.headers = headers or {}
        self.body = body

    @property
    def isSuccess(self) -> bool:
        return 200 <= self.status < 300

    @property
    def is_error(self) -> bool:
        return self.status >= 400 or self.status == 0

    @property
    def body_json(self) -> dict[str, object] | None:
        """Return body as a dict if it's JSON, None otherwise."""
        if isinstance(self.body, dict):
            return self.body
        if isinstance(self.body, str):
            try:
                return json.loads(self.body)
            except (json.JSONDecodeError, UnicodeDecodeError):
                return None
        return None


def estimateStringTokens(s: str | None) -> int:
    """Estimate token count for a string using character heuristics.

    ASCII: ~4 chars/token, CJK/wide: ~1.5 chars/token.
    """
    if not s:
        return 0
    tokens = 0.0
    for ch in s:
        code = ord(ch)
        if 19968 <= code <= 40959 or 13312 <= code <= 19903 or 12288 <= code <= 12351:
            tokens += 0.67
        elif 65280 <= code <= 65519:
            tokens += 0.67
        elif 12352 <= code <= 12447 or 12448 <= code <= 12543:
            tokens += 0.67
        elif 44032 <= code <= 55215:
            tokens += 0.67
        else:
            tokens += 0.25
    return max(1, int(tokens + 0.999))


def estimateMessageTokens(msg: dict[str, object]) -> int:
    """Estimate tokens for a single message."""
    tokens = 4
    content = msg.get('content')
    if content:
        tokens += _estimateContentTokens(content)
    for tc_raw in as_list(msg.get('tool_calls'), []):
        tc = as_dict(tc_raw)
        func = as_dict(tc.get('function'), {})
        tokens += 10
        tokens += estimateStringTokens(as_str(func.get('name'), ''))
        tokens += estimateStringTokens(as_str(func.get('arguments'), ''))
        tokens += estimateStringTokens(as_str(tc.get('id'), ''))
    if msg.get('tool_call_id'):
        tokens += 4 + estimateStringTokens(as_str(msg.get('tool_call_id'), ''))
    return tokens


def estimateToolTokens(tools: list[dict[str, object]] | None) -> int:
    """Estimate tokens for tool definitions."""
    if not tools:
        return 0
    total = 0
    for tool in tools:
        total += 50
        func = as_dict(tool.get('function'), {})
        total += estimateStringTokens(as_str(func.get('name'), as_str(tool.get('name'), '')))
        total += estimateStringTokens(as_str(func.get('description'), as_str(tool.get('description'), '')))
        params = func.get('parameters') or func.get('input_schema', {})
        total += estimateStringTokens(json.dumps(params))
    return total


def estimateTokens(messages: list[dict[str, object]], tools: list[dict[str, object]] | None = None) -> int:
    """Estimate total tokens for a conversation."""
    total = 3
    for msg in messages:
        total += estimateMessageTokens(msg)
    if tools:
        total += estimateToolTokens(tools)
    return total


def formatTokenCount(n: int) -> str:
    """Format token counts: 1.5M, 512K, or raw number."""
    if n >= 1000000:
        return f'{n / 1048576:.1f}M'
    if n >= 1000:
        return f'{n / 1024:.1f}K'
    return str(n)


def _estimateContentTokens(content: object) -> int:
    """Estimate tokens for various content formats."""
    if not content:
        return 0
    if isinstance(content, str):
        return estimateStringTokens(content)
    if isinstance(content, list):
        total = 0
        for part in content:
            if isinstance(part, dict):
                ptype = part.get('type', '')
                if ptype == 'text':
                    total += estimateStringTokens(part.get('text', ''))
                elif ptype in ('image_url', 'input_image'):
                    total += 512
                elif ptype == 'tool_result':
                    c = part.get('content', '')
                    total += estimateStringTokens(c if isinstance(c, str) else json.dumps(c))
                elif ptype == 'tool_use':
                    total += estimateStringTokens(json.dumps(part.get('input', {})))
                else:
                    total += estimateStringTokens(json.dumps(part))
            else:
                total += estimateStringTokens(json.dumps(part))
        return total
    return estimateStringTokens(json.dumps(content))


class BaseProviderClient:
    """Shared HTTP transport for all provider API formats.

    Handles:
    - httpx.AsyncClient lifecycle
    - SSE streaming with line-based parsing
    - Retry with exponential backoff on 429/503 + ConnectionError
    - Auth header building from provider config
    - Rate-limit detection and friendly error messages
    - Token estimation utilities

    Subclass this for each API format (Anthropic Messages, OpenAI Chat,
    Bedrock Converse, etc.).
    """

    apiFormat: str = ''

    def __init__(self, providerConfig: dict[str, object], *, timeout: float = 300.0, maxRetries: int = 3) -> None:
        self.config = providerConfig
        self.timeout = timeout
        self.maxRetries = maxRetries
        self._client: httpx.AsyncClient | None = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout, follow_redirects=True)
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def chat_completions(self, body: dict[str, object], apiKey: str | None = None) -> ProviderResponse:
        raise NotImplementedError

    async def chat_completions_stream(
        self, body: dict[str, object], apiKey: str | None = None
    ) -> AsyncIterator[dict[str, object]]:
        raise NotImplementedError
        yield {}  # async-generator stub; subclasses override

    async def messages(self, body: dict[str, object], apiKey: str | None = None) -> ProviderResponse:
        raise NotImplementedError

    async def messages_stream(
        self, body: dict[str, object], apiKey: str | None = None
    ) -> AsyncIterator[dict[str, object]]:
        raise NotImplementedError
        yield {}  # async-generator stub; subclasses override

    def buildAuthHeaders(self, apiKey: str | None) -> dict[str, str]:
        """Build standard JSON + Bearer auth headers.

        Merges in any provider-specific ``default_headers`` from config.
        """
        headers: dict[str, str] = {'Content-Type': 'application/json'}
        extra = self.config.get('defaultHeaders')
        if isinstance(extra, dict):
            headers.update(extra)
        if apiKey:
            headers['Authorization'] = f'Bearer {apiKey}'
        return headers

    def resolveApiKey(self) -> str | None:
        """Resolve the API key from config.json or environment variables.

        Resolution order:
        0. Provider config's own ``api_key`` (used for custom ``providers.json`` entries)
        1. ``config.json`` → ``{provider_name}.apiKey`` (tries display name, aliases, env var names)
        2. Environment variable derived from provider name
        3. Env vars from provider's ``env_vars`` config
        """
        import os
        from app.config import settings

        providerName = as_str(self.config.get('name'), '')
        embedded = as_str(self.config.get('api_key')) or as_str(self.config.get('apiKey'))
        if embedded:
            return embedded
        cfg = settings.config
        candidates = [providerName]
        aliasesList = as_list(self.config.get('aliases'), [])
        if isinstance(aliasesList, list):
            candidates.extend(as_str(a) for a in aliasesList)
        envVars = as_list(self.config.get('envVars'), [])
        for var in envVars:
            varStr = as_str(var)
            if varStr.endswith('_API_KEY'):
                base = varStr.replace('_API_KEY', '').lower()
                candidates.append(base)
                candidates.append(base.replace('_', '-'))
            elif varStr.endswith('_KEY'):
                base = varStr.replace('_KEY', '').lower()
                candidates.append(base)
                candidates.append(base.replace('_', '-'))
        for candidate in candidates:
            if not candidate:
                continue
            providerCfg = as_dict(cfg.get(candidate), {})
            if isinstance(providerCfg, dict):
                apiKey = as_str(providerCfg.get('apiKey'))
                if apiKey:
                    return apiKey
        for var in envVars:
            val = os.environ.get(as_str(var))
            if val:
                return val
        envName = providerName.upper().replace(' ', '_').replace('-', '_')
        for suffix in ('_API_KEY', '_KEY', '_APIKEY'):
            envCandidate = os.environ.get(f'{envName}{suffix}')
            if envCandidate:
                return envCandidate
        return None

    def resolveBaseUrl(self) -> str:
        """Resolve the base URL from env vars, config.json, or provider default."""
        from app.config import settings

        providerName = as_str(self.config.get('name'), '')
        cfg = as_dict(settings.config.get(providerName), {})
        baseUrl = as_str(cfg.get('baseUrl')) or as_str(self.config.get('baseUrl'), '')
        return baseUrl.rstrip('/') if baseUrl else ''

    async def requestJson(
        self, method: str, url: str, headers: dict[str, str], body: dict[str, object] | None = None
    ) -> ProviderResponse:
        """Make a non-streaming JSON request with retry logic."""
        for attempt in range(self.maxRetries + 1):
            try:
                resp = await self.client.request(method, url, headers=headers, json=body, timeout=self.timeout)
                if isRetryableStatus(resp.status_code) and attempt < self.maxRetries:
                    delay = getRetryDelayMs(resp, attempt + 1) / 1000
                    await asyncio.sleep(delay)
                    continue
                try:
                    data: dict[str, object] | str = resp.json()
                except (json.JSONDecodeError, UnicodeDecodeError):
                    data = resp.text
                return ProviderResponse(status=resp.status_code, headers=dict(resp.headers), body=data)
            except (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError) as exc:
                if attempt >= self.maxRetries:
                    return ProviderResponse(
                        status=0, body={'error': f'Request failed after {self.maxRetries} retries: {exc}'}
                    )
                delay = min(1000 * 2**attempt, 8000) / 1000
                await asyncio.sleep(delay)
        return ProviderResponse(status=0, body={'error': 'Max retries exceeded'})

    async def generate(self, prompt: str, system: str | None = None) -> str:
        """v2: Simple text-in/text-out helper used by consolidation, delta engine,
        skill genesis, and daemon code paths.

        Default implementation uses chat_completions (OpenAI-compatible).
        AnthropicClient and other subclasses override this.
        """
        if hasattr(self, 'chatCompletions'):
            messages: list[dict[str, str]] = []
            if system:
                messages.append({'role': 'system', 'content': system})
            messages.append({'role': 'user', 'content': prompt})
            model = as_str(self.config.get('model'), '')
            body = {'model': model, 'messages': messages, 'stream': False}
            try:
                resp = await self.chat_completions(body)
            except (AttributeError, TypeError):
                return ''
            if resp.status != 200:
                return ''
            bodyData = resp.body if isinstance(resp.body, dict) else {}
            choices = bodyData.get('choices', [])
            if choices and isinstance(choices, list):
                msg = choices[0].get('message', {})
                content = msg.get('content', '')
                return content if isinstance(content, str) else ''
            return ''
        return ''

    async def streamSse(
        self, url: str, headers: dict[str, str], body: dict[str, object]
    ) -> AsyncIterator[dict[str, object]]:
        """Stream SSE events from an upstream API.

        Yields parsed JSON dicts for each ``data:`` line as they arrive
        (progressive / real-time). Emits an ``error`` event on HTTP errors
        or connection failures.
        """
        lastExc: Exception | None = None
        for attempt in range(self.maxRetries + 1):
            try:
                async with self.client.stream('POST', url, headers=headers, json=body, timeout=self.timeout) as resp:
                    if isRetryableStatus(resp.status_code) and attempt < self.maxRetries:
                        delay = getRetryDelayMs(resp, attempt + 1) / 1000
                        await asyncio.sleep(delay)
                        continue
                    if resp.status_code >= 400:
                        errorBody = await resp.aread()
                        yield {
                            'type': 'error',
                            'status': resp.status_code,
                            'body': errorBody.decode('utf-8', errors='replace'),
                        }
                        return
                    queue: asyncio.Queue[dict[str, object] | None] = asyncio.Queue()

                    def collector(event: str, data: str) -> None:
                        if data == '[DONE]':
                            queue.put_nowait(None)
                            return
                        try:
                            parsed = json.loads(data)
                            if isinstance(parsed, dict):
                                parsed['_event_type'] = event
                            queue.put_nowait(parsed)
                        except json.JSONDecodeError:
                            pass

                    parser = SseStreamParser(onEvent=collector)

                    async def _feed() -> None:
                        """Background task: feed incoming lines into the SSE parser."""
                        try:
                            async for line in resp.aiter_lines():
                                parser.feed(line + '\n')
                            parser.flush()
                        finally:
                            queue.put_nowait(None)

                    feedTask = asyncio.create_task(_feed())
                    try:
                        while True:
                            item = await queue.get()
                            if item is None:
                                break
                            yield item
                    finally:
                        feedTask.cancel()
                        try:
                            await feedTask
                        except asyncio.CancelledError:
                            pass
                    return
            except (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError) as exc:
                lastExc = exc
                if attempt < self.maxRetries:
                    delay = min(1000 * 2**attempt, 8000) / 1000
                    await asyncio.sleep(delay)
                    continue
                yield {'type': 'error', 'error': str(lastExc)}
                return

    @staticmethod
    def estimateTokens(messages: list[dict[str, object]], tools: list[dict[str, object]] | None = None) -> int:
        return estimateTokens(messages, tools)

    @staticmethod
    def formatTokens(n: int) -> str:
        return formatTokenCount(n)
