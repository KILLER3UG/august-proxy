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
from typing import Any, AsyncIterator, Callable

import httpx


# ── SSE Parser ──────────────────────────────────────────────────────────


class SseStreamParser:
    """Line-based SSE stream parser.

    Port of backend/adapters/sse-parser.js. Fed chunks of text via feed(),
    emits parsed events via the on_event callback. flush() drains any
    remaining buffered data.
    """

    def __init__(self, on_event: Callable[[str, str], None]) -> None:
        if not callable(on_event):
            raise TypeError("SseStreamParser requires an on_event callback")
        self.on_event = on_event
        self._buffer = ""
        self._current_event: dict[str, str] = {"event": "", "data": ""}

    def feed(self, text: str) -> None:
        if not text:
            return
        self._buffer += text
        while "\n" in self._buffer:
            boundary = self._buffer.index("\n")
            raw_line = self._buffer[:boundary]
            self._buffer = self._buffer[boundary + 1 :]
            self._handle_line(raw_line.rstrip("\r"))

    def flush(self) -> None:
        if not self._buffer and not self._current_event["data"]:
            return
        trailing = self._buffer.rstrip("\r")
        self._buffer = ""
        if trailing:
            self._handle_line(trailing)
        self._emit_current_event()

    # ── internal ──────────────────────────────────────────────────────────

    def _handle_line(self, line: str) -> None:
        if line == "":
            self._emit_current_event()
            return
        if line.startswith(":"):
            return  # comment lines are ignored in SSE

        colon = line.find(":")
        field = line[:colon] if colon >= 0 else line
        value = line[colon + 1 :] if colon >= 0 else ""
        if value.startswith(" "):
            value = value[1:]

        if field == "event":
            self._current_event["event"] = value
        elif field == "data":
            if self._current_event["data"]:
                self._current_event["data"] += "\n" + value
            else:
                self._current_event["data"] = value
        # id: and retry: fields are ignored (not needed by adapters)

    def _emit_current_event(self) -> None:
        if not self._current_event["data"]:
            self._current_event = {"event": "", "data": ""}
            return
        self.on_event(
            self._current_event["event"] or "message",
            self._current_event["data"],
        )
        self._current_event = {"event": "", "data": ""}


# ── Rate limiting / retry helpers ──────────────────────────────────────
# Port of backend/lib/upstream.js


def parse_retry_after_ms(retry_after_header: str | None) -> int | None:
    """Parse Retry-After header value into milliseconds.

    Accepts both seconds-as-integer and HTTP-date formats.
    """
    if not retry_after_header:
        return None
    trimmed = retry_after_header.strip()
    # Try seconds-as-integer first
    try:
        seconds = float(trimmed)
        if seconds >= 0:
            return int(seconds * 1000)
    except ValueError:
        pass
    # Try HTTP-date format (e.g., "Wed, 21 Oct 2015 07:28:00 GMT")
    try:
        retry_at = time.mktime(time.strptime(trimmed, "%a, %d %b %Y %H:%M:%S %Z"))
        return max(0, int((retry_at - time.time()) * 1000))
    except (ValueError, OSError):
        pass
    return None


def is_retryable_status(status: int) -> bool:
    """True for 429 (Too Many Requests) and 503 (Service Unavailable)."""
    return status in (429, 503)


def get_retry_delay_ms(response: httpx.Response, attempt: int) -> int:
    """Compute delay before the next retry attempt.

    Prefers the Retry-After header (capped at 30 s), then falls back to
    exponential backoff: min(1000 * 2^(attempt-1), 8000) + random jitter.
    """
    header_delay = parse_retry_after_ms(response.headers.get("retry-after"))
    if header_delay is not None:
        return min(header_delay, 30000)

    base_delay = min(1000 * (2 ** max(0, attempt - 1)), 8000)
    jitter = random.randint(0, 400)
    return base_delay + jitter


