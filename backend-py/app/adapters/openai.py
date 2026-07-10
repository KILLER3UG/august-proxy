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
import json
import time
import uuid
from typing import AsyncIterator, Callable
from app.adapters.base import streamSse, buildHeaders
from app.adapters.proxyTools import getProxyOpenaiToolDefinitions, appendMissingOpenaiTools, getCanonicalManagedOpenaiWebTools, formatManagedToolResult, executeManagedProxyTool, executeManagedOpenaiToolCalls, getToolDefinitionName, isProxyManagedLocalToolName
from app.adapters.toolClassification import classifyOpenaiToolCalls, getToolNameFromOpenaiTool
from app.adapters.caseConverters import snakeToCamel, camelToSnake
from app.providers import resolver as providerResolver
from app.providers.modelResolver import resolve, resolveOrFallback
from app.providers.clients import getClient
from app.models import ChatCompletionRequest, ChatMessage, ToolCall, Usage
MAX_MANAGED_TOOL_ROUNDS = 10

def deriveSessionIdFromOpenai(body: ChatCompletionRequest | dict[str, object] | None, request: object | None=None) -> str:
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
        fromBody = body.get('sessionId') or body.get('session_id') or body.get('metadata', {}).get('sessionId') or body.get('metadata', {}).get('session_id') or body.get('user')
        if fromBody:
            return str(fromBody)
    if request and hasattr(request, 'headers'):
        headerKeys = ['x-session-id', 'x-conversation-id', 'x-claude-code-session-id', 'x-request-id', 'x-correlation-id']
        for key in headerKeys:
            value = request.headers.get(key)
            if value:
                return str(value)
    return ''

def deriveModelInheritanceSessionId(body: dict[str, object] | None, request: object | None=None) -> str:
    """Extract session ID specifically for model inheritance lookups."""
    if body and isinstance(body, dict):
        fromBody = body.get('sessionId') or body.get('session_id') or body.get('metadata', {}).get('sessionId') or body.get('metadata', {}).get('session_id')
        if fromBody:
            return str(fromBody)
    if request and hasattr(request, 'headers'):
        for key in ['x-session-id', 'x-conversation-id', 'x-claude-code-session-id']:
            value = request.headers.get(key)
            if value:
                return str(value)
    return ''

def extractRequestHeaders(request: object) -> dict[str, str]:
    """Safely extract relevant request headers into a plain dict."""
    if not request or not hasattr(request, 'headers'):
        return {}
    out: dict[str, str] = {}
    keys = ['x-session-id', 'x-conversation-id', 'x-request-id', 'x-correlation-id', 'user-agent', 'x-august-client']
    for key in keys:
        value = request.headers.get(key)
        if value:
            out[key] = str(value)
    return out

def getOpenaiCompatibleProfile(providerName: str | None, model: str) -> dict[str, object] | None:
    """Resolve an OpenAI-compatible provider profile for a model."""
    resolved = providerResolver.resolve(providerName or model)
    if not resolved:
        return None
    client = getClient(resolved)
    if client and client.api_format in ('openaiChat', 'codexResponses'):
        return resolved
    return None

def mergeOpenaiCompatibleProfile(profile: dict[str, object], baseUrl: str | None=None, apiKey: str | None=None) -> dict[str, object]:
    """Merge override values into a provider profile."""
    merged = dict(profile)
    if baseUrl:
        merged['baseUrl'] = baseUrl
    if apiKey:
        merged['api_key'] = apiKey
    return merged

def toOpenaiCompatibleTargetUrl(baseUrl: str) -> str:
    """Ensure the base URL ends with /chat/completions.

    Handles:
    - Already has /chat/completions → return as-is
    - Ends with /v1 → append /chat/completions
    - Already has version prefix (e.g., /v1beta/openai) → append /chat/completions
    - Otherwise → append /v1/chat/completions
    """
    base = baseUrl.rstrip('/')
    if base.endswith('/chat/completions'):
        return base
    if base.endswith('/v1'):
        return f'{base}/chat/completions'
    if '/v1' in base or '/v2' in base:
        return f'{base}/chat/completions'
    return f'{base}/v1/chat/completions'

