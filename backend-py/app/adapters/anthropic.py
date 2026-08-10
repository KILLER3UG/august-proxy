"""
Anthropic Messages API adapter — message translation, SSE passthrough,
and managed tool execution for the /v1/messages endpoint.

Port of backend/adapters/anthropic.js (3,408 lines).

Key responsibilities:
- Model alias resolution (sonnet → concrete model ID)
- Message format translation (Anthropic ↔ OpenAI)
- System prompt building and normalization
- SSE streaming (native Anthropic format)
- OpenAI-to-Anthropic SSE conversion
- Tool call interception and managed execution
- Multi-round tool resolution loop
- Self-healing message repair
- Session derivation and model inheritance
"""

from __future__ import annotations

import json
import uuid
from typing import AsyncIterator, Callable, cast

from app.adapters import anthropic_stream_translate as _anthropic_stream_translate
from app.adapters.anthropic_sse import (
    send_simulated_anthropic_stream,
    write_anthropic_sse_data,
    write_anthropic_sse_data_only,
)
from app.adapters.anthropic_system import (
    AUGUST_REMINDER,
    CLAUDE_PUBLIC_MODEL_ALIAS,
    KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES,
    RULE_REMINDER_MESSAGE,
    append_text_to_system_blocks,
    build_anthropic_system_blocks,
    build_openai_system_prompt,
    is_claude_family_model,
    normalize_system_blocks,
    resolve_claude_client_facing_model,
    resolve_claude_public_model_alias,
    should_inject_august_reminder,
    should_inject_reminder_message,
    system_blocks_to_text,
)
from app.adapters.base import (
    extractRequestHeaders as _extractRequestHeaders,
)
from app.adapters.case_converters import camelToSnake, snakeToCamel
from app.adapters.proxy_tools import (
    anthropic_to_openai_tool_definition,
    dedupe_and_canonicalize_anthropic_tools,
    execute_managed_proxy_tool,
    format_managed_tool_result,
    get_managed_anthropic_web_tool_definitions,
    get_tool_definition_name,
    is_proxy_managed_local_tool_name,
)
from app.adapters.stream_state import AnthropicNativeStreamState, OpenaiToAnthropicStreamState
from app.adapters.tool_classification import (
    classifyAnthropicToolUses,
)
from app.adapters.upstream_errors import normalize_upstream_error
from app.json_narrowing import as_dict, as_int, as_list, as_str
from app.models import (
    AnthropicRequest,
    AnthropicResponse,
    AnthropicUsage,
    ToolResultBlock,
)
from app.models.anthropic import dump_anthropic_upstream_body
from app.providers import resolver as providerResolver
from app.providers.clients import getClient
from app.providers.clients.base import BaseProviderClient
from app.providers.model_resolver import resolve
from app.type_aliases import JsonValue

# Back-compat aliases (previous camelCase names on this module).
writeAnthropicSseData = write_anthropic_sse_data
writeAnthropicSseDataOnly = write_anthropic_sse_data_only
sendSimulatedAnthropicStream = send_simulated_anthropic_stream

# Re-export constants for back-compat (assignment keeps ruff from stripping imports).
CLAUDE_PUBLIC_MODEL_ALIAS = CLAUDE_PUBLIC_MODEL_ALIAS
KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES = KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES
AUGUST_REMINDER = AUGUST_REMINDER
RULE_REMINDER_MESSAGE = RULE_REMINDER_MESSAGE

isClaudeFamilyModel = is_claude_family_model
resolveClaudePublicModelAlias = resolve_claude_public_model_alias
resolveClaudeClientFacingModel = resolve_claude_client_facing_model
shouldInjectReminderMessage = should_inject_reminder_message
shouldInjectAugustReminder = should_inject_august_reminder
normalizeSystemBlocks = normalize_system_blocks
systemBlocksToText = system_blocks_to_text
buildOpenaiSystemPrompt = build_openai_system_prompt
buildAnthropicSystemBlocks = build_anthropic_system_blocks
appendTextToSystemBlocks = append_text_to_system_blocks

# Stream translate helpers (extracted); assignment keeps ruff from stripping.
streamOpenaiDeltaAsAnthropic = _anthropic_stream_translate.streamOpenaiDeltaAsAnthropic
createOpenaiToAnthropicStreamState = _anthropic_stream_translate.createOpenaiToAnthropicStreamState
createAnthropicNativeStreamState = _anthropic_stream_translate.createAnthropicNativeStreamState
buildOpenaiAggregatedForAnthropicFromStream = (
    _anthropic_stream_translate.buildOpenaiAggregatedForAnthropicFromStream
)

# 0 = unlimited managed tool rounds (default). Positive values cap the loop.
MAX_MANAGED_TOOL_ROUNDS = 0


def deriveSessionIdFromAnthropic(
    body: AnthropicRequest | dict[str, object] | None, request: object | None = None
) -> str:
    """Extract a session identifier from an Anthropic Messages body."""
    if isinstance(body, AnthropicRequest):
        from_model = getattr(body, 'sessionId', None) or getattr(body, 'session_id', None)
        if from_model:
            return str(from_model)
        metadata = as_dict(body.metadata, {})
        from_meta = metadata.get('sessionId') or metadata.get('session_id')
        if from_meta:
            return str(from_meta)
    elif body and isinstance(body, dict):
        metadata = as_dict(body.get('metadata'), {})
        fromBody = (
            body.get('sessionId') or body.get('session_id') or metadata.get('sessionId') or metadata.get('session_id')
        )
        if fromBody:
            return str(fromBody)
    if request and hasattr(request, 'headers'):
        for key in ['x-session-id', 'x-conversation-id', 'x-claude-code-session-id', 'x-request-id']:
            value = request.headers.get(key)
            if value:
                return str(value)
    return ''