def build_rate_limit_message(status: int, body: str, attempts: int) -> str:
    """Build a user-friendly rate-limit error message."""
    guidance = (
        "Upstream is rate-limiting this request. The proxy retried automatically. "
        "If this keeps happening, spread traffic across multiple providers or API "
        "keys, reduce parallel requests, or move this workload to a higher-capacity plan."
    )
    return f"Upstream Error ({status}): {body}\n\n{guidance}\nRetries attempted: {attempts}."


# ── Normalized response ─────────────────────────────────────────────────


class ProviderResponse:
    """Normalized response from an upstream provider API call."""

    def __init__(
        self,
        status: int,
        headers: dict[str, str] | None = None,
        body: dict[str, Any] | str | None = None,
    ) -> None:
        self.status = status
        self.headers = headers or {}
        self.body = body

    @property
    def is_success(self) -> bool:
        return 200 <= self.status < 300

    @property
    def is_error(self) -> bool:
        return self.status >= 400 or self.status == 0

    @property
    def body_json(self) -> dict[str, Any] | None:
        """Return body as a dict if it's JSON, None otherwise."""
        if isinstance(self.body, dict):
            return self.body
        if isinstance(self.body, str):
            try:
                return json.loads(self.body)
            except (json.JSONDecodeError, UnicodeDecodeError):
                return None
        return None


# ── Token estimation (lightweight, no tiktoken) ─────────────────────────
# Port of backend/lib/tokens.js — character-based heuristics good enough
# for compaction decisions.


def estimate_string_tokens(s: str | None) -> int:
    """Estimate token count for a string using character heuristics.

    ASCII: ~4 chars/token, CJK/wide: ~1.5 chars/token.
    """
    if not s:
        return 0
    tokens = 0.0
    for ch in s:
        code = ord(ch)
        # CJK Unified Ideographs, Extension A, punctuation
        if (0x4E00 <= code <= 0x9FFF) or (0x3400 <= code <= 0x4DBF) or (0x3000 <= code <= 0x303F):
            tokens += 0.67
        # Fullwidth forms
        elif 0xFF00 <= code <= 0xFFEF:
            tokens += 0.67
        # Hiragana / Katakana
        elif (0x3040 <= code <= 0x309F) or (0x30A0 <= code <= 0x30FF):
            tokens += 0.67
        # Hangul
        elif 0xAC00 <= code <= 0xD7AF:
            tokens += 0.67
        else:
            tokens += 0.25
    return max(1, int(tokens + 0.999))  # ceil


def estimate_message_tokens(msg: dict[str, Any]) -> int:
    """Estimate tokens for a single message."""
    tokens = 4  # base overhead per message (role + structure)
    content = msg.get("content")
    if content:
        tokens += _estimate_content_tokens(content)
    # Tool calls add overhead
    for tc in msg.get("tool_calls", []):
        tokens += 10
        tokens += estimate_string_tokens(tc.get("function", {}).get("name", ""))
        tokens += estimate_string_tokens(tc.get("function", {}).get("arguments", ""))
        tokens += estimate_string_tokens(tc.get("id", ""))
    # Tool result
    if msg.get("tool_call_id"):
        tokens += 4 + estimate_string_tokens(msg["tool_call_id"])
    return tokens


def estimate_tool_tokens(tools: list[dict[str, Any]] | None) -> int:
    """Estimate tokens for tool definitions."""
    if not tools:
        return 0
    total = 0
    for tool in tools:
        total += 50  # base tool overhead
        func = tool.get("function", tool)
        total += estimate_string_tokens(func.get("name", tool.get("name", "")))
        total += estimate_string_tokens(func.get("description", tool.get("description", "")))
        params = func.get("parameters") or func.get("input_schema", {})
        total += estimate_string_tokens(json.dumps(params))
    return total


def estimate_tokens(messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None) -> int:
    """Estimate total tokens for a conversation."""
    total = 3  # base prompt overhead
    for msg in messages:
        total += estimate_message_tokens(msg)
    if tools:
        total += estimate_tool_tokens(tools)
    return total


def format_token_count(n: int) -> str:
    """Format token counts: 1.5M, 512K, or raw number."""
    if n >= 1_000_000:
        return f"{n / 1_048_576:.1f}M"
    if n >= 1000:
        return f"{n / 1024:.1f}K"
    return str(n)