def writeOpenaiSseHeaders() -> dict[str, str]:
    """Return SSE response headers for OpenAI-compatible streaming."""
    return {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'}

def writeOpenaiSseData(chunk: dict[str, object]) -> str:
    """Serialize a chunk as SSE data line."""
    return f'data: {json.dumps(chunk)}\n\n'

def writeOpenaiSseError(error: str) -> str:
    """Serialize an error as SSE."""
    return writeOpenaiSseData({'error': {'message': error}})

def writeOpenaiSseDone() -> str:
    """Return the terminal SSE event."""
    return 'data: [DONE]\n\n'

def sendSimulatedOpenaiStream(response: dict[str, object]) -> list[str]:
    """Create SSE events from a full JSON response, simulating a stream."""
    events: list[str] = [writeOpenaiSseHeaders()]
    responseId = response.get('id', f'chatcmpl-{uuid.uuid4().hex[:12]}')
    created = response.get('created', int(time.time()))
    model = response.get('model', 'unknown')
    choices = response.get('choices', [])
    for choice in choices:
        index = choice.get('index', 0)
        delta = choice.get('delta') or choice.get('message', {})
        events.append(writeOpenaiSseData({'id': responseId, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': index, 'delta': delta, 'finish_reason': None}]}))
        events.append(writeOpenaiSseData({'id': responseId, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': index, 'delta': {}, 'finish_reason': choice.get('finish_reason', 'stop')}]}))
    if response.get('usage'):
        events.append(writeOpenaiSseData({'id': responseId, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [], 'usage': response['usage']}))
    events.append(writeOpenaiSseDone())
    return events

def createOpenaiStreamAccumulator() -> dict[str, object]:
    """Create a state object for accumulating streaming chunks."""
    return {'id': '', 'model': '', 'created': 0, 'content': '', 'reasoning': '', 'tool_calls': [], 'finish_reason': None, 'usage': None}

def accumulateOpenaiChunk(acc: dict[str, object], chunk: dict[str, object]) -> None:
    """Accumulate a streaming chunk into the accumulator state."""
    if chunk.get('id'):
        acc['id'] = chunk['id']
    if chunk.get('model'):
        acc['model'] = chunk['model']
    if chunk.get('created'):
        acc['created'] = chunk['created']
    if chunk.get('usage'):
        acc['usage'] = chunk['usage']
    choices = chunk.get('choices', [])
    for choice in choices:
        delta = choice.get('delta', {})
        if choice.get('finish_reason'):
            acc['finish_reason'] = choice['finish_reason']
        if delta.get('content'):
            acc['content'] += delta['content']
        if delta.get('reasoning') or delta.get('reasoning_content'):
            acc['reasoning'] += delta.get('reasoning', '') or delta.get('reasoning_content', '')
        if delta.get('tool_calls'):
            for tc in delta['tool_calls']:
                existing = next((t for t in acc['tool_calls'] if t.get('index') == tc.get('index')), None)
                if existing:
                    if tc.get('id'):
                        existing['id'] = tc['id']
                    if tc.get('function', {}).get('name'):
                        existing.setdefault('function', {})['name'] = existing.get('function', {}).get('name', '') + tc['function']['name']
                    if tc.get('function', {}).get('arguments'):
                        existing.setdefault('function', {})['arguments'] = existing.get('function', {}).get('arguments', '') + tc['function']['arguments']
                else:
                    acc['tool_calls'].append({'index': tc.get('index', 0), 'id': tc.get('id', ''), 'type': tc.get('type', 'function'), 'function': {'name': tc.get('function', {}).get('name', ''), 'arguments': tc.get('function', {}).get('arguments', '')}})

def buildOpenaiAggregatedFromStream(acc: dict[str, object]) -> dict[str, object]:
    """Build a complete response dict from accumulated stream data."""
    responseId = acc.get('id') or f'chatcmpl-{uuid.uuid4().hex[:12]}'
    message: dict[str, object] = {'role': 'assistant', 'content': acc.get('content', '')}
    if acc.get('reasoning'):
        message['reasoning'] = acc['reasoning']
    if acc.get('tool_calls'):
        message['tool_calls'] = [{'id': tc.get('id') or f'call_{uuid.uuid4().hex[:8]}', 'type': 'function', 'function': {'name': tc.get('function', {}).get('name', ''), 'arguments': tc.get('function', {}).get('arguments', '')}} for tc in acc['tool_calls']]
    return {'id': responseId, 'object': 'chat.completion', 'created': acc.get('created') or int(time.time()), 'model': acc.get('model') or 'unknown', 'choices': [{'index': 0, 'message': message, 'finish_reason': acc.get('finish_reason') or 'stop'}], 'usage': acc.get('usage') or {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}}

def isOpenaiToolResultError(toolMessage: ChatMessage | dict[str, object]) -> bool:
    """Check if a tool result contains an error pattern."""
    if isinstance(toolMessage, ChatMessage):
        content = getattr(toolMessage, 'content', '')
    else:
        content = toolMessage.get('content', '')
    if isinstance(content, str):
        lower = content.lower()
        return 'error:' in lower or 'exit code' in lower or 'command not found' in lower or ('no such file' in lower) or ('permission denied' in lower)
    return False

async def fallbackClientFailedToolsOpenai(messages: list[dict[str, object]], managedLocalToolNames: set[str]) -> list[dict[str, object]]:
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
            for tc in prev.get('tool_calls', []):
                if tc.get('id') == toolCallId and tc.get('function', {}).get('name'):
                    name = tc['function']['name']
                    if name in managedLocalToolNames:
                        try:
                            args = json.loads(tc['function'].get('arguments', '{}'))
                        except (json.JSONDecodeError, TypeError):
                            args = {}
                        try:
                            result = await executeManagedProxyTool(name, args)
                            updated[i] = {'tool_call_id': toolCallId, 'role': 'tool', 'content': formatManagedToolResult(name, result)}
                            changed = True
                        except Exception as exc:
                            updated[i] = {'tool_call_id': toolCallId, 'role': 'tool', 'content': f'Fallback error: {exc}'}
                            changed = True
                    break
            break
    return updated if changed else messages

async def resolveManagedOpenaiToolCalls(messages: list[dict[str, object]] | list[ChatMessage], model: str, upstreamUrl: str, upstreamHeaders: dict[str, str], knownTools: list[dict[str, object]], managedLocalToolNames: set[str], clientToolNames: set[str], workspacePath: str | None=None, onToolEvent: Callable[[dict[str, object]], None] | None=None, parentSignal: object=None, client: object=None) -> tuple[list[dict[str, object]], dict[str, object] | None]:
    """Run the multi-round tool resolution loop.

    For each round:
    1. Call upstream with current messages
    2. Classify tool calls
    3. If only managed tools, execute them locally and append results
    4. If client tools are present, return the response for passthrough
    5. Repeat until no managed tools remain or max rounds reached
    """
    currentMessages = list(messages)
    finalUsage: dict[str, object] | None = None
    for _round in range(MAX_MANAGED_TOOL_ROUNDS):
        resp = await client.requestJson('POST', upstreamUrl, upstreamHeaders, camelToSnake({'model': model, 'messages': currentMessages, 'tools': knownTools, 'stream': False}))
        if resp.isError:
            return (currentMessages, None)
        responseBody = snakeToCamel(resp.bodyJson) or {}
        if responseBody.get('usage'):
            finalUsage = responseBody['usage']
        choices = responseBody.get('choices', [])
        if not choices:
            break
        choice = choices[0]
        message = choice.get('message', {})
        finishReason = choice.get('finish_reason', 'stop')
        toolCalls = message.get('tool_calls', [])
        if not toolCalls:
            currentMessages.append(message)
            break
        classification = classifyOpenaiToolCalls(toolCalls, managedLocalToolNames, clientToolNames)
        if not classification['has_managed']:
            currentMessages.append(message)
            break
        toolResults = await executeManagedOpenaiToolCalls(classification['managed_tool_calls'], knownTools, currentMessages, workspacePath, onToolEvent, parentSignal)
        currentMessages.append(message)
        currentMessages.extend(toolResults)
        if classification['has_client_or_unknown']:
            break
    return (currentMessages, finalUsage)

async def streamOpenaiSseToClient(upstreamUrl: str, upstreamHeaders: dict[str, str], body: dict[str, object]) -> AsyncIterator[str]:
    """Pipe SSE events directly from upstream to client.

    Response headers (including Content-Type: text/event-stream) are supplied
    by the caller via the StreamingResponse headers param, so this generator
    yields only SSE data strings.
    """
    body['stream'] = True
    async for event in _client.streamSse(upstreamUrl, upstreamHeaders, camelToSnake(body)):
        if event.get('type') == 'error':
            yield writeOpenaiSseError(event.get('body', str(event.get('error', ''))))
            yield writeOpenaiSseDone()
            return
        if event.get('_event_type'):
            del event['_event_type']
        yield writeOpenaiSseData(event)
        choices = event.get('choices', [])
        if choices and choices[0].get('finish_reason'):
            if event.get('usage'):
                yield writeOpenaiSseData({'choices': [], 'usage': event['usage']})
            yield writeOpenaiSseDone()
            return
    yield writeOpenaiSseDone()

async def streamUpstreamAndResolveToolsOpenai(upstreamUrl: str, upstreamHeaders: dict[str, str], body: ChatCompletionRequest | dict[str, object], model: str, knownTools: list[dict[str, object]], managedLocalToolNames: set[str], clientToolNames: set[str], workspacePath: str | None=None, onToolEvent: Callable[[dict[str, object]], None] | None=None) -> AsyncIterator[str]:
    """Stream from upstream, intercept tool calls, resolve them, and continue.

    This is the key function for handling streaming with managed tool execution.
    """
    acc = createOpenaiStreamAccumulator()
    toolRound = 0
    raw_body = body.model_dump() if isinstance(body, ChatCompletionRequest) else body
    currentMessages = list(raw_body.get('messages', []))
    responseId = ''
    modelName = model
    async for chunk in _client.streamSse(upstreamUrl, upstreamHeaders, camelToSnake({**body, 'stream': True})):
        if chunk.get('type') == 'error':
            yield writeOpenaiSseError(chunk.get('body', str(chunk.get('error', ''))))
            yield writeOpenaiSseDone()
            return
        accumulateOpenaiChunk(acc, chunk)
        yield writeOpenaiSseData(chunk)
        choices = chunk.get('choices', [])
        if choices and choices[0].get('finish_reason') in ('tool_calls', 'stop'):
            responseId = acc.get('id') or chunk.get('id', '')
            modelName = acc.get('model') or model
            if acc['tool_calls']:
                toolRound += 1
                if toolRound > MAX_MANAGED_TOOL_ROUNDS:
                    break
                assistantMsg = {'role': 'assistant', 'content': acc.get('content', '')}
                if acc['reasoning']:
                    assistantMsg['reasoning'] = acc['reasoning']
                if acc['tool_calls']:
                    assistantMsg['tool_calls'] = [{'id': tc.get('id') or f'call_{uuid.uuid4().hex[:8]}', 'type': 'function', 'function': {'name': tc.get('function', {}).get('name', ''), 'arguments': tc.get('function', {}).get('arguments', '')}} for tc in acc['tool_calls']]
                currentMessages.append(assistantMsg)
                classification = classifyOpenaiToolCalls(acc['tool_calls'], managedLocalToolNames, clientToolNames)
                if classification['has_managed'] and (classification['can_execute_managed'] or toolRound < MAX_MANAGED_TOOL_ROUNDS):
                    toolResults = await executeManagedOpenaiToolCalls(classification['managed_tool_calls'], knownTools, currentMessages, workspacePath, onToolEvent)
                    currentMessages.extend(toolResults)
                    acc = createOpenaiStreamAccumulator()
                    async for nextChunk in _client.streamSse(upstreamUrl, upstreamHeaders, camelToSnake({'model': model, 'messages': currentMessages, 'tools': knownTools, 'stream': True})):
                        if nextChunk.get('type') == 'error':
                            yield writeOpenaiSseError(nextChunk.get('body', ''))
                            yield writeOpenaiSseDone()
                            return
                        accumulateOpenaiChunk(acc, nextChunk)
                        yield writeOpenaiSseData(nextChunk)
                        nchoices = nextChunk.get('choices', [])
                        if nchoices and nchoices[0].get('finish_reason'):
                            break
                    currentMessages.append({'role': 'assistant', 'content': acc.get('content', ''), **({'tool_calls': acc['tool_calls']} if acc['tool_calls'] else {})})
                    if acc['usage']:
                        yield writeOpenaiSseData({'choices': [], 'usage': acc['usage']})
            yield writeOpenaiSseDone()
            return
    yield writeOpenaiSseDone()

async def handleChatCompletions(body: ChatCompletionRequest | dict[str, object], request: object=None) -> tuple[dict[str, object] | AsyncIterator[str], dict[str, str] | None]:
    """Handle a /v1/chat/completions or /v1/responses request.

    Returns a tuple of (response_or_stream, response_headers).
    """
    if isinstance(body, ChatCompletionRequest):
        model = body.model
        raw_body: dict[str, object] = body.model_dump()  # type: ignore[assignment]
    else:
        model = body.get('model', 'gpt-4o')
        raw_body = body
    try:
        resolved = resolve(model, default_alias='gpt-4o')
        providerName = resolved['provider']
        resolvedModel = resolved['model']
    except Exception:
        providerName = model
        resolvedModel = model
    provider = providerResolver.resolve(providerName or model)
    if not provider:
        return ({'error': 'No provider available for model', 'model': model}, None)
    client = getClient(provider)
    if not client:
        return ({'error': f"No client for provider: {provider.get('name')}"}, None)
    apiKey = client.resolveApiKey()
    if not apiKey:
        return ({'error': 'API key not configured for provider'}, None)
    headers = client.buildAuthHeaders(apiKey)
    baseUrl = client.resolveBaseUrl()
    upstreamUrl = toOpenaiCompatibleTargetUrl(baseUrl)
    clientWantsStream = raw_body.get('stream', False)
    isResponsesEndpoint = raw_body.get('_endpoint') == 'responses'
    sessionId = deriveSessionIdFromOpenai(raw_body, request)
    knownTools = getProxyOpenaiToolDefinitions()
    clientTools = raw_body.get('tools', [])
    if clientTools:
        appendMissingOpenaiTools(knownTools, clientTools)
    managedLocalToolNames: set[str] = set()
    clientToolNames: set[str] = set()
    # Proxy-injected managed tools are always locally executable, even if
    # the client didn't list them in its own tool set.
    for t in knownTools:
        name = getToolDefinitionName(t)
        if name and isProxyManagedLocalToolName(name):
            managedLocalToolNames.add(name)
    # Client-listed tools: separate managed from client-owned
    for t in clientTools or []:
        name = getToolDefinitionName(t)
        if name and isProxyManagedLocalToolName(name):
            managedLocalToolNames.add(name)
        elif name:
            clientToolNames.add(name)
    hasManagedTools = len(managedLocalToolNames) > 0
    if isResponsesEndpoint:
        raw_body['stream'] = False
        resp = await client.requestJson('POST', upstreamUrl.replace('/chat/completions', '/responses'), headers, camelToSnake(raw_body))
        return (snakeToCamel(resp.body) if isinstance(resp.body, (dict, list)) else {'response': str(resp.body)}, None)
    if clientWantsStream:
        if hasManagedTools:
            stream = streamUpstreamAndResolveToolsOpenai(upstreamUrl, headers, raw_body, model, knownTools, managedLocalToolNames, clientToolNames)
        else:
            stream = streamOpenaiSseToClient(upstreamUrl, headers, raw_body)
        return (stream, writeOpenaiSseHeaders())
    else:
        raw_body['stream'] = False
        if hasManagedTools:
            messages = raw_body.get('messages', [])
            updatedMessages, usage = await resolveManagedOpenaiToolCalls(messages, model, upstreamUrl, headers, knownTools, managedLocalToolNames, clientToolNames, client=client)
            lastMsg = updatedMessages[-1] if updatedMessages else {}
            response = buildOpenaiAggregatedFromStream({'id': f'chatcmpl-{uuid.uuid4().hex[:12]}', 'model': model, 'created': int(time.time()), 'content': lastMsg.get('content', ''), 'tool_calls': lastMsg.get('tool_calls', []), 'finish_reason': 'stop' if not lastMsg.get('tool_calls') else 'tool_calls', 'usage': usage or {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}})
            return (response, None)
        else:
            resp = await client.requestJson('POST', upstreamUrl, headers, camelToSnake(raw_body))
            return (snakeToCamel(resp.body) if isinstance(resp.body, (dict, list)) else {'response': str(resp.body)}, None)
_client = None

def _getClient() -> object:
    global _client
    if _client is None:
        from app.providers.clients.openai import OpenAIClient
        _client = OpenAIClient({})
    return _client
_getClient()