def extractRequestHeaders(request: object) -> dict[str, str]:
    """Backward-compat: re-export from base module."""
    return _extractRequestHeaders(request)


def _toolResultBlockMessage(tr: ToolResultBlock) -> dict[str, object]:
    """Wrap a tool_result block in a role:'user' message.

    The Messages API requires tool_result blocks to live inside a user
    message — a bare block appended to ``messages`` 400s strict gateways
    (real API, MiniMax) on the round-2 call. ``translateMessages`` unwraps
    this shape back into OpenAI tool-role messages for OpenAI upstreams.
    """
    return {'role': 'user', 'content': [tr.model_dump()]}  # type: ignore[misc]


def _toolResultContentToText(block: dict[str, object]) -> str:
    """Extract plain text from an Anthropic tool_result content block.

    Content may be a string or a list of typed blocks (text / image); images
    are dropped, text is concatenated.
    """
    content = block.get('content', '')
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text = ''
        for part in content:
            if isinstance(part, dict) and as_str(part.get('type'), '') == 'text':
                text += as_str(part.get('text'), '')
        return text
    return ''


def translateMessages(
    messages: list[dict[str, object]], system: list[dict[str, object]] | None = None
) -> list[dict[str, object]]:
    """Translate Anthropic-format messages to OpenAI format.

    Handles:
    - Content blocks → string content
    - Tool uses → tool_calls
    - Tool results → tool messages
    - Thinking blocks → reasoning_content
    """
    openaiMessages: list[dict[str, object]] = []
    if system:
        systemText = system_blocks_to_text(system)
        if systemText:
            openaiMessages.append({'role': 'system', 'content': systemText})
    for msg in messages:
        role = msg.get('role', '')
        content = msg.get('content', '')
        if role == 'user':
            if isinstance(content, str):
                openaiMessages.append({'role': 'user', 'content': content})
            elif isinstance(content, list):
                parts: list[dict[str, object]] = []
                toolResults: list[dict[str, object]] = []
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    blockType = as_str(block.get('type'), '')
                    if blockType == 'text':
                        parts.append({'type': 'text', 'text': as_str(block.get('text'), '')})
                    elif blockType in ('image_url', 'image'):
                        source = as_dict(block.get('source'), {})
                        parts.append({'type': 'image_url', 'image_url': {'url': as_str(source.get('data'), '')}})
                    elif blockType == 'tool_result':
                        # Tool results become OpenAI tool-role messages. Without
                        # this the upstream model never sees tool output and
                        # re-invokes stale tools.
                        toolResults.append(
                            {
                                'role': 'tool',
                                'tool_call_id': as_str(block.get('tool_use_id'), ''),
                                'content': _toolResultContentToText(block),
                            }
                        )
                if parts:
                    openaiMessages.append({'role': 'user', 'content': cast(JsonValue, parts)})
                openaiMessages.extend(toolResults)
        elif role == 'assistant':
            asstMsg: dict[str, object] = {'role': 'assistant'}
            if isinstance(content, str):
                asstMsg['content'] = content
            elif isinstance(content, list):
                textParts: list[str] = []
                toolCalls: list[dict[str, object]] = []
                reasoning = as_str(asstMsg.get('reasoning'), '')
                reasoningContent = as_str(asstMsg.get('reasoning_content'), '')
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    blockType = as_str(block.get('type'), '')
                    if blockType == 'text':
                        textParts.append(as_str(block.get('text'), ''))
                    elif blockType == 'tool_use':
                        toolCalls.append(
                            {
                                'id': as_str(block.get('id'), ''),
                                'type': 'function',
                                'function': {
                                    'name': as_str(block.get('name'), ''),
                                    'arguments': json.dumps(as_dict(block.get('input'), {})),
                                },
                            }
                        )
                    elif blockType == 'thinking':
                        reasoning += as_str(block.get('text'), '')
                        reasoningContent += as_str(block.get('text'), '')
                asstMsg['reasoning'] = reasoning
                asstMsg['reasoning_content'] = reasoningContent
                asstMsg['content'] = ''.join(textParts) if textParts else ''
                if toolCalls:
                    asstMsg['tool_calls'] = cast(JsonValue, toolCalls)
            toolCallsVal = msg.get('tool_calls')
            if toolCallsVal and 'tool_calls' not in asstMsg and isinstance(toolCallsVal, list):
                asstMsg.setdefault('content', as_str(msg.get('content'), ''))
                safeCalls: list[dict[str, object]] = []
                for tc in toolCallsVal:
                    if not isinstance(tc, dict):
                        continue
                    tcCopy = dict(tc)
                    fn = as_dict(tcCopy.get('function'), {})
                    if 'arguments' in fn and (not isinstance(fn['arguments'], str)):
                        fn['arguments'] = json.dumps(fn['arguments'])
                    tcCopy['function'] = fn
                    safeCalls.append(tcCopy)
                asstMsg['tool_calls'] = cast(JsonValue, safeCalls)
            openaiMessages.append(asstMsg)
        elif role == 'tool':
            toolResult = content
            if isinstance(toolResult, list):
                text = ''
                for block in toolResult:
                    if isinstance(block, dict):
                        blockType = as_str(block.get('type'), '')
                        if blockType == 'text':
                            text += as_str(block.get('text'), '')
                        elif blockType == 'tool_use':
                            text += json.dumps(as_dict(block.get('input'), {}))
                        else:
                            text += json.dumps(block)
                    else:
                        text += str(block)
                toolResult = text
            elif not isinstance(toolResult, str):
                toolResult = json.dumps(toolResult)
            toolCallId = as_str(msg.get('tool_use_id'), '') or as_str(msg.get('tool_call_id'), '')
            openaiMessages.append({'role': 'tool', 'tool_call_id': toolCallId, 'content': toolResult})
    return openaiMessages