def _estimate_content_tokens(content: Any) -> int:
    """Estimate tokens for various content formats."""
    if not content:
        return 0
    if isinstance(content, str):
        return estimate_string_tokens(content)
    if isinstance(content, list):
        total = 0
        for part in content:
            if isinstance(part, dict):
                ptype = part.get("type", "")
                if ptype == "text":
                    total += estimate_string_tokens(part.get("text", ""))
                elif ptype in ("image_url", "input_image"):
                    total += 512  # image placeholder
                elif ptype == "tool_result":
                    c = part.get("content", "")
                    total += estimate_string_tokens(c if isinstance(c, str) else json.dumps(c))
                elif ptype == "tool_use":
                    total += estimate_string_tokens(json.dumps(part.get("input", {})))
                else:
                    total += estimate_string_tokens(json.dumps(part))
            else:
                total += estimate_string_tokens(json.dumps(part))
        return total
    return estimate_string_tokens(json.dumps(content))


# ── Base Provider Client ────────────────────────────────────────────────


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

    # The API format identifier (set by subclasses).
    api_format: str = ""

    def __init__(
        self,
        provider_config: dict[str, Any],
        *,
        timeout: float = 300.0,
        max_retries: int = 3,
    ) -> None:
        self.config = provider_config
        self.timeout = timeout
        self.max_retries = max_retries
        self._client: httpx.AsyncClient | None = None

    # ── Client lifecycle ─────────────────────────────────────────────────

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=True,
            )
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ── Auth / URL resolution ─────────────────────────────────────────────

    def build_auth_headers(self, api_key: str | None) -> dict[str, str]:
        """Build standard JSON + Bearer auth headers.

        Merges in any provider-specific ``default_headers`` from config.
        """
        headers: dict[str, str] = {"Content-Type": "application/json"}
        extra = self.config.get("default_headers")
        if isinstance(extra, dict):
            headers.update(extra)
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers

    def resolve_api_key(self) -> str | None:
        """Resolve the API key from config.json or environment variables.

        Resolution order:
        1. ``config.json`` → ``{provider_name}.apiKey`` (tries display name, aliases, env var names)
        2. Environment variable derived from provider name
        3. Env vars from provider's ``env_vars`` config
        """
        import os

        from app.config import settings

        provider_name = self.config.get("name", "")

        # Try config.json with various key names
        cfg = settings.config
        candidates = [provider_name]
        # Add aliases
        aliases_list = self.config.get("aliases", [])
        if isinstance(aliases_list, list):
            candidates.extend(aliases_list)
        # Add env var base names
        env_vars = self.config.get("env_vars", [])
        for var in env_vars:
            if var.endswith("_API_KEY"):
                base = var.replace("_API_KEY", "").lower()
                candidates.append(base)
                candidates.append(base.replace("_", "-"))  # also try with dashes
            elif var.endswith("_KEY"):
                base = var.replace("_KEY", "").lower()
                candidates.append(base)
                candidates.append(base.replace("_", "-"))

        for candidate in candidates:
            if not candidate:
                continue
            provider_cfg = cfg.get(candidate, {})
            if isinstance(provider_cfg, dict):
                api_key = provider_cfg.get("apiKey")
                if api_key:
                    return api_key

        # Try env vars
        for var in env_vars:
            val = os.environ.get(var)
            if val:
                return val

        # Try standard env var patterns
        env_name = provider_name.upper().replace(" ", "_").replace("-", "_")
        for suffix in ("_API_KEY", "_KEY", "_APIKEY"):
            candidate = os.environ.get(f"{env_name}{suffix}")
            if candidate:
                return candidate

        return None

    def resolve_base_url(self) -> str:
        """Resolve the base URL from env vars, config.json, or provider default."""
        from app.config import settings

        provider_name = self.config.get("name", "")
        cfg = settings.config.get(provider_name, {})
        base_url = cfg.get("baseUrl") or self.config.get("base_url", "")
        return base_url.rstrip("/") if base_url else ""

    # ── Non-streaming request ─────────────────────────────────────────────

    async def request_json(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: dict[str, Any] | None = None,
    ) -> ProviderResponse:
        """Make a non-streaming JSON request with retry logic."""
        for attempt in range(self.max_retries + 1):
            try:
                resp = await self.client.request(
                    method,
                    url,
                    headers=headers,
                    json=body,
                    timeout=self.timeout,
                )
                if is_retryable_status(resp.status_code) and attempt < self.max_retries:
                    delay = get_retry_delay_ms(resp, attempt + 1) / 1000
                    await asyncio.sleep(delay)
                    continue

                try:
                    data: dict[str, Any] | str = resp.json()
                except (json.JSONDecodeError, UnicodeDecodeError):
                    data = resp.text

                return ProviderResponse(status=resp.status_code, headers=dict(resp.headers), body=data)

            except (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError) as exc:
                if attempt >= self.max_retries:
                    return ProviderResponse(
                        status=0,
                        body={"error": f"Request failed after {self.max_retries} retries: {exc}"},
                    )
                delay = min(1000 * (2**attempt), 8000) / 1000
                await asyncio.sleep(delay)

        return ProviderResponse(status=0, body={"error": "Max retries exceeded"})

    # ── Streaming request ─────────────────────────────────────────────────

    async def stream_sse(
        self,
        url: str,
        headers: dict[str, str],
        body: dict[str, Any],
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream SSE events from an upstream API.

        Yields parsed JSON dicts for each ``data:`` line as they arrive
        (progressive / real-time). Emits an ``error`` event on HTTP errors
        or connection failures.
        """
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                async with self.client.stream(
                    "POST", url, headers=headers, json=body, timeout=self.timeout
                ) as resp:
                    if is_retryable_status(resp.status_code) and attempt < self.max_retries:
                        delay = get_retry_delay_ms(resp, attempt + 1) / 1000
                        await asyncio.sleep(delay)
                        continue

                    if resp.status_code >= 400:
                        error_body = await resp.aread()
                        yield {
                            "type": "error",
                            "status": resp.status_code,
                            "body": error_body.decode("utf-8", errors="replace"),
                        }
                        return

                    # Progressive streaming via asyncio.Queue:
                    # The SSE parser feeds parsed events into the queue as
                    # they arrive from the HTTP stream. A background task
                    # drives the parser. The main coroutine yields events
                    # from the queue immediately — no buffering.
                    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

                    def collector(event: str, data: str) -> None:
                        if data == "[DONE]":
                            queue.put_nowait(None)  # sentinel
                            return
                        try:
                            parsed = json.loads(data)
                            if isinstance(parsed, dict):
                                parsed["_event_type"] = event
                            queue.put_nowait(parsed)
                        except json.JSONDecodeError:
                            pass

                    parser = SseStreamParser(on_event=collector)

                    async def _feed() -> None:
                        """Background task: feed incoming lines into the SSE parser."""
                        try:
                            async for line in resp.aiter_lines():
                                parser.feed(line + "\n")
                            parser.flush()
                        finally:
                            # Ensure the queue is unblocked even on error
                            queue.put_nowait(None)

                    feed_task = asyncio.create_task(_feed())

                    try:
                        while True:
                            item = await queue.get()
                            if item is None:
                                break  # sentinel — stream ended
                            yield item
                    finally:
                        feed_task.cancel()
                        try:
                            await feed_task
                        except asyncio.CancelledError:
                            pass
                    return

            except (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError) as exc:
                last_exc = exc
                if attempt < self.max_retries:
                    delay = min(1000 * (2**attempt), 8000) / 1000
                    await asyncio.sleep(delay)
                    continue

                yield {"type": "error", "error": str(last_exc)}
                return

    # ── Token estimation (convenience wrappers) ───────────────────────────

    @staticmethod
    def estimate_tokens(
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> int:
        return estimate_tokens(messages, tools)

    @staticmethod
    def format_tokens(n: int) -> str:
        return format_token_count(n)
