"""
OpenAI Chat Completions adapter — message translation, SSE passthrough,
and managed tool execution for the /v1/chat/completions endpoint.

Port of backend/adapters/openai.js (1,494 lines).

Key responsibilities:
- Session derivation from request body / headers
- Provider profile resolution and merging
- SSE streaming to the client (native or simulated)
- Tool call interception and managed execution
- Multi-round tool resolution loop
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import AsyncIterator, Callable, cast

from app.adapters.case_converters import camelToSnake, snakeToCamel
from app.adapters.openai_sse import (
    send_simulated_openai_stream,
    write_openai_sse_data,
    write_openai_sse_done,
    write_openai_sse_error,
    write_openai_sse_headers,
)
from app.adapters.proxy_tools import (
    appendMissingOpenaiTools,
    execute_managed_openai_tool_calls,
    execute_managed_proxy_tool,
    format_managed_tool_result,
    get_proxy_openai_tool_definitions,
    get_tool_definition_name,
    is_proxy_managed_local_tool_name,
)
from app.adapters.stream_state import OpenaiStreamAccumulator, ToolCallDelta
from app.adapters.tool_classification import classifyOpenaiToolCalls
from app.adapters.upstream_errors import UpstreamError, normalize_upstream_error
from app.json_narrowing import as_bool, as_dict, as_int, as_list, as_str
from app.models import ChatCompletionRequest, ChatMessage
from app.models.openai import dump_openai_upstream_body
from app.providers import resolver as providerResolver
from app.providers.clients import BaseProviderClient, getClient
from app.providers.model_resolver import resolve
from app.type_aliases import JsonValue

# Back-compat aliases (previous camelCase names on this module).
writeOpenaiSseHeaders = write_openai_sse_headers
writeOpenaiSseData = write_openai_sse_data
writeOpenaiSseError = write_openai_sse_error
writeOpenaiSseDone = write_openai_sse_done
sendSimulatedOpenaiStream = send_simulated_openai_stream

# 0 = unlimited managed tool rounds (default). Positive values cap the loop.
MAX_MANAGED_TOOL_ROUNDS = 0


def deriveSessionIdFromOpenai(
    body: ChatCompletionRequest | dict[str, object] | None, request: object | None = None
) -> str:
    """Extract a session identifier from an OpenAI Chat Completions body.

    Order: explicit sessionId → user field → metadata.sessionId → headers → ''.
    """
    if isinstance(body, ChatCompletionRequest):
        from_model = getattr(body, 'sessionId', None) or getattr(body, 'session_id', None)
        if from_model:
            return str(from_model)
        metadata = getattr(body, 'metadata', None)
        if isinstance(metadata, dict):
            from_meta = metadata.get('sessionId') or metadata.get('session_id')
            if from_meta:
                return str(from_meta)
    elif body and isinstance(body, dict):
        metadata = as_dict(body.get('metadata'), {})
        fromBody = (
            body.get('sessionId')
            or body.get('session_id')
            or metadata.get('sessionId')
            or metadata.get('session_id')
            or body.get('user')
        )
        if fromBody:
            return str(fromBody)
    if request and hasattr(request, 'headers'):
        headerKeys = [
            'x-session-id',
            'x-conversation-id',
            'x-claude-code-session-id',
            'x-request-id',
            'x-correlation-id',
        ]
        for key in headerKeys:
            value = request.headers.get(key)
            if value:
                return str(value)
    return ''


def deriveModelInheritanceSessionId(body: dict[str, object] | None, request: object | None = None) -> str:
    """Extract session ID specifically for model inheritance lookups."""
    if body and isinstance(body, dict):
        metadata = as_dict(body.get('metadata'), {})
        fromBody = (
            body.get('sessionId') or body.get('session_id') or metadata.get('sessionId') or metadata.get('session_id')
        )
        if fromBody:
            return str(fromBody)
    if request and hasattr(request, 'headers'):
        for key in ['x-session-id', 'x-conversation-id', 'x-claude-code-session-id']:
            value = request.headers.get(key)
            if value:
                return str(value)
    return ''


def getOpenaiCompatibleProfile(providerName: str | None, model: str) -> dict[str, object] | None:
    """Resolve an OpenAI-compatible provider profile for a model."""
    resolved = providerResolver.resolve(providerName or model)
    if not resolved:
        return None
    client = getClient(resolved)
    if client and client.apiFormat in ('openaiChat', 'openaiResponses'):
        return resolved
    return None


def mergeOpenaiCompatibleProfile(
    profile: dict[str, object], baseUrl: str | None = None, apiKey: str | None = None
) -> dict[str, object]:
    """Merge override values into a provider profile."""
    merged = dict(profile)
    if baseUrl:
        merged['baseUrl'] = baseUrl
    if apiKey:
        merged['api_key'] = apiKey
    return merged


def toOpenaiCompatibleTargetUrl(baseUrl: str) -> str:
    """``baseUrl`` (host+prefix) + ``/chat/completions``.

    Accepts a clean base (``https://api.kilo.ai/api/gateway``) or a pasted
    full chat URL (leaf is stripped then re-appended once).
    """
    from app.providers.api_format import join_provider_url

    return join_provider_url(baseUrl, 'chat', 'completions')


def createOpenaiStreamAccumulator() -> OpenaiStreamAccumulator:
    """Backward-compat: return a new OpenaiStreamAccumulator instance."""
    return OpenaiStreamAccumulator()


def accumulateOpenaiChunk(acc: OpenaiStreamAccumulator, chunk: dict[str, object]) -> None:
    """Backward-compat: delegate to OpenaiStreamAccumulator.accumulate."""
    acc.accumulate(chunk)  # type: ignore[arg-type]


def buildOpenaiAggregatedFromStream(acc: OpenaiStreamAccumulator) -> dict[str, object]:
    """Backward-compat: delegate to OpenaiStreamAccumulator.build_response."""
    return acc.build_response()  # type: ignore[return-value]


def isOpenaiToolResultError(toolMessage: ChatMessage | dict[str, object]) -> bool:
    """Check if a tool result contains an error pattern."""
    if isinstance(toolMessage, ChatMessage):
        content = getattr(toolMessage, 'content', '')
    else:
        content = toolMessage.get('content', '')
    if isinstance(content, str):
        lower = content.lower()
        return (
            'error:' in lower
            or 'exit code' in lower
            or 'command not found' in lower
            or ('no such file' in lower)
            or ('permission denied' in lower)
        )
    return False


async def fallbackClientFailedToolsOpenai(
    messages: list[dict[str, object]], managedLocalToolNames: set[str]
) -> list[dict[str, object]]:
    """Detect and retry client-failed managed tools.

    Scans trailing tool messages for error patterns and re-executes
    any managed tools that appear to have failed on the client side.
    """
    if not messages:
        return messages
    updated = list(messages)
    changed = False
    for i in range(len(updated) - 1, -1, -1):
        msg = updated[i]
        if msg.get('role') != 'tool':
            break
        if not isOpenaiToolResultError(msg):
            continue
        toolCallId = msg.get('tool_call_id', '')
        for j in range(i - 1, -1, -1):
            prev = updated[j]
            if prev.get('role') != 'assistant':
                break
            for tc in cast('list[dict[str, object]]', as_list(prev.get('tool_calls'), [])):
                fn = as_dict(tc.get('function', {}))
                if tc.get('id') == toolCallId and fn.get('name'):
                    name = as_str(fn.get('name'), '')
                    if name in managedLocalToolNames:
                        try:
                            args = json.loads(as_str(fn.get('arguments'), '{}'))
                        except (json.JSONDecodeError, TypeError):
                            args = {}
                        try:
                            result = await execute_managed_proxy_tool(name, args)
                            updated[i] = {
                                'tool_call_id': toolCallId,
                                'role': 'tool',
                                'content': format_managed_tool_result(name, result),
                            }
                            changed = True
                        except Exception as exc:
                            updated[i] = {
                                'tool_call_id': toolCallId,
                                'role': 'tool',
                                'content': f'Fallback error: {exc}',
                            }
                            changed = True
                    break
            break
    return updated if changed else messages


async def resolveManagedOpenaiToolCalls(
    messages: list[dict[str, object]] | list[ChatMessage],
    model: str,
    upstreamUrl: str,
    upstreamHeaders: dict[str, str],
    knownTools: list[dict[str, object]],
    managedLocalToolNames: set[str],
    clientToolNames: set[str],
    workspacePath: str | None = None,
    onToolEvent: Callable[[dict[str, object]], None] | None = None,
    parentSignal: object = None,
    client: object = None,
) -> tuple[list[dict[str, object]], dict[str, object] | None]:
    """Run the multi-round tool resolution loop.

    For each round:
    1. Call upstream with current messages
    2. Classify tool calls
    3. If only managed tools, execute them locally and append results
    4. If client tools are present, return the response for passthrough
    5. Repeat until no managed tools remain or max rounds reached
    """
    currentMessages = cast('list[dict[str, object]]', list(messages))
    finalUsage: dict[str, object] | None = None
    # 0 = unlimited; positive values cap managed tool rounds.
    _round = 0
    while True:
        _round += 1
        if MAX_MANAGED_TOOL_ROUNDS > 0 and _round > MAX_MANAGED_TOOL_ROUNDS:
            break
        reqBody = cast(
            dict[str, object],
            camelToSnake({'model': model, 'messages': currentMessages, 'tools': knownTools, 'stream': False}),
        )
        resp = await cast('BaseProviderClient', client).requestJson('POST', upstreamUrl, upstreamHeaders, reqBody)
        if resp.is_error:
            raise UpstreamError(resp)
        rawBody = as_dict(cast(JsonValue, resp.body_json), {})
        if rawBody.get('usage'):
            # Read usage from the raw body BEFORE snakeToCamel — OpenAI clients
            # read `prompt_tokens`/`completion_tokens`, not camelCase keys.
            finalUsage = cast('dict[str, object]', rawBody['usage'])
        responseBody = as_dict(snakeToCamel(cast(JsonValue, resp.body_json)), {})
        choices = as_list(responseBody.get('choices'), [])
        if not choices:
            break
        choice = as_dict(choices[0], {})
        message = as_dict(choice.get('message'), {})
        toolCalls = cast('list[dict[str, object]]', as_list(message.get('tool_calls'), []))
        if not toolCalls:
            currentMessages.append(message)
            break
        classification = classifyOpenaiToolCalls(toolCalls, managedLocalToolNames, clientToolNames)
        if not classification['has_managed']:
            currentMessages.append(message)
            break
        toolResults = await execute_managed_openai_tool_calls(
            classification['managed_tool_calls'], knownTools, currentMessages, workspacePath, onToolEvent, parentSignal
        )
        currentMessages.append(message)
        currentMessages.extend(toolResults)
        if classification['has_client_or_unknown']:
            break
    return (currentMessages, finalUsage)


async def streamOpenaiSseToClient(
    upstreamUrl: str, upstreamHeaders: dict[str, str], body: dict[str, object]
) -> AsyncIterator[str]:
    """Pipe SSE events directly from upstream to client.

    Response headers (including Content-Type: text/event-stream) are supplied
    by the caller via the StreamingResponse headers param, so this generator
    yields only SSE data strings.
    """
    body['stream'] = True
    bodyJson = cast(dict[str, object], as_dict(camelToSnake(body), {}))
    client = await _getClient()
    async for rawEvent in client.streamSse(upstreamUrl, upstreamHeaders, bodyJson):
        event = cast('dict[str, object]', rawEvent)
        if as_str(event.get('type'), '') == 'error':
            yield write_openai_sse_error(as_str(event.get('body'), as_str(event.get('error'), '')))
            yield write_openai_sse_done()
            return
        if event.get('_event_type'):
            del event['_event_type']
        yield write_openai_sse_data(event)
        choices = as_list(event.get('choices'), [])
        if choices and isinstance(choices[0], dict) and as_dict(choices[0], {}).get('finish_reason'):
            if event.get('usage'):
                yield write_openai_sse_data({'choices': [], 'usage': event['usage']})
            yield write_openai_sse_done()
            return
    yield write_openai_sse_done()


async def streamUpstreamAndResolveToolsOpenai(
    upstreamUrl: str,
    upstreamHeaders: dict[str, str],
    body: ChatCompletionRequest | dict[str, object],
    model: str,
    knownTools: list[dict[str, object]],
    managedLocalToolNames: set[str],
    clientToolNames: set[str],
    workspacePath: str | None = None,
    onToolEvent: Callable[[dict[str, object]], None] | None = None,
) -> AsyncIterator[str]:
    """Stream from upstream, intercept tool calls, resolve them, and continue.

    This is the key function for handling streaming with managed tool execution.
    """
    acc = OpenaiStreamAccumulator()
    toolRound = 0
    raw_body = dump_openai_upstream_body(body)
    currentMessages = cast('list[dict[str, object]]', as_list(raw_body.get('messages'), []))
    streamBody = cast('dict[str, object]', camelToSnake({**raw_body, 'stream': True}))
    client = await _getClient()
    async for chunk in client.streamSse(upstreamUrl, upstreamHeaders, streamBody):
        if chunk.get('type') == 'error':
            yield write_openai_sse_error(as_str(chunk.get('body'), as_str(chunk.get('error'), '')))
            yield write_openai_sse_done()
            return
        acc.accumulate(chunk)
        yield write_openai_sse_data(chunk)
        choices = as_list(chunk.get('choices'), [])
        if (
            choices
            and isinstance(choices[0], dict)
            and as_dict(choices[0], {}).get('finish_reason') in ('tool_calls', 'stop')
        ):
            if acc.tool_calls:
                toolRound += 1
                # 0 = unlimited managed tool rounds
                if MAX_MANAGED_TOOL_ROUNDS > 0 and toolRound > MAX_MANAGED_TOOL_ROUNDS:
                    break
                toolCallDicts = [tc.to_openai_dict() for tc in acc.tool_calls]
                assistantMsg: dict[str, object] = {'role': 'assistant', 'content': acc.content}
                from app.adapters.reasoning_policy import attach_openai_reasoning

                attach_openai_reasoning(assistantMsg, acc.reasoning)
                if toolCallDicts:
                    assistantMsg['tool_calls'] = toolCallDicts
                currentMessages.append(assistantMsg)
                classification = classifyOpenaiToolCalls(toolCallDicts, managedLocalToolNames, clientToolNames)
                under_cap = MAX_MANAGED_TOOL_ROUNDS <= 0 or toolRound < MAX_MANAGED_TOOL_ROUNDS
                if classification['has_managed'] and (
                    classification['can_execute_managed'] or under_cap
                ):
                    toolResults = await execute_managed_openai_tool_calls(
                        classification['managed_tool_calls'], knownTools, currentMessages, workspacePath, onToolEvent
                    )
                    currentMessages.extend(toolResults)
                    acc = OpenaiStreamAccumulator()
                    nextBody = cast(
                        'dict[str, object]',
                        camelToSnake(
                            {'model': model, 'messages': currentMessages, 'tools': knownTools, 'stream': True}
                        ),
                    )
                    client = await _getClient()
                    async for nextChunk in client.streamSse(upstreamUrl, upstreamHeaders, nextBody):
                        if nextChunk.get('type') == 'error':
                            yield write_openai_sse_error(as_str(nextChunk.get('body'), ''))
                            yield write_openai_sse_done()
                            return
                        acc.accumulate(nextChunk)
                        yield write_openai_sse_data(nextChunk)
                        nchoices = as_list(nextChunk.get('choices'), [])
                        if nchoices and isinstance(nchoices[0], dict) and as_dict(nchoices[0], {}).get('finish_reason'):
                            break
                    nextToolDicts = [tc.to_openai_dict() for tc in acc.tool_calls] if acc.tool_calls else []
                    nextAssistant: dict[str, object] = {
                        'role': 'assistant',
                        'content': acc.content,
                        **({'tool_calls': nextToolDicts} if nextToolDicts else {}),
                    }
                    from app.adapters.reasoning_policy import attach_openai_reasoning

                    attach_openai_reasoning(nextAssistant, acc.reasoning)
                    currentMessages.append(nextAssistant)
                    if acc.usage:
                        yield write_openai_sse_data({'choices': [], 'usage': acc.usage})
            yield write_openai_sse_done()
            return
    yield write_openai_sse_done()


async def handleChatCompletions(
    body: ChatCompletionRequest | dict[str, object], request: object = None
) -> tuple[dict[str, object] | AsyncIterator[str], dict[str, str] | None]:
    """Handle a /v1/chat/completions or /v1/responses request.

    Returns a tuple of (response_or_stream, response_headers).
    """
    if isinstance(body, ChatCompletionRequest):
        model = body.model
        raw_body = dump_openai_upstream_body(body)
    else:
        model = as_str(body.get('model'), 'gpt-4o')
        raw_body = dump_openai_upstream_body(body)
    try:
        resolved = resolve(model, default_alias='gpt-4o')
        providerName = as_str(resolved.get('provider'), '')
    except Exception:
        providerName = model
    provider = providerResolver.resolve(providerName or model)
    if not provider:
        return ({'error': 'No provider available for model', 'model': model}, None)
    # Per-model format override (multi-format gateways like OpenCode Zen): the
    # model's own apiFormat wins over the provider-level format.
    from app.providers.resolver import apply_model_format_override

    provider = apply_model_format_override(provider, model)
    if provider is None:
        return ({'error': 'No provider available for model', 'model': model}, None)
    client = getClient(provider)
    if not client:
        return ({'error': f'No client for provider: {provider.get("name")}'}, None)
    # A model whose own format is Anthropic Messages speaks the Anthropic wire
    # protocol — translate the OpenAI request body and translate the upstream
    # stream back to OpenAI SSE for the client.
    if getattr(client, 'apiFormat', '') == 'anthropicMessages':
        return await _handleOpenaiBodyToAnthropicUpstream(client, model, raw_body)
    apiKey = client.resolveApiKey()
    if not apiKey:
        return ({'error': 'API key not configured for provider'}, None)
    headers = client.buildAuthHeaders(apiKey)
    baseUrl = client.resolveBaseUrl()
    upstreamUrl = toOpenaiCompatibleTargetUrl(baseUrl)
    clientWantsStream = raw_body.get('stream', False)
    isResponsesEndpoint = raw_body.get('_endpoint') == 'responses'
    knownTools = get_proxy_openai_tool_definitions()
    clientTools = cast('list[dict[str, object]]', as_list(raw_body.get('tools'), []))
    if clientTools:
        appendMissingOpenaiTools(knownTools, clientTools)
    managedLocalToolNames: set[str] = set()
    clientToolNames: set[str] = set()
    # Proxy-injected managed tools are always locally executable
    for t in knownTools:
        name = get_tool_definition_name(t)
        if name and is_proxy_managed_local_tool_name(name):
            managedLocalToolNames.add(name)
    # Client-listed tools: separate managed from client-owned
    for t in clientTools or []:
        name = get_tool_definition_name(t)
        if name and is_proxy_managed_local_tool_name(name):
            managedLocalToolNames.add(name)
        elif name:
            clientToolNames.add(name)
    hasManagedTools = len(managedLocalToolNames) > 0
    if isResponsesEndpoint:
        raw_body['stream'] = False
        upstream_body = cast('dict[str, object]', camelToSnake(raw_body))
        # The internal `_endpoint` routing marker must never reach the
        # upstream validator (strict gateways 400 on unknown keys).
        upstream_body.pop('_endpoint', None)
        # Responses API speaks `input`, not `messages` — translate a
        # chat-shaped body so the same request works on both endpoints.
        msgs = as_list(upstream_body.get('messages'), [])
        if msgs:
            upstream_body['input'] = [
                {
                    'role': as_str(m.get('role'), 'user'),
                    'content': as_str(m.get('content'), ''),
                }
                for m in msgs
                if isinstance(m, dict)
            ]
            upstream_body.pop('messages', None)
        resp = await client.requestJson(
            'POST',
            upstreamUrl.replace('/chat/completions', '/responses'),
            headers,
            upstream_body,
        )
        if resp.is_error:
            return (normalize_upstream_error(resp), None)
        return (
            cast(
                'dict[str, object]',
                snakeToCamel(resp.body) if isinstance(resp.body, (dict, list)) else {'response': str(resp.body)},
            ),
            None,
        )
    if clientWantsStream:
        if hasManagedTools:
            stream = streamUpstreamAndResolveToolsOpenai(
                upstreamUrl, headers, raw_body, model, knownTools, managedLocalToolNames, clientToolNames
            )
        else:
            stream = streamOpenaiSseToClient(upstreamUrl, headers, raw_body)
        return (stream, write_openai_sse_headers())
    else:
        raw_body['stream'] = False
        if hasManagedTools:
            messages = cast('list[dict[str, object]]', as_list(raw_body.get('messages'), []))
            try:
                updatedMessages, usage = await resolveManagedOpenaiToolCalls(
                    messages, model, upstreamUrl, headers, knownTools, managedLocalToolNames, clientToolNames, client=client
                )
            except UpstreamError as exc:
                # Never answer 200 with the user's own text when the upstream
                # call failed — surface the real error to the client.
                return (normalize_upstream_error(exc.resp), None)
            lastMsg = updatedMessages[-1] if updatedMessages else {}
            response_acc = OpenaiStreamAccumulator(
                id=f'chatcmpl-{uuid.uuid4().hex[:12]}',
                model=model,
                created=int(time.time()),
                content=str(lastMsg.get('content', '')),
                finish_reason='stop' if not lastMsg.get('tool_calls') else 'tool_calls',
                usage=usage or {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0},
            )
            for tc in as_list(lastMsg.get('tool_calls'), []):
                if isinstance(tc, dict):
                    fn = tc.get('function', {}) or {}
                    response_acc.tool_calls.append(
                        ToolCallDelta(
                            id=tc.get('id', ''),
                            function_name=fn.get('name', '') if isinstance(fn, dict) else '',
                            function_arguments=fn.get('arguments', '') if isinstance(fn, dict) else '',
                        )
                    )
            response = response_acc.build_response()
            return (response, None)
        else:
            resp = await client.requestJson(
                'POST', upstreamUrl, headers, cast('dict[str, object]', camelToSnake(raw_body))
            )
            if resp.is_error:
                return (normalize_upstream_error(resp), None)
            return (
                cast(
                    'dict[str, object]',
                    snakeToCamel(resp.body) if isinstance(resp.body, (dict, list)) else {'response': str(resp.body)},
                ),
                None,
            )


_stream_client: BaseProviderClient | None = None
_stream_client_lock = asyncio.Lock()


# --- OpenAI-format request → Anthropic Messages upstream --------------------
# Used when a model entry overrides the provider format to 'anthropicMessages'
# (multi-format gateways like OpenCode Zen serve Claude models at /v1/messages).
# Scope: text + tool definitions; tool_use responses stream as text only
# (managed tool execution is not available on this translated path).


def _openaiContentToText(content: object) -> str:
    """OpenAI message content → plain text (string or text parts)."""
    if isinstance(content, str):
        return content
    out: list[str] = []
    for part in as_list(content, []):
        p = as_dict(part, {})
        if as_str(p.get('type'), 'text') == 'text':
            out.append(as_str(p.get('text'), ''))
    return '\n'.join(out)


def _openaiContentToAnthropic(content: object) -> object:
    """OpenAI message content → Anthropic content (string or text/image blocks)."""
    if isinstance(content, str):
        return content
    parts = as_list(content, [])
    if not parts:
        return ''
    blocks: list[dict[str, object]] = []
    for part in parts:
        p = as_dict(part, {})
        ptype = as_str(p.get('type'), 'text')
        if ptype == 'text':
            blocks.append({'type': 'text', 'text': as_str(p.get('text'), '')})
        elif ptype == 'image_url':
            url = as_str(as_dict(p.get('image_url'), {}).get('url'), '')
            if url:
                blocks.append({'type': 'image', 'source': {'type': 'url', 'url': url}})
    return blocks


def _openaiToolToAnthropic(tool: dict[str, object]) -> dict[str, object]:
    fn = as_dict(tool.get('function'), {})
    return {
        'name': as_str(fn.get('name'), ''),
        'description': as_str(fn.get('description'), ''),
        'input_schema': fn.get('parameters') or {'type': 'object', 'properties': {}},
    }


def _openaiToAnthropicBody(body: dict[str, object]) -> dict[str, object]:
    """Translate an OpenAI chat-completions request body to Anthropic messages."""
    system_parts: list[str] = []
    messages: list[dict[str, object]] = []
    raw_msgs = as_list(body.get('messages'), [])
    i = 0
    while i < len(raw_msgs):
        msg = as_dict(raw_msgs[i], {})
        role = as_str(msg.get('role'), 'user')
        content = msg.get('content')
        if role == 'system':
            system_parts.append(_openaiContentToText(content))
            i += 1
            continue
        if role == 'tool':
            # Group consecutive tool messages into a single user message
            # with multiple tool_result blocks (Anthropic API requirement).
            tool_blocks: list[dict[str, object]] = []
            while i < len(raw_msgs) and as_str(as_dict(raw_msgs[i], {}).get('role'), '') == 'tool':
                tmsg = as_dict(raw_msgs[i], {})
                tool_blocks.append(
                    {
                        'type': 'tool_result',
                        'tool_use_id': as_str(tmsg.get('tool_call_id'), ''),
                        'content': _openaiContentToText(tmsg.get('content')),
                    }
                )
                i += 1
            messages.append({'role': 'user', 'content': tool_blocks})
            continue
        if role == 'assistant':
            blocks: list[dict[str, object]] = []
            text = _openaiContentToText(content)
            has_tool_calls = False
            for tc in as_list(msg.get('tool_calls'), []):
                has_tool_calls = True
                tcd = as_dict(tc, {})
                fn = as_dict(tcd.get('function'), {})
                args_raw = as_str(fn.get('arguments'), '')
                args: dict[str, object] = {}
                if args_raw:
                    try:
                        parsed = json.loads(args_raw)
                        if isinstance(parsed, dict):
                            args = parsed
                    except (TypeError, ValueError):
                        args = {}
                blocks.append(
                    {
                        'type': 'tool_use',
                        'id': as_str(tcd.get('id'), ''),
                        'name': as_str(fn.get('name'), ''),
                        'input': args,
                    }
                )
            if has_tool_calls:
                if text:
                    blocks.insert(0, {'type': 'text', 'text': text})
                messages.append({'role': 'assistant', 'content': blocks})
            else:
                messages.append({'role': 'assistant', 'content': text})
            i += 1
            continue
        messages.append({'role': role, 'content': _openaiContentToAnthropic(content)})
        i += 1
    out: dict[str, object] = {
        'model': as_str(body.get('model'), ''),
        'max_tokens': as_int(body.get('max_tokens'), 4096),
        'messages': messages,
    }
    if system_parts:
        out['system'] = '\n\n'.join(system_parts)
    for key in ('temperature', 'top_p'):
        if body.get(key) is not None:
            out[key] = body[key]
    if body.get('stop') is not None:
        # Anthropic's parameter is `stop_sequences`; forwarding `stop` (str or
        # list) makes strict Anthropic gateways 400 — this path is what the
        # per-model apiFormat override uses for Claude models behind OpenAI
        # clients.
        out['stop_sequences'] = body['stop']
    tools = as_list(body.get('tools'), [])
    if tools:
        out['tools'] = [_openaiToolToAnthropic(t) for t in tools if isinstance(t, dict)]
    return out


def _anthropicStopToOpenaiFinish(stop_reason: str) -> str | None:
    """Map an Anthropic stop_reason to an OpenAI finish_reason."""
    if stop_reason in ('end_turn', 'stop_sequence'):
        return 'stop'
    if stop_reason == 'max_tokens':
        return 'length'
    if stop_reason == 'tool_use':
        return 'tool_calls'
    return None


def _anthropicUsageToOpenai(usage: object) -> dict[str, int]:
    u = as_dict(usage, {})
    prompt = as_int(u.get('input_tokens'), 0)
    completion = as_int(u.get('output_tokens'), 0)
    return {'prompt_tokens': prompt, 'completion_tokens': completion, 'total_tokens': prompt + completion}


async def _streamAnthropicAsOpenai(
    client: BaseProviderClient,
    model: str,
    body: dict[str, object],
    apiKey: str | None,
) -> AsyncIterator[str]:
    """Stream an Anthropic Messages response and translate it to OpenAI SSE."""
    created = int(time.time())
    chunk_id = f'chatcmpl-{uuid.uuid4().hex[:12]}'
    done = False
    try:
        async for event in client.messages_stream(body, apiKey):
            etype = as_str(event.get('type'), '')
            if etype == 'message_start':
                yield write_openai_sse_data(
                    {
                        'id': chunk_id,
                        'object': 'chat.completion.chunk',
                        'created': created,
                        'model': model,
                        'choices': [{'index': 0, 'delta': {'role': 'assistant'}, 'finish_reason': None}],
                    }
                )
            elif etype == 'content_block_delta':
                delta = as_dict(event.get('delta'), {})
                text = as_str(delta.get('text'), '')
                if text:
                    yield write_openai_sse_data(
                        {
                            'id': chunk_id,
                            'object': 'chat.completion.chunk',
                            'created': created,
                            'model': model,
                            'choices': [{'index': 0, 'delta': {'content': text}, 'finish_reason': None}],
                        }
                    )
            elif etype == 'message_delta':
                delta = as_dict(event.get('delta'), {})
                finish = _anthropicStopToOpenaiFinish(as_str(delta.get('stop_reason'), ''))
                if finish:
                    yield write_openai_sse_data(
                        {
                            'id': chunk_id,
                            'object': 'chat.completion.chunk',
                            'created': created,
                            'model': model,
                            'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}],
                        }
                    )
                if event.get('usage') is not None:
                    yield write_openai_sse_data({'choices': [], 'usage': _anthropicUsageToOpenai(event.get('usage'))})
            elif etype == 'error':
                yield write_openai_sse_error(as_str(event.get('body'), as_str(event.get('error'), 'Upstream error')))
                done = True
                yield write_openai_sse_done()
                break
    except Exception as exc:
        yield write_openai_sse_error(str(exc))
    if not done:
        yield write_openai_sse_done()


def _anthropicJsonToOpenaiResponse(resp_body: object, model: str) -> dict[str, object]:
    """Translate a non-streaming Anthropic Messages response to OpenAI shape."""
    body = as_dict(resp_body, {})
    text_parts: list[str] = []
    for b in as_list(body.get('content'), []):
        if isinstance(b, dict) and as_str(b.get('type'), '') == 'text':
            text_parts.append(as_str(b.get('text'), ''))
    finish = _anthropicStopToOpenaiFinish(as_str(body.get('stop_reason'), '')) or 'stop'
    return {
        'id': as_str(body.get('id'), f'chatcmpl-{uuid.uuid4().hex[:12]}'),
        'object': 'chat.completion',
        'created': int(time.time()),
        'model': model,
        'choices': [
            {
                'index': 0,
                'message': {'role': 'assistant', 'content': ''.join(text_parts)},
                'finish_reason': finish,
            }
        ],
        'usage': _anthropicUsageToOpenai(body.get('usage')),
    }


async def _handleOpenaiBodyToAnthropicUpstream(
    client: BaseProviderClient,
    model: str,
    raw_body: dict[str, object],
) -> tuple[dict[str, object] | AsyncIterator[str], dict[str, str] | None]:
    """Route an OpenAI-format chat request to an Anthropic-format upstream.

    Triggered when the resolved model's own ``apiFormat`` is
    ``anthropicMessages`` (e.g. a Claude model on OpenCode Zen).
    """
    if as_str(raw_body.get('_endpoint'), '') == 'responses':
        return (
            {'error': f'Model {model} uses the Anthropic messages format; call /v1/messages instead'},
            None,
        )
    apiKey = client.resolveApiKey()
    if not apiKey:
        return ({'error': 'API key not configured for provider'}, None)
    body = _openaiToAnthropicBody(raw_body)
    if as_bool(raw_body.get('stream'), False):
        return (_streamAnthropicAsOpenai(client, model, body, apiKey), write_openai_sse_headers())
    resp = await client.messages(body, apiKey)
    if resp.is_error:
        return ({'error': f'Upstream error (status {resp.status})'}, None)
    return (_anthropicJsonToOpenaiResponse(resp.body, model), None)


async def _getClient() -> BaseProviderClient:
    """Lazy shared HTTP client for passthrough streaming.

    Auth/base URL come from the caller-supplied ``upstreamUrl`` /
    ``upstreamHeaders`` — this client is only the httpx transport.
    Constructed on first use (not at import time).
    """
    global _stream_client
    if _stream_client is None:
        async with _stream_client_lock:
            if _stream_client is None:
                from app.providers.clients.openai import OpenAIClient

                _stream_client = OpenAIClient({})
    return _stream_client