def buildOpenaiRequest(
    body: AnthropicRequest | dict[str, object], model: str, system: list[dict[str, object]] | None = None
) -> dict[str, object]:
    """Build an OpenAI-format request from an Anthropic Messages body."""
    if isinstance(body, AnthropicRequest):
        openaiBody: dict[str, object] = {
            'model': model,
            'messages': cast(
                JsonValue, translateMessages(cast('list[dict[str, object]]', as_list(body.messages, [])), system)
            ),
        }
        if body.max_tokens is not None:
            openaiBody['max_tokens'] = body.max_tokens
        if body.temperature is not None:
            openaiBody['temperature'] = body.temperature
        if body.top_p is not None:
            openaiBody['top_p'] = body.top_p
        if body.top_k is not None:
            openaiBody['top_k'] = body.top_k
        if body.stop_sequences is not None:
            openaiBody['stop'] = cast(JsonValue, body.stop_sequences)
        thinking = as_dict(body.thinking, {})
        if thinking:
            budget = as_int(thinking.get('budget_tokens'), 0)
            if budget > 0:
                openaiBody['reasoning_effort'] = _budgetToEffort(budget)
        return openaiBody
        # Dict fallback for backward compatibility
    openaiBody = {
        'model': model,
        'messages': cast(
            JsonValue, translateMessages(cast('list[dict[str, object]]', as_list(body.get('messages'), [])), system)
        ),
    }
    if 'max_tokens' in body or 'max_output_tokens' in body:
        openaiBody['max_tokens'] = body.get('max_tokens') or body.get('max_output_tokens', 4096)
    if 'temperature' in body:
        openaiBody['temperature'] = body['temperature']
    if 'top_p' in body:
        openaiBody['top_p'] = body['top_p']
    if 'top_k' in body:
        openaiBody['top_k'] = body['top_k']
    if 'stop_sequences' in body:
        openaiBody['stop'] = body['stop_sequences']
    thinking = as_dict(body.get('thinking'), {})
    if thinking:
        budget = as_int(thinking.get('budget_tokens'), 0)
        if budget > 0:
            openaiBody['reasoning_effort'] = _budgetToEffort(budget)
    return openaiBody


def _budgetToEffort(budget: int) -> str:
    """Map Anthropic thinking budget to OpenAI reasoning_effort."""
    if budget >= 32000:
        return 'high'
    if budget >= 16000:
        return 'medium'
    return 'low'


def _anthropicCacheControlEnabled() -> bool:
    """Prompt caching for Anthropic upstreams (AUGUST_ANTHROPIC_CACHE=0 disables)."""
    import os

    val = os.environ.get('AUGUST_ANTHROPIC_CACHE')
    if val is not None and str(val).strip() != '':
        return str(val).strip().lower() not in ('0', 'false', 'no', 'off')
    return True


def apply_prompt_caching(body: dict[str, object]) -> dict[str, object]:
    """Add Anthropic prompt-cache breakpoints (``cache_control: ephemeral``).

    Marks the last system block, the last tool definition, and the last
    content block of the final user message — the standard breakpoints that
    make the stable prefix (system + tools + early history) hit the
    provider's prompt cache across turns. Byte-stable Tier1/2 prompts
    (prompt_cache) keep those hits alive for the session's lifetime.

    Idempotent: a block that already carries ``cache_control`` is left as-is.
    """
    if not _anthropicCacheControlEnabled():
        return body
    try:
        system = body.get('system')
        if isinstance(system, list) and system:
            last = system[-1]
            if isinstance(last, dict):
                last.setdefault('cache_control', {'type': 'ephemeral'})
        elif isinstance(system, str) and system:
            body['system'] = [
                {'type': 'text', 'text': system, 'cache_control': {'type': 'ephemeral'}}
            ]
        tools = body.get('tools')
        if isinstance(tools, list) and tools:
            last_tool = tools[-1]
            if isinstance(last_tool, dict):
                last_tool.setdefault('cache_control', {'type': 'ephemeral'})
        messages = body.get('messages')
        if isinstance(messages, list) and messages:
            for msg in reversed(messages):
                if not isinstance(msg, dict):
                    continue
                content = msg.get('content')
                if isinstance(content, str) and content.strip():
                    msg['content'] = [
                        {'type': 'text', 'text': content, 'cache_control': {'type': 'ephemeral'}}
                    ]
                    break
                if isinstance(content, list) and content:
                    last_block = content[-1]
                    if isinstance(last_block, dict):
                        last_block.setdefault('cache_control', {'type': 'ephemeral'})
                    break
    except Exception:
        pass
    return body


def buildAnthropicUpstreamRequest(
    body: AnthropicRequest | dict[str, object], model: str, system: list[dict[str, object]] | None = None
) -> dict[str, object]:
    """Build an Anthropic-format request for native upstream calls."""
    if isinstance(body, AnthropicRequest):
        anthropicBody: dict[str, object] = {'model': model, 'messages': as_list(body.messages, [])}
        anthropicBody['max_tokens'] = body.max_tokens or 8192
        for key in ('temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata'):
            val = getattr(body, key, None)
            if val is not None:
                anthropicBody[key] = val
        thinking = as_dict(body.thinking, {})
        if thinking:
            anthropicBody['thinking'] = thinking
        if system:
            anthropicBody['system'] = cast(JsonValue, system)
        return apply_prompt_caching(anthropicBody)
    anthropicBody = {'model': model, 'messages': cast(JsonValue, as_list(body.get('messages'), []))}
    if 'max_tokens' in body or 'max_output_tokens' in body:
        anthropicBody['max_tokens'] = body.get('max_tokens') or body.get('max_output_tokens', 4096)
    else:
        anthropicBody['max_tokens'] = 8192
    for key in ('temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata'):
        if key in body:
            anthropicBody[key] = body[key]
    if 'thinking' in body:
        anthropicBody['thinking'] = body['thinking']
    if system:
        anthropicBody['system'] = cast(JsonValue, system)
    return apply_prompt_caching(anthropicBody)



async def resolveManagedAnthropicToolUses(
    messages: list[dict[str, object]],
    system: list[dict[str, object]] | None,
    model: str,
    upstreamUrl: str,
    upstreamHeaders: dict[str, str],
    isAnthropicUpstream: bool,
    knownTools: list[dict[str, object]],
    managedLocalToolNames: set[str],
    clientToolNames: set[str],
    workspacePath: str | None = None,
    onToolEvent: Callable[[dict[str, object]], None] | None = None,
    parentSignal: object = None,
    client: BaseProviderClient | None = None,
) -> tuple[list[dict[str, object]], dict[str, object] | None]:
    """Run the multi-round tool resolution loop for Anthropic-format requests.

    Similar to the OpenAI version but works with Anthropic's content block format.
    """
    currentMessages = list(messages)
    currentSystem = list(system) if system else []
    finalUsage: dict[str, object] | None = None
    if not client:
        return (currentMessages, {'error': 'No client available for tool resolution'})
    # 0 = unlimited; positive values cap managed tool rounds.
    _round = 0
    while True:
        _round += 1
        if MAX_MANAGED_TOOL_ROUNDS > 0 and _round > MAX_MANAGED_TOOL_ROUNDS:
            break
        reqBody: dict[str, object] = {
            'model': model,
            'messages': cast(JsonValue, currentMessages),
            'max_tokens': 8192,
            'stream': False,
        }
        if currentSystem:
            reqBody['system'] = cast(JsonValue, currentSystem)
        if knownTools:
            reqBody['tools'] = cast(JsonValue, knownTools)
        if isAnthropicUpstream:
            reqBodyJson = cast(dict[str, object], as_dict(camelToSnake(reqBody), {}))
            resp = await client.requestJson('POST', upstreamUrl, upstreamHeaders, reqBodyJson)
        else:
            openaiBody = buildOpenaiRequest({'messages': cast(JsonValue, currentMessages)}, model, currentSystem)
            if knownTools:
                openaiBody['tools'] = [anthropic_to_openai_tool_definition(t) for t in knownTools]
            openaiBodyJson = cast(dict[str, object], as_dict(camelToSnake(openaiBody), {}))
            resp = await client.requestJson('POST', upstreamUrl, upstreamHeaders, openaiBodyJson)
        if resp.status != 200:
            # Never fabricate a 200 with the client's own messages. Return a
            # router-friendly {error, type, status} shape in the usage slot —
            # callers distinguish it from a real usage dict by the 'error' key.
            return (currentMessages, normalize_upstream_error(resp))
        rawBody = as_dict(cast(JsonValue, resp.body_json), {})
        if rawBody.get('usage'):
            # Read from the raw body BEFORE snakeToCamel so usage keys stay
            # snake_case (input_tokens/output_tokens) for downstream readers.
            finalUsage = as_dict(rawBody.get('usage'), {})
        responseBody = as_dict(snakeToCamel(cast(JsonValue, resp.body_json)), {})
        if isAnthropicUpstream:
            content = as_list(responseBody.get('content'), [])
            assistantMsg: dict[str, object] = {'role': 'assistant', 'content': content}
            toolUses = [b for b in content if isinstance(b, dict) and b.get('type') == 'tool_use']
        else:
            choices = as_list(responseBody.get('choices'), [])
            if not choices:
                break
            msg = as_dict(choices[0], {})
            # OpenAI nests the message under choices[0].message — reading the
            # choice dict itself misses tool_calls entirely.
            message = as_dict(msg.get('message'), {})
            # Normalize the (camelized) OpenAI response into the same
            # Anthropic content-block shape the native branch appends —
            # the raw message with camelCase `toolCalls` would neither
            # match the snake_case reader in translateMessages nor survive
            # the round-2 body rebuild.
            contentBlocks: list[dict[str, object]] = []
            text = as_str(message.get('content'), '')
            if text:
                contentBlocks.append({'type': 'text', 'text': text})
            reasoning = as_str(message.get('reasoning'), '') or as_str(message.get('reasoning_content'), '')
            if reasoning:
                contentBlocks.append({'type': 'thinking', 'text': reasoning})
            toolUses = []
            rawCalls = message.get('toolCalls')
            if rawCalls is None:
                rawCalls = message.get('tool_calls')
            for tc in as_list(rawCalls, []):
                if not isinstance(tc, dict):
                    continue
                tcFn = as_dict(tc.get('function'), {})
                try:
                    toolInput = json.loads(as_str(tcFn.get('arguments'), '{}'))
                except (json.JSONDecodeError, TypeError):
                    toolInput = {}
                block: dict[str, object] = {
                    'type': 'tool_use',
                    'id': as_str(tc.get('id'), ''),
                    'name': as_str(tcFn.get('name'), ''),
                    'input': toolInput,
                }
                contentBlocks.append(block)
                toolUses.append(block)
            assistantMsg = {'role': 'assistant', 'content': contentBlocks}
        if not toolUses:
            currentMessages.append(assistantMsg)
            break
        classification = cast(
            'dict[str, object]',
            classifyAnthropicToolUses(
                cast('list[dict[str, object]] | None', toolUses),
                managedLocalToolNames,
                clientToolNames,
            ),
        )
        if not classification.get('has_managed'):
            currentMessages.append(assistantMsg)
            break
        toolResults: list[dict[str, object]] = []
        for tu in as_list(classification.get('managed_tool_uses'), []):
            if not isinstance(tu, dict):
                continue
            toolName = as_str(tu.get('name'), '')
            toolInput = as_dict(tu.get('input'), {})
            toolUseId = as_str(tu.get('id'), f'toolu_{uuid.uuid4().hex[:16]}')
            try:
                result = await execute_managed_proxy_tool(toolName, toolInput, workspacePath, parentSignal=parentSignal)
                tr = ToolResultBlock(tool_use_id=toolUseId, content=format_managed_tool_result(toolName, result))
                toolResults.append(_toolResultBlockMessage(tr))
            except Exception as exc:
                tr = ToolResultBlock(tool_use_id=toolUseId, content=f'Error: {exc}', is_error=True)
                toolResults.append(_toolResultBlockMessage(tr))
        currentMessages.append(assistantMsg)
        currentMessages.extend(toolResults)
        if classification['has_client_or_unknown']:
            break
    return (currentMessages, finalUsage)


async def handleMessages(
    body: AnthropicRequest | dict[str, object], request: object = None
) -> tuple[dict[str, object] | AsyncIterator[str], dict[str, str] | None]:
    """Handle a POST /v1/messages request.

    Returns a tuple of (response_or_stream, response_headers).
    """
    if isinstance(body, AnthropicRequest):
        model: str = body.model
        raw_body = dump_anthropic_upstream_body(body)
    else:
        model = as_str(body.get('model'), 'claude-sonnet-4-7')
        raw_body = dump_anthropic_upstream_body(body)
    resolvedModel = resolve_claude_public_model_alias(model)
    try:
        resolved = resolve(resolvedModel, default_alias='claude-sonnet-4-7')
        providerName = as_str(resolved.get('provider'), '')
        resolvedModel = as_str(resolved.get('model'), resolvedModel)
    except Exception:
        providerName = resolvedModel
    provider = providerResolver.resolve(providerName)
    if not provider:
        return ({'error': 'No provider available for model', 'model': resolvedModel}, None)
    # Per-model format override (multi-format gateways like OpenCode Zen): the
    # model's own apiFormat wins over the provider-level format. The existing
    # both-directions upstream handling below keys off client.apiFormat.
    from app.providers.resolver import apply_model_format_override

    provider = apply_model_format_override(provider, resolvedModel)
    if provider is None:
        return ({'error': 'No provider available for model', 'model': resolvedModel}, None)
    client = getClient(provider)
    if not client:
        return ({'error': f'No client for provider: {as_str(provider.get("name"), "")}'}, None)
    apiKey = client.resolveApiKey()
    if not apiKey:
        return ({'error': 'API key not configured for provider'}, None)
    headers = client.buildAuthHeaders(apiKey)
    from app.providers.api_format import provider_endpoint_url

    fmt = as_str(getattr(client, 'apiFormat', None) or provider.get('apiMode') or provider.get('apiFormat'))
    if fmt == 'openaiResponses':
        # The messages adapter speaks only chat-completions / native Messages
        # wire formats; a responses-format gateway would receive a chat body
        # at the /responses leaf (provider_endpoint_url kind='chat' → /responses).
        # Fail loudly instead of 400-ing upstream with a mismatched body.
        return (
            {
                'error': (
                    f'Model "{resolvedModel}" is a responses-format model and cannot be used '
                    'with /v1/messages. Use /v1/responses instead.'
                ),
                'type': 'error',
                'status': 400,
            },
            None,
        )
    isAnthropicUpstream = client.apiFormat == 'anthropicMessages'
    if isAnthropicUpstream:
        upstreamUrl = provider_endpoint_url(client.resolveBaseUrl(), 'anthropicMessages', kind='messages')
    else:
        upstreamUrl = provider_endpoint_url(
            client.resolveBaseUrl(), fmt or 'openaiChat', kind='chat'
        )
    clientWantsStream = body.stream if isinstance(body, AnthropicRequest) else body.get('stream', False)
    systemBlocks = build_anthropic_system_blocks(cast(JsonValue, as_list(raw_body.get('system'), [])))
    clientToolsRaw = as_list(raw_body.get('tools'), [])
    managedWebTools = get_managed_anthropic_web_tool_definitions()
    clientTools = cast('list[dict[str, object]]', clientToolsRaw)
    knownTools = dedupe_and_canonicalize_anthropic_tools(clientTools + managedWebTools)
    managedLocalToolNames: set[str] = set()
    clientToolNames: set[str] = set()
    # Proxy-injected managed web tools are always locally executable, even if
    # the client didn't list them in its own tool set. Seed the managed set so
    # classifyAnthropicToolUses() recognizes model calls to them as managed.
    for t in managedWebTools:
        name = as_str(get_tool_definition_name(t), '') or as_str(t.get('name'), '')
        if name:
            managedLocalToolNames.add(name)
    for t in clientTools:
        name = as_str(get_tool_definition_name(t), '') or as_str(t.get('name'), '')
        if is_proxy_managed_local_tool_name(name):
            managedLocalToolNames.add(name)
        else:
            clientToolNames.add(name)
    if clientWantsStream:
        if isAnthropicUpstream:
            stream = _streamAnthropicNative(
                upstreamUrl,
                headers,
                raw_body,
                resolvedModel,
                systemBlocks,
                knownTools,
                managedLocalToolNames,
                clientToolNames,
                client=client,
            )
        else:
            stream = _streamOpenaiAsAnthropic(
                upstreamUrl,
                headers,
                raw_body,
                resolvedModel,
                systemBlocks,
                knownTools,
                managedLocalToolNames,
                clientToolNames,
                client=client,
            )
        return (stream, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive'})
    else:
        return await _handleMessagesNonStreaming(
            upstreamUrl,
            headers,
            raw_body,
            resolvedModel,
            isAnthropicUpstream,
            systemBlocks,
            knownTools,
            managedLocalToolNames,
            clientToolNames,
            client=client,
        )


async def _handleMessagesNonStreaming(
    upstreamUrl: str,
    upstreamHeaders: dict[str, str],
    body: dict[str, object],
    model: str,
    isAnthropicUpstream: bool,
    systemBlocks: list[dict[str, object]],
    knownTools: list[dict[str, object]],
    managedLocalToolNames: set[str],
    clientToolNames: set[str],
    client: BaseProviderClient,
) -> tuple[dict[str, object], None]:
    """Non-streaming path for /v1/messages."""
    messages = cast('list[dict[str, object]]', as_list(body.get('messages'), []))
    if isAnthropicUpstream:
        reqBody = buildAnthropicUpstreamRequest(body, model, systemBlocks)
        if knownTools:
            reqBody['tools'] = cast(JsonValue, knownTools)
        reqBody['stream'] = False
        reqBodyJson = cast(dict[str, object], as_dict(camelToSnake(reqBody), {}))
        resp = await client.requestJson('POST', upstreamUrl, upstreamHeaders, reqBodyJson)
        if resp.is_error:
            # Never answer 200 with a raw upstream error envelope — normalize
            # it so the router's _endNonStream surfaces a real non-2xx.
            return (normalize_upstream_error(resp), None)
        responseBody = as_dict(snakeToCamel(cast(JsonValue, resp.body_json)), {})
        content = as_list(responseBody.get('content'), [])
        toolUses = [b for b in content if isinstance(b, dict) and as_str(b.get('type'), '') == 'tool_use']
        if toolUses:
            updatedMessages, usage = await resolveManagedAnthropicToolUses(
                messages,
                systemBlocks,
                model,
                upstreamUrl,
                upstreamHeaders,
                True,
                knownTools,
                managedLocalToolNames,
                clientToolNames,
                client=client,
            )
            if usage and 'error' in usage:
                # A tool-loop round failed upstream — surface the real error
                # instead of answering 200 with the client's own last message.
                return (cast('dict[str, object]', usage), None)
            lastMsg = updatedMessages[-1] if updatedMessages else {}
            resolvedUsage: dict[str, object] = as_dict(usage, {})
            resp_usage = AnthropicUsage(
                input_tokens=as_int(resolvedUsage.get('input_tokens'), 0),
                output_tokens=as_int(resolvedUsage.get('output_tokens'), 0),
            )
            return (
                {
                    'id': as_str(responseBody.get('id'), f'msg_{uuid.uuid4().hex[:16]}'),
                    'type': 'message',
                    'role': 'assistant',
                    'content': as_list(lastMsg.get('content'), []),
                    'model': model,
                    'stop_reason': 'end_turn',
                    'stop_sequence': None,
                    'usage': resp_usage.model_dump(),
                },
                None,
            )
        return (responseBody, None)
    else:
        openaiBody = buildOpenaiRequest(body, model, systemBlocks)
        if knownTools:
            openaiBody['tools'] = [anthropic_to_openai_tool_definition(t) for t in knownTools]
        openaiBody['stream'] = False
        openaiBodyJson = cast(dict[str, object], as_dict(camelToSnake(openaiBody), {}))
        resp = await client.requestJson('POST', upstreamUrl, upstreamHeaders, openaiBodyJson)
        if resp.is_error:
            return (normalize_upstream_error(resp), None)
        responseBody = as_dict(snakeToCamel(cast(JsonValue, resp.body_json)), {})
        return (_translateOpenaiToAnthropicResponse(responseBody, model), None)


async def _streamAnthropicNative(
    upstreamUrl: str,
    upstreamHeaders: dict[str, str],
    body: dict[str, object],
    model: str,
    systemBlocks: list[dict[str, object]],
    knownTools: list[dict[str, object]],
    managedLocalToolNames: set[str],
    clientToolNames: set[str],
    client: BaseProviderClient,
) -> AsyncIterator[str]:
    """Stream from an Anthropic upstream in native format.

    Intercepts tool uses and resolves managed tools.
    """
    reqBody = buildAnthropicUpstreamRequest(body, model, systemBlocks)
    if knownTools:
        reqBody['tools'] = cast(JsonValue, knownTools)
    reqBody['stream'] = True
    toolRound = 0
    currentMessages: list[dict[str, object]] = cast('list[dict[str, object]]', as_list(body.get('messages'), []))
    # 0 = unlimited managed tool rounds
    while True:
        if MAX_MANAGED_TOOL_ROUNDS > 0 and toolRound >= MAX_MANAGED_TOOL_ROUNDS:
            break
        st = AnthropicNativeStreamState()
        # Whether THIS round's upstream stream ended with its own
        # message_stop — the synthetic stop below is only emitted when the
        # round ended without one (else clients see message_stop twice,
        # audit finding — the OpenAI→Anthropic converter already tracks
        # sawTerminalStop for the same reason).
        sawTerminalStop = False
        roundBody = dict(reqBody)
        roundBody['messages'] = cast(JsonValue, currentMessages)
        roundBodyJson = cast(dict[str, object], as_dict(camelToSnake(roundBody), {}))
        async for rawEvent in client.streamSse(upstreamUrl, upstreamHeaders, roundBodyJson):
            event = cast('dict[str, object]', rawEvent)
            if as_str(event.get('type'), '') == 'error':
                yield write_anthropic_sse_data(
                    'error', {'error': {'message': as_str(event.get('body'), as_str(event.get('error'), ''))}}
                )
                return
            yield write_anthropic_sse_data_only(event)
            eventTypePayload = as_str(event.get('type'), '')
            if eventTypePayload == 'message_start':
                st.process_message_start(event)
            elif eventTypePayload == 'content_block_start':
                st.process_content_block_start(event)
            elif eventTypePayload == 'content_block_delta':
                st.process_content_block_delta(event)
            elif eventTypePayload == 'content_block_stop':
                st.process_content_block_stop(event)
            elif eventTypePayload == 'message_delta':
                st.process_message_delta(event)
            elif eventTypePayload == 'message_stop':
                sawTerminalStop = True
                st.process_message_stop(event)
            elif eventTypePayload == 'ping':
                st.process_ping(event)
        toolUses = st.get_tool_uses()
        if not toolUses:
            break
        classification = cast(
            'dict[str, object]', classifyAnthropicToolUses(toolUses, managedLocalToolNames, clientToolNames)
        )
        if not classification.get('has_managed'):
            break
        toolRound += 1
        assistantMsg: dict[str, object] = {
            'role': 'assistant',
            'content': cast(JsonValue, list(st.data.content_blocks)),
        }
        currentMessages.append(assistantMsg)
        for tu in as_list(classification.get('managed_tool_uses'), []):
            if not isinstance(tu, dict):
                continue
            toolName = as_str(tu.get('name'), '')
            toolInput = as_dict(tu.get('input'), {})
            toolUseId = as_str(tu.get('id'), f'toolu_{uuid.uuid4().hex[:16]}')
            try:
                result = await execute_managed_proxy_tool(toolName, toolInput)
                tr = ToolResultBlock(tool_use_id=toolUseId, content=format_managed_tool_result(toolName, result))
                currentMessages.append(_toolResultBlockMessage(tr))
            except Exception as exc:
                tr = ToolResultBlock(tool_use_id=toolUseId, content=f'Error: {exc}', is_error=True)
                currentMessages.append(_toolResultBlockMessage(tr))
        continue
    # Only synthesize the terminal stop when the last round's upstream
    # stream did not already end with message_stop (audit finding: clients
    # saw it twice on the native path).
    if not sawTerminalStop:
        yield write_anthropic_sse_data('message_stop', {'type': 'message_stop'})


async def _streamOpenaiAsAnthropic(
    upstreamUrl: str,
    upstreamHeaders: dict[str, str],
    body: dict[str, object],
    model: str,
    systemBlocks: list[dict[str, object]],
    knownTools: list[dict[str, object]],
    managedLocalToolNames: set[str],
    clientToolNames: set[str],
    client: BaseProviderClient,
) -> AsyncIterator[str]:
    """Stream from an OpenAI-format upstream and convert to Anthropic SSE."""
    openaiBody = buildOpenaiRequest(body, model, systemBlocks)
    if knownTools:
        openaiBody['tools'] = [anthropic_to_openai_tool_definition(t) for t in knownTools]
    openaiBody['stream'] = True
    toolRound = 0
    currentMessages: list[dict[str, object]] = cast('list[dict[str, object]]', as_list(body.get('messages'), []))
    # The converter emits message_stop when a round's finish_reason arrives —
    # only synthesize one at the end when the final round did NOT already
    # terminate cleanly (prevents a duplicate message_stop on the wire).
    sawTerminalStop = False
    # 0 = unlimited managed tool rounds
    while True:
        if MAX_MANAGED_TOOL_ROUNDS > 0 and toolRound >= MAX_MANAGED_TOOL_ROUNDS:
            break
        st = OpenaiToAnthropicStreamState()
        roundBody = dict(openaiBody)
        roundBody['messages'] = cast(JsonValue, currentMessages)
        roundBodyJson = cast(dict[str, object], as_dict(camelToSnake(roundBody), {}))
        async for rawChunk in client.streamSse(upstreamUrl, upstreamHeaders, roundBodyJson):
            chunk = cast('dict[str, object]', rawChunk)
            if as_str(chunk.get('type'), '') == 'error':
                yield write_anthropic_sse_data(
                    'error', {'error': {'message': as_str(chunk.get('body'), as_str(chunk.get('error'), ''))}}
                )
                return
            events = st.convert_chunk(chunk)
            if any('message_stop' in e for e in events):
                sawTerminalStop = True
            for eventStr in events:
                yield eventStr
        # Stream ended — resolve tool calls now. Executing tools mid-stream and
        # `continue`ing the inner loop never re-called upstream, so managed-tool
        # work was executed and discarded while the stream died with
        # message_stop. Mirror _streamAnthropicNative: act after the inner
        # stream, then re-run the outer loop with the tool results appended.
        toolCalls = [tc.to_anthropic_tool_use() for tc in st.pending_tool_calls]
        if not toolCalls:
            break
        classification = cast(
            'dict[str, object]', classifyAnthropicToolUses(toolCalls, managedLocalToolNames, clientToolNames)
        )
        if not classification.get('has_managed'):
            break
        toolRound += 1
        assistantContent: list[dict[str, object]] = list(toolCalls)
        if st.accumulated_text:
            assistantContent.insert(0, {'type': 'text', 'text': st.accumulated_text})
        currentMessages.append({'role': 'assistant', 'content': cast(JsonValue, assistantContent)})
        for tu in as_list(classification.get('managed_tool_uses'), []):
            if not isinstance(tu, dict):
                continue
            tuName = as_str(tu.get('name'), '')
            tuInput = as_dict(tu.get('input'), {})
            tuId = as_str(tu.get('id'), '')
            try:
                result = await execute_managed_proxy_tool(tuName, tuInput)
                tr = ToolResultBlock(tool_use_id=tuId, content=format_managed_tool_result(tuName, result))
                currentMessages.append(tr.model_dump())  # type: ignore[misc]
            except Exception as exc:
                tr = ToolResultBlock(tool_use_id=tuId, content=f'Error: {exc}', is_error=True)
                currentMessages.append(tr.model_dump())  # type: ignore[misc]
        continue
    if not sawTerminalStop:
        yield write_anthropic_sse_data('message_stop', {'type': 'message_stop'})


def _translateOpenaiToAnthropicResponse(openaiResponse: dict[str, object], model: str) -> dict[str, object]:
    """Convert an OpenAI Chat Completions response to Anthropic Messages format."""
    choices = as_list(openaiResponse.get('choices'), [])
    if not choices:
        resp = AnthropicResponse(id=f'msg_{uuid.uuid4().hex[:16]}', model=model)
        return resp.model_dump()  # type: ignore[return-value]
    choiceDict = as_dict(choices[0], {})
    message = choiceDict
    contentList: list[dict[str, object]] = []
    text = as_str(message.get('content'), '')
    if text:
        contentList.append({'type': 'text', 'text': text})
    reasoning = as_str(message.get('reasoning'), '') or as_str(message.get('reasoning_content'), '')
    if reasoning:
        contentList.append({'type': 'thinking', 'text': reasoning})
    for tc in as_list(message.get('tool_calls'), []):
        if not isinstance(tc, dict):
            continue
        tcFn = as_dict(tc.get('function'), {})
        try:
            toolInput = json.loads(as_str(tcFn.get('arguments'), '{}'))
        except (json.JSONDecodeError, TypeError):
            toolInput = {}
        contentList.append(
            {
                'type': 'tool_use',
                'id': as_str(tc.get('id'), f'toolu_{uuid.uuid4().hex[:16]}'),
                'name': as_str(tcFn.get('name'), ''),
                'input': toolInput,
            }
        )
    finishReason = as_str(choiceDict.get('finish_reason'), 'stop')
    stopReasonMap = {
        'stop': 'end_turn',
        'tool_calls': 'tool_use',
        'length': 'max_tokens',
        'content_filter': 'content_filter',
    }
    usage = as_dict(openaiResponse.get('usage'), {})
    resp = AnthropicResponse(
        id=as_str(openaiResponse.get('id'), f'msg_{uuid.uuid4().hex[:16]}'),
        model=as_str(openaiResponse.get('model'), model),
        content=contentList,
        stop_reason=stopReasonMap.get(finishReason, 'end_turn'),
        usage=AnthropicUsage(
            input_tokens=as_int(usage.get('prompt_tokens'), 0), output_tokens=as_int(usage.get('completion_tokens'), 0)
        ),
    )
    return resp.model_dump()  # type: ignore[return-value]


async def handleCountTokens(body: dict[str, object], request: object = None) -> dict[str, object]:
    """Handle a POST /v1/messages/count_tokens request."""
    from app.providers.clients.base import estimateTokens

    messages = cast('list[dict[str, object]]', as_list(body.get('messages'), []))
    tools = cast('list[dict[str, object]]', as_list(body.get('tools'), []))
    estimated = estimateTokens(messages, tools)
    return {'input_tokens': estimated, 'estimated': True}


def translateMessagesToAnthropic(messages: list[dict[str, object]]) -> list[dict[str, object]]:
    """Convert session messages (OpenAI or mixed format) to Anthropic Messages format.

    Groups consecutive tool messages into a single user message with tool_result blocks.
    Maps OpenAI assistant tool_calls to Anthropic content blocks with type='tool_use'.
    """
    translated: list[dict[str, object]] = []
    i = 0
    while i < len(messages):
        msg = messages[i]
        role = as_str(msg.get('role'), '')
        if role == 'tool':
            toolBlocks = []
            while i < len(messages) and as_str(messages[i].get('role'), '') == 'tool':
                tMsg = messages[i]
                toolUseId = as_str(tMsg.get('tool_use_id'), '') or as_str(tMsg.get('tool_call_id'), '')
                content = tMsg.get('content', '')
                toolBlocks.append({'type': 'tool_result', 'tool_use_id': toolUseId, 'content': content})
                i += 1
            translated.append({'role': 'user', 'content': cast(JsonValue, toolBlocks)})
        else:
            if role == 'assistant' and msg.get('tool_calls'):
                contentBlocks: list[dict[str, object]] = []
                # Only emit a thinking block when we have an Anthropic signature —
                # unsigned thinking is rejected by the Messages API.
                reasoning = as_str(msg.get('reasoning'), '') or as_str(msg.get('reasoning_content'), '')
                signature = as_str(msg.get('thinking_signature') or msg.get('signature'), '')
                if reasoning and signature:
                    contentBlocks.append(
                        {
                            'type': 'thinking',
                            'thinking': reasoning,
                            'text': reasoning,
                            'signature': signature,
                        }
                    )
                contentVal = msg.get('content')
                if contentVal:
                    contentBlocks.append({'type': 'text', 'text': contentVal})
                for tc in as_list(msg.get('tool_calls'), []):
                    if not isinstance(tc, dict):
                        continue
                    fn = as_dict(tc.get('function'), {})
                    try:
                        fnArgs = fn.get('arguments', {})
                        args: object = (
                            json.loads(as_str(fn.get('arguments'), '{}'))
                            if isinstance(fnArgs, str)
                            else as_dict(fnArgs, {})
                        )
                    except Exception:
                        args = {}
                    contentBlocks.append(
                        {
                            'type': 'tool_use',
                            'id': as_str(tc.get('id'), ''),
                            'name': as_str(fn.get('name'), ''),
                            'input': args,
                        }
                    )
                translated.append({'role': 'assistant', 'content': cast(JsonValue, contentBlocks)})
            elif role == 'assistant' and isinstance(msg.get('content'), list):
                contentList = as_list(msg.get('content'), [])
                filtered = []
                for b in contentList:
                    if not isinstance(b, dict):
                        filtered.append(b)
                        continue
                    if as_str(b.get('type'), '') == 'thinking' and (not b.get('signature')):
                        # Anthropic rejects thinking blocks without signature.
                        continue
                    filtered.append(b)
                translated.append(
                    {'role': 'assistant', 'content': filtered if filtered else [{'type': 'text', 'text': ''}]}
                )
            else:
                translated.append(msg)
            i += 1
    return translated
