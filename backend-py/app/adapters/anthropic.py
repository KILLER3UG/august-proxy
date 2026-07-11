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
import time
import uuid
from typing import AsyncIterator, Callable, cast
from app.typeAliases import JsonValue
from app.jsonUtils import as_str, as_dict, as_list, as_int
from app.adapters.base import streamSse, buildHeaders, extractRequestHeaders as _extractRequestHeaders, _scanHeadersForSessionId
from app.adapters.stream_state import AnthropicNativeStreamState, OpenaiToAnthropicStreamState
from app.providers.clients.base import BaseProviderClient
from app.adapters.proxyTools import getProxyOpenaiToolDefinitionsForAnthropic, appendMissingAnthropicTools, formatManagedToolResult, executeManagedProxyTool, executeManagedOpenaiToolCalls, getToolDefinitionName, dedupeAndCanonicalizeAnthropicTools, getManagedAnthropicWebToolDefinitions, openaiToAnthropicToolDefinition, anthropicToOpenaiToolDefinition, isProxyManagedLocalToolName, isBrowserAutomationToolName
from app.adapters.toolClassification import classifyAnthropicToolUses, classifyOpenaiToolCalls, getToolNameFromAnthropicTool, getToolNameFromOpenaiTool
from app.models import AnthropicRequest, AnthropicMessage, AnthropicResponse, AnthropicUsage, ContentBlock, ToolUseBlock, ToolResultBlock, ChatCompletionRequest, ChatMessage, ToolCall, Usage, StreamChunk
from app.adapters.caseConverters import snakeToCamel, camelToSnake
from app.providers import resolver as providerResolver
from app.providers.modelResolver import resolve, resolveOrFallback
from app.providers.clients import getClient
CLAUDE_PUBLIC_MODEL_ALIAS = 'claude-opus-4-6'
KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES = {'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'}
MAX_MANAGED_TOOL_ROUNDS = 10
AUGUST_REMINDER = 'This proxy environment is August Proxy — a multi-model AI gateway. You have access to the August tool suite for file operations, web access, bash commands, and memory.'
RULE_REMINDER_MESSAGE: dict[str, JsonValue] = {'type': 'text', 'text': '## Operational Rules\n\n1. When browsing the web, prioritize fetching text content directly.\n2. When executing commands, prefer safe, non-destructive operations.\n3. Always verify file paths before writing.\n4. Respect user privacy and data boundaries.\n5. If a tool fails, retry with corrected parameters before reporting failure.'}

# ── JsonValue narrowing helpers ───────────────────────────────────────────────
# The proxy treats provider payloads as `JsonValue` (a broad recursive union).
# Before operating on a value as a specific type we narrow it at runtime; these
# helpers keep the dynamic boundary small and give mypy a concrete type.
def isClaudeFamilyModel(model: str | None) -> bool:
    """True for Claude family model IDs or public alias names."""
    if not isinstance(model, str):
        return False
    lower = model.strip().lower()
    if not lower:
        return False
    if lower.startswith('claude-'):
        return True
    if model in KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES:
        return True
    return lower in ('sonnet', 'opus', 'best', 'opusplan')

def resolveClaudePublicModelAlias(requestedModel: str | None) -> str:
    """Map public aliases (sonnet, opus, best) to concrete model IDs."""
    if not isinstance(requestedModel, str):
        return CLAUDE_PUBLIC_MODEL_ALIAS
    normalized = requestedModel.strip()
    if not normalized:
        return CLAUDE_PUBLIC_MODEL_ALIAS
    lowered = normalized.lower()
    if lowered in ('sonnet',):
        return 'claude-sonnet-4-6'
    if lowered in ('opus', 'best', 'opusplan'):
        return 'claude-opus-4-6'
    if normalized in KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES:
        return normalized
    if lowered.startswith('claude-'):
        return normalized
    return CLAUDE_PUBLIC_MODEL_ALIAS

def resolveClaudeClientFacingModel(requestedModel: str | None) -> str:
    """Resolve what model name to present to the client."""
    if not isinstance(requestedModel, str):
        return CLAUDE_PUBLIC_MODEL_ALIAS
    normalized = requestedModel.strip()
    if not normalized:
        return CLAUDE_PUBLIC_MODEL_ALIAS
    if normalized in KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES:
        return normalized
    lowered = normalized.lower()
    if lowered == 'sonnet':
        return 'claude-sonnet-4-6'
    if lowered in ('opus', 'best', 'opusplan'):
        return 'claude-opus-4-6'
    if lowered.startswith('claude-'):
        return normalized
    return CLAUDE_PUBLIC_MODEL_ALIAS

def shouldInjectReminderMessage(messages: list[dict[str, JsonValue]] | None, existingSystem: list[dict[str, JsonValue]] | None=None) -> bool:
    """Check if the AUGUST_REMINDER should be injected."""
    if not messages:
        return True
    for msg in messages:
        content = msg.get('content', '')
        if isinstance(content, str) and ('August Proxy' in content or 'August tool suite' in content):
            return False
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'text':
                    text = as_str(block.get('text', ''))
                    if 'August Proxy' in text or 'August tool suite' in text:
                        return False
    if existingSystem:
        for block in existingSystem:
            text = as_str(block.get('text', '')) if isinstance(block, dict) else str(block)
            if 'August Proxy' in text or 'August tool suite' in text:
                return False
    return True

def shouldInjectAugustReminder(systemText: str | None) -> bool:
    """Check if the August reminder should be added to system text."""
    if not systemText:
        return True
    return 'August' not in systemText

def normalizeSystemBlocks(system: JsonValue) -> list[dict[str, JsonValue]]:
    """Normalize system prompt to list of Anthropic content blocks."""
    if not system:
        return []
    if isinstance(system, str):
        return [{'type': 'text', 'text': system}]
    if isinstance(system, list):
        return [{'type': 'text', 'text': block} if isinstance(block, str) else {'type': 'text', 'text': str(block)} for block in system]
    return [{'type': 'text', 'text': str(system)}]

def systemBlocksToText(blocks: list[dict[str, JsonValue]] | None) -> str:
    """Flatten system blocks into a single text string."""
    if not blocks:
        return ''
    parts: list[str] = []
    for block in blocks:
        if isinstance(block, dict):
            if block.get('type') == 'text':
                parts.append(as_str(block.get('text', '')))
            elif block.get('type') == 'tool_use':
                parts.append(json.dumps(as_dict(block.get('input', {}))))
        elif isinstance(block, str):
            parts.append(block)
    return '\n'.join(parts)

def buildOpenaiSystemPrompt(system: JsonValue) -> str:
    """Convert Anthropic system blocks to an OpenAI-style system string."""
    blocks = normalizeSystemBlocks(system)
    return systemBlocksToText(blocks)

def buildAnthropicSystemBlocks(system: JsonValue) -> list[dict[str, JsonValue]]:
    """Build Anthropic-format system blocks with reminders injected."""
    blocks = normalizeSystemBlocks(system)
    text = systemBlocksToText(blocks)
    if shouldInjectAugustReminder(text):
        blocks.append({'type': 'text', 'text': AUGUST_REMINDER})
    return blocks

def appendTextToSystemBlocks(blocks: list[dict[str, JsonValue]] | None, text: str) -> list[dict[str, JsonValue]]:
    """Append text to the last text block or add a new one."""
    if not blocks:
        return [{'type': 'text', 'text': text}]
    blocks = list(blocks)
    if blocks and blocks[-1].get('type') == 'text':
        existing_text = as_str(blocks[-1].get('text', ''))
        blocks[-1] = {'type': 'text', 'text': existing_text + ('\n\n' if not text.startswith('\n') else '') + text}
    else:
        blocks.append({'type': 'text', 'text': text})
    return blocks

def deriveSessionIdFromAnthropic(body: AnthropicRequest | dict[str, JsonValue] | None, request: object | None=None) -> str:
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
        fromBody = body.get('sessionId') or body.get('session_id') or metadata.get('sessionId') or metadata.get('session_id')
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

def translateMessages(messages: list[dict[str, JsonValue]], system: list[dict[str, JsonValue]] | None=None) -> list[dict[str, JsonValue]]:
    """Translate Anthropic-format messages to OpenAI format.

    Handles:
    - Content blocks → string content
    - Tool uses → tool_calls
    - Tool results → tool messages
    - Thinking blocks → reasoning_content
    """
    openaiMessages: list[dict[str, JsonValue]] = []
    if system:
        systemText = systemBlocksToText(system)
        if systemText:
            openaiMessages.append({'role': 'system', 'content': systemText})
    for msg in messages:
        role = msg.get('role', '')
        content = msg.get('content', '')
        if role == 'user':
            if isinstance(content, str):
                openaiMessages.append({'role': 'user', 'content': content})
            elif isinstance(content, list):
                parts: list[dict[str, JsonValue]] = []
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
                        pass
                if parts:
                    openaiMessages.append({'role': 'user', 'content': cast(JsonValue, parts)})
        elif role == 'assistant':
            asstMsg: dict[str, JsonValue] = {'role': 'assistant'}
            if isinstance(content, str):
                asstMsg['content'] = content
            elif isinstance(content, list):
                textParts: list[str] = []
                toolCalls: list[dict[str, JsonValue]] = []
                reasoning = as_str(asstMsg.get('reasoning'), '')
                reasoningContent = as_str(asstMsg.get('reasoning_content'), '')
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    blockType = as_str(block.get('type'), '')
                    if blockType == 'text':
                        textParts.append(as_str(block.get('text'), ''))
                    elif blockType == 'tool_use':
                        toolCalls.append({
                            'id': as_str(block.get('id'), ''),
                            'type': 'function',
                            'function': {
                                'name': as_str(block.get('name'), ''),
                                'arguments': json.dumps(as_dict(block.get('input'), {})),
                            },
                        })
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
                safeCalls: list[dict[str, JsonValue]] = []
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

def buildOpenaiRequest(body: AnthropicRequest | dict[str, JsonValue], model: str, system: list[dict[str, JsonValue]] | None=None) -> dict[str, JsonValue]:
    """Build an OpenAI-format request from an Anthropic Messages body."""
    if isinstance(body, AnthropicRequest):
        openaiBody: dict[str, JsonValue] = {'model': model, 'messages': cast(JsonValue, translateMessages(cast('list[dict[str, JsonValue]]', as_list(body.messages, [])), system))}
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
    openaiBody = {'model': model, 'messages': cast(JsonValue, translateMessages(cast('list[dict[str, JsonValue]]', as_list(body.get('messages'), [])), system))}
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

def buildAnthropicUpstreamRequest(body: AnthropicRequest | dict[str, JsonValue], model: str, system: list[dict[str, JsonValue]] | None=None) -> dict[str, JsonValue]:
    """Build an Anthropic-format request for native upstream calls."""
    if isinstance(body, AnthropicRequest):
        anthropicBody: dict[str, JsonValue] = {'model': model, 'messages': as_list(body.messages, [])}
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
        return anthropicBody
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
    return anthropicBody

def writeAnthropicSseData(event: str, data: dict[str, JsonValue]) -> str:
    """Serialize an Anthropic SSE event."""
    return f'event: {event}\ndata: {json.dumps(data)}\n\n'

def writeAnthropicSseDataOnly(data: dict[str, JsonValue]) -> str:
    """Serialize data with just the data: line (event omitted)."""
    return f'data: {json.dumps(data)}\n\n'

def sendSimulatedAnthropicStream(response: dict[str, JsonValue]) -> list[str]:
    """Create Anthropic SSE events from a full JSON response.

    Used when the proxy forced non-streaming upstream to do tool resolution,
    then needs to simulate a stream back to the client.
    """
    events: list[str] = []
    responseId = as_str(response.get('id'), f'msg_{uuid.uuid4().hex[:16]}')
    model = as_str(response.get('model'), 'unknown')
    role = as_str(response.get('role'), 'assistant')
    content = as_list(response.get('content'), [])
    usage = as_dict(response.get('usage'), {})
    events.append(writeAnthropicSseData('message_start', {'type': 'message_start', 'message': {'id': responseId, 'type': 'message', 'role': role, 'content': [], 'model': model, 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': as_int(usage.get('input_tokens'), 0), 'output_tokens': 0}}}))
    for i, block in enumerate(content):
        if not isinstance(block, dict):
            continue
        events.append(writeAnthropicSseData('content_block_start', {'type': 'content_block_start', 'index': i, 'content_block': block}))
        blockType = as_str(block.get('type'), '')
        if blockType == 'text':
            events.append(writeAnthropicSseData('content_block_delta', {'type': 'content_block_delta', 'index': i, 'delta': {'type': 'text_delta', 'text': as_str(block.get('text'), '')}}))
        elif blockType == 'tool_use':
            events.append(writeAnthropicSseData('content_block_delta', {'type': 'content_block_delta', 'index': i, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(as_dict(block.get('input'), {}))}}))
        events.append(writeAnthropicSseData('content_block_stop', {'type': 'content_block_stop', 'index': i}))
    stopReason = as_str(response.get('stop_reason'), '') or 'end_turn'
    if content and isinstance(content[-1], dict) and as_str(content[-1].get('type'), '') == 'tool_use':
        stopReason = 'tool_use'
    events.append(writeAnthropicSseData('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stopReason, 'stop_sequence': None}, 'usage': {'output_tokens': as_int(usage.get('output_tokens'), 0)}}))
    events.append(writeAnthropicSseData('message_stop', {'type': 'message_stop'}))
    return events

def createAnthropicNativeStreamState() -> dict[str, JsonValue]:
    """Create state for tracking an Anthropic native stream.

    Returns a mutable dict used as an accumulator. The keys are:
    message_id, model, role, content_blocks, current_index,
    stop_reason, input_tokens, output_tokens, _started, _text_block_started,
    _reasoning_block_started.
    """
    return {'message_id': '', 'model': '', 'role': 'assistant', 'content_blocks': [], 'current_index': -1, 'stop_reason': None, 'input_tokens': 0, 'output_tokens': 0}

def createOpenaiToAnthropicStreamState() -> dict[str, JsonValue]:
    """Create state for converting OpenAI SSE to Anthropic format."""
    return {'message_id': f'msg_{uuid.uuid4().hex[:16]}', 'model': '', 'role': 'assistant', 'content_blocks': [], 'current_index': 0, 'stop_reason': None, 'input_tokens': 0, 'output_tokens': 0, 'accumulated_text': '', 'accumulated_reasoning': '', 'pending_tool_calls': []}

def streamOpenaiDeltaAsAnthropic(chunk: dict[str, JsonValue], state: dict[str, JsonValue]) -> list[str]:
    """Convert an OpenAI Chat Completions chunk to Anthropic SSE events."""
    events: list[str] = []
    choices = as_list(chunk.get('choices'), [])
    if not choices:
        return events
    choice = choices[0]
    choiceDict = as_dict(choice, {})
    delta = as_dict(choiceDict.get('delta'), {})
    finishReason = as_str(choiceDict.get('finish_reason'), '') or None
    chunkId = as_str(chunk.get('id'), '')
    if chunkId and not state.get('_started'):
        state['message_id'] = chunkId
    model = as_str(chunk.get('model'), '')
    if model:
        state['model'] = model
    if not state.get('_started'):
        state['_started'] = True
        events.append(writeAnthropicSseData('message_start', {'type': 'message_start', 'message': {'id': state['message_id'], 'type': 'message', 'role': 'assistant', 'content': [], 'model': as_str(state.get('model'), 'unknown'), 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 0, 'output_tokens': 0}}}))
    content = as_str(delta.get('content'), '')
    reasoning = as_str(delta.get('reasoning'), '') or as_str(delta.get('reasoning_content'), '')
    if content:
        if not state.get('_text_block_started'):
            state['_text_block_started'] = True
            idx = as_int(state.get('current_index'), -1) + 1
            state['current_index'] = idx
            events.append(writeAnthropicSseData('content_block_start', {'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'text', 'text': ''}}))
        events.append(writeAnthropicSseData('content_block_delta', {'type': 'content_block_delta', 'index': as_int(state.get('current_index'), -1), 'delta': {'type': 'text_delta', 'text': content}}))
        state['accumulated_text'] = as_str(state.get('accumulated_text'), '') + content
    if reasoning:
        if not state.get('_reasoning_block_started'):
            state['_reasoning_block_started'] = True
            idx = as_int(state.get('current_index'), -1) + 1
            state['current_index'] = idx
            events.append(writeAnthropicSseData('content_block_start', {'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'thinking', 'text': ''}}))
        events.append(writeAnthropicSseData('content_block_delta', {'type': 'content_block_delta', 'index': as_int(state.get('current_index'), -1), 'delta': {'type': 'thinking_delta', 'thinking': reasoning}}))
        state['accumulated_reasoning'] = as_str(state.get('accumulated_reasoning'), '') + reasoning
    toolCalls = as_list(delta.get('tool_calls'), [])
    pending = as_list(state.get('pending_tool_calls'), [])
    for tc in toolCalls:
        if not isinstance(tc, dict):
            continue
        existing = next((t for t in pending if isinstance(t, dict) and t.get('index') == tc.get('index')), None)
        if existing:
            tcId = tc.get('id')
            if tcId:
                existing['id'] = tcId
            tcFn = as_dict(tc.get('function'), {})
            tcName = tcFn.get('name')
            if tcName:
                existingFn = as_dict(existing.get('function'), {})
                existingFn['name'] = as_str(existingFn.get('name'), '') + as_str(tcName, '')
                existing['function'] = existingFn
            tcArgs = tcFn.get('arguments')
            if tcArgs:
                existingFn = as_dict(existing.get('function'), {})
                existingFn['arguments'] = as_str(existingFn.get('arguments'), '') + as_str(tcArgs, '')
                existing['function'] = existingFn
        else:
            tcFn = as_dict(tc.get('function'), {})
            pending.append({'index': as_int(tc.get('index'), 0), 'id': as_str(tc.get('id'), ''), 'type': 'function', 'function': {'name': as_str(tcFn.get('name'), ''), 'arguments': as_str(tcFn.get('arguments'), '')}})
    state['pending_tool_calls'] = pending
    if finishReason and finishReason != 'null':
        if state.get('_text_block_started'):
            events.append(writeAnthropicSseData('content_block_stop', {'type': 'content_block_stop', 'index': as_int(state.get('current_index'), -1)}))
        if state.get('_reasoning_block_started'):
            events.append(writeAnthropicSseData('content_block_stop', {'type': 'content_block_stop', 'index': as_int(state.get('current_index'), -1)}))
        pending = as_list(state.get('pending_tool_calls'), [])
        for tc in pending:
            if not isinstance(tc, dict):
                continue
            idx = as_int(state.get('current_index'), -1) + 1
            state['current_index'] = idx
            tcFn = as_dict(tc.get('function'), {})
            toolName = as_str(tcFn.get('name'), '')
            toolArgsStr = as_str(tcFn.get('arguments'), '{}')
            try:
                toolInput = json.loads(toolArgsStr) if toolArgsStr else {}
            except (json.JSONDecodeError, TypeError):
                toolInput = {}
            events.append(writeAnthropicSseData('content_block_start', {'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'tool_use', 'id': tc.get('id', f'toolu_{uuid.uuid4().hex[:16]}'), 'name': toolName, 'input': toolInput}}))
            events.append(writeAnthropicSseData('content_block_delta', {'type': 'content_block_delta', 'index': idx, 'delta': {'type': 'input_json_delta', 'partial_json': toolArgsStr}}))
            events.append(writeAnthropicSseData('content_block_stop', {'type': 'content_block_stop', 'index': idx}))
            contentBlocks = as_list(state.get('content_blocks'), [])
            contentBlocks.append({'type': 'tool_use', 'id': as_str(tc.get('id'), ''), 'name': toolName, 'input': toolInput})
            state['content_blocks'] = contentBlocks
        anthropicStopReason = 'end_turn'
        if finishReason == 'tool_calls':
            anthropicStopReason = 'tool_use'
        elif finishReason == 'length':
            anthropicStopReason = 'max_tokens'
        events.append(writeAnthropicSseData('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': anthropicStopReason, 'stop_sequence': None}, 'usage': {'input_tokens': as_int(state.get('input_tokens'), 0), 'output_tokens': as_int(state.get('output_tokens'), 0)}}))
        events.append(writeAnthropicSseData('message_stop', {'type': 'message_stop'}))
    usage = as_dict(chunk.get('usage'), {})
    if usage:
        state['input_tokens'] = as_int(usage.get('prompt_tokens'), 0)
        state['output_tokens'] = as_int(usage.get('completion_tokens'), 0)
    return events

def buildOpenaiAggregatedForAnthropicFromStream(state: dict[str, JsonValue]) -> dict[str, JsonValue]:
    """Build an OpenAI chat completion response from accumulated Anthropic stream state."""
    inputTokens = as_int(state.get('input_tokens'), 0)
    outputTokens = as_int(state.get('output_tokens'), 0)
    return {
        'id': state.get('message_id', f'chatcmpl-{uuid.uuid4().hex[:12]}'),
        'object': 'chat.completion',
        'created': int(time.time()),
        'model': as_str(state.get('model'), 'unknown'),
        'choices': [{
            'index': 0,
            'message': {'role': 'assistant', 'content': as_str(state.get('accumulated_text'), '')},
            'finish_reason': as_str(state.get('stop_reason'), 'stop'),
        }],
        'usage': {
            'prompt_tokens': inputTokens,
            'completion_tokens': outputTokens,
            'total_tokens': inputTokens + outputTokens,
        },
    }

async def resolveManagedAnthropicToolUses(messages: list[dict[str, JsonValue]], system: list[dict[str, JsonValue]] | None, model: str, upstreamUrl: str, upstreamHeaders: dict[str, str], isAnthropicUpstream: bool, knownTools: list[dict[str, JsonValue]], managedLocalToolNames: set[str], clientToolNames: set[str], workspacePath: str | None=None, onToolEvent: Callable[[dict[str, JsonValue]], None] | None=None, parentSignal: object=None, client: BaseProviderClient | None=None) -> tuple[list[dict[str, JsonValue]], dict[str, JsonValue] | None]:
    """Run the multi-round tool resolution loop for Anthropic-format requests.

    Similar to the OpenAI version but works with Anthropic's content block format.
    """
    currentMessages = list(messages)
    currentSystem = list(system) if system else []
    finalUsage: dict[str, JsonValue] | None = None
    if not client:
        return (currentMessages, {'error': 'No client available for tool resolution'})
    for _round in range(MAX_MANAGED_TOOL_ROUNDS):
        reqBody: dict[str, JsonValue] = {'model': model, 'messages': cast(JsonValue, currentMessages), 'max_tokens': 8192, 'stream': False}
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
                openaiBody['tools'] = [anthropicToOpenaiToolDefinition(t) for t in knownTools]
            openaiBodyJson = cast(dict[str, object], as_dict(camelToSnake(openaiBody), {}))
            resp = await client.requestJson('POST', upstreamUrl, upstreamHeaders, openaiBodyJson)
        if resp.status != 200:
            errBody: dict[str, JsonValue] = as_dict(resp.body, {}) if isinstance(resp.body, dict) else {'error': str(resp.body or '')}
            return (currentMessages, errBody)
        responseBody = as_dict(snakeToCamel(cast(JsonValue, resp.bodyJson)), {})
        if responseBody.get('usage'):
            finalUsage = as_dict(responseBody.get('usage'), {})
        if isAnthropicUpstream:
            content = as_list(responseBody.get('content'), [])
            assistantMsg: dict[str, JsonValue] = {'role': 'assistant', 'content': content}
            toolUses = [b for b in content if isinstance(b, dict) and b.get('type') == 'tool_use']
        else:
            choices = as_list(responseBody.get('choices'), [])
            if not choices:
                break
            msg = as_dict(choices[0], {})
            assistantMsg = msg
            toolUses = []
            for tc in as_list(msg.get('tool_calls'), []):
                if not isinstance(tc, dict):
                    continue
                tcFn = as_dict(tc.get('function'), {})
                toolUses.append({'type': 'tool_use', 'name': as_str(tcFn.get('name'), ''), 'input': json.loads(as_str(tcFn.get('arguments'), '{}'))})
        if not toolUses:
            currentMessages.append(assistantMsg)
            break
        classification = cast(
            'dict[str, JsonValue]',
            classifyAnthropicToolUses(
                cast('list[dict[str, object]] | None', toolUses),
                managedLocalToolNames,
                clientToolNames,
            ),
        )
        if not classification.get('has_managed'):
            currentMessages.append(assistantMsg)
            break
        toolResults: list[dict[str, JsonValue]] = []
        for tu in as_list(classification.get('managed_tool_uses'), []):
            if not isinstance(tu, dict):
                continue
            toolName = as_str(tu.get('name'), '')
            toolInput = as_dict(tu.get('input'), {})
            toolUseId = as_str(tu.get('id'), f'toolu_{uuid.uuid4().hex[:16]}')
            try:
                result = await executeManagedProxyTool(toolName, toolInput, workspacePath, parentSignal=parentSignal)
                tr = ToolResultBlock(tool_use_id=toolUseId, content=formatManagedToolResult(toolName, result))
                toolResults.append(tr.model_dump())  # type: ignore[misc]
            except Exception as exc:
                tr = ToolResultBlock(tool_use_id=toolUseId, content=f'Error: {exc}', is_error=True)
                toolResults.append(tr.model_dump())  # type: ignore[misc]
        currentMessages.append(assistantMsg)
        currentMessages.extend(toolResults)
        if classification['has_client_or_unknown']:
            break
    return (currentMessages, finalUsage)

async def handleMessages(body: AnthropicRequest | dict[str, JsonValue], request: object=None) -> tuple[dict[str, JsonValue] | AsyncIterator[str], dict[str, str] | None]:
    """Handle a POST /v1/messages request.

    Returns a tuple of (response_or_stream, response_headers).
    """
    if isinstance(body, AnthropicRequest):
        model: str = body.model
        raw_body = cast('dict[str, JsonValue]', body.model_dump())
    else:
        model = as_str(body.get('model'), 'claude-sonnet-4-7')
        raw_body = body
    resolvedModel = resolveClaudePublicModelAlias(model)
    try:
        resolved = resolve(resolvedModel, defaultAlias='claude-sonnet-4-7')
        providerName = as_str(resolved.get('provider'), '')
        resolvedModel = as_str(resolved.get('model'), resolvedModel)
    except Exception:
        providerName = resolvedModel
    provider = providerResolver.resolve(providerName)
    if not provider:
        return ({'error': 'No provider available for model', 'model': resolvedModel}, None)
    client = getClient(provider)
    if not client:
        return ({'error': f"No client for provider: {as_str(provider.get('name'), '')}"}, None)
    apiKey = client.resolveApiKey()
    if not apiKey:
        return ({'error': 'API key not configured for provider'}, None)
    headers = client.buildAuthHeaders(apiKey)
    baseUrl = client.resolveBaseUrl()
    isAnthropicUpstream = client.apiFormat == 'anthropicMessages'
    if isAnthropicUpstream:
        upstreamUrl = f'{baseUrl}/messages'
    else:
        upstreamUrl = f'{baseUrl}/chat/completions'
    clientWantsStream = body.stream if isinstance(body, AnthropicRequest) else body.get('stream', False)
    systemBlocks = buildAnthropicSystemBlocks(as_list(raw_body.get('system'), []))
    clientToolsRaw = as_list(raw_body.get('tools'), [])
    managedWebTools = getManagedAnthropicWebToolDefinitions()
    clientTools = cast('list[dict[str, JsonValue]]', clientToolsRaw)
    knownTools = dedupeAndCanonicalizeAnthropicTools(clientTools + managedWebTools)
    managedLocalToolNames: set[str] = set()
    clientToolNames: set[str] = set()
    # Proxy-injected managed web tools are always locally executable, even if
    # the client didn't list them in its own tool set. Seed the managed set so
    # classifyAnthropicToolUses() recognizes model calls to them as managed.
    for t in managedWebTools:
        name = as_str(getToolDefinitionName(t), '') or as_str(t.get('name'), '')
        if name:
            managedLocalToolNames.add(name)
    for t in clientTools:
        name = as_str(getToolDefinitionName(t), '') or as_str(t.get('name'), '')
        if isProxyManagedLocalToolName(name):
            managedLocalToolNames.add(name)
        else:
            clientToolNames.add(name)
    if clientWantsStream:
        if isAnthropicUpstream:
            stream = _streamAnthropicNative(upstreamUrl, headers, raw_body, resolvedModel, systemBlocks, knownTools, managedLocalToolNames, clientToolNames, client=client)
        else:
            stream = _streamOpenaiAsAnthropic(upstreamUrl, headers, raw_body, resolvedModel, systemBlocks, knownTools, managedLocalToolNames, clientToolNames, client=client)
        return (stream, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive'})
    else:
        return await _handleMessagesNonStreaming(upstreamUrl, headers, raw_body, resolvedModel, isAnthropicUpstream, systemBlocks, knownTools, managedLocalToolNames, clientToolNames, client=client)

async def _handleMessagesNonStreaming(upstreamUrl: str, upstreamHeaders: dict[str, str], body: dict[str, JsonValue], model: str, isAnthropicUpstream: bool, systemBlocks: list[dict[str, JsonValue]], knownTools: list[dict[str, JsonValue]], managedLocalToolNames: set[str], clientToolNames: set[str], client: BaseProviderClient) -> tuple[dict[str, JsonValue], None]:
    """Non-streaming path for /v1/messages."""
    messages = cast('list[dict[str, JsonValue]]', as_list(body.get('messages'), []))
    if isAnthropicUpstream:
        reqBody = buildAnthropicUpstreamRequest(body, model, systemBlocks)
        if knownTools:
            reqBody['tools'] = cast(JsonValue, knownTools)
        reqBody['stream'] = False
        reqBodyJson = cast(dict[str, object], as_dict(camelToSnake(reqBody), {}))
        resp = await client.requestJson('POST', upstreamUrl, upstreamHeaders, reqBodyJson)
        responseBody = as_dict(snakeToCamel(cast(JsonValue, resp.bodyJson)), {})
        if resp.isError:
            return (responseBody, None)
        content = as_list(responseBody.get('content'), [])
        toolUses = [b for b in content if isinstance(b, dict) and as_str(b.get('type'), '') == 'tool_use']
        if toolUses:
            updatedMessages, usage = await resolveManagedAnthropicToolUses(messages, systemBlocks, model, upstreamUrl, upstreamHeaders, True, knownTools, managedLocalToolNames, clientToolNames, client=client)
            lastMsg = updatedMessages[-1] if updatedMessages else {}
            resolvedUsage: dict[str, JsonValue] = as_dict(usage, {})
            resp_usage = AnthropicUsage(input_tokens=as_int(resolvedUsage.get('input_tokens'), 0), output_tokens=as_int(resolvedUsage.get('output_tokens'), 0))
            return ({'id': as_str(responseBody.get('id'), f'msg_{uuid.uuid4().hex[:16]}'), 'type': 'message', 'role': 'assistant', 'content': as_list(lastMsg.get('content'), []), 'model': model, 'stop_reason': 'end_turn', 'stop_sequence': None, 'usage': resp_usage.model_dump()}, None)
        return (responseBody, None)
    else:
        openaiBody = buildOpenaiRequest(body, model, systemBlocks)
        if knownTools:
            openaiBody['tools'] = [anthropicToOpenaiToolDefinition(t) for t in knownTools]
        openaiBody['stream'] = False
        openaiBodyJson = cast(dict[str, object], as_dict(camelToSnake(openaiBody), {}))
        resp = await client.requestJson('POST', upstreamUrl, upstreamHeaders, openaiBodyJson)
        responseBody = as_dict(snakeToCamel(cast(JsonValue, resp.bodyJson)), {})
        if resp.isError:
            return (responseBody, None)
        return (_translateOpenaiToAnthropicResponse(responseBody, model), None)

async def _streamAnthropicNative(upstreamUrl: str, upstreamHeaders: dict[str, str], body: dict[str, JsonValue], model: str, systemBlocks: list[dict[str, JsonValue]], knownTools: list[dict[str, JsonValue]], managedLocalToolNames: set[str], clientToolNames: set[str], client: BaseProviderClient) -> AsyncIterator[str]:
    """Stream from an Anthropic upstream in native format.

    Intercepts tool uses and resolves managed tools.
    """
    reqBody = buildAnthropicUpstreamRequest(body, model, systemBlocks)
    if knownTools:
        reqBody['tools'] = cast(JsonValue, knownTools)
    reqBody['stream'] = True
    toolRound = 0
    currentMessages: list[dict[str, JsonValue]] = cast('list[dict[str, JsonValue]]', as_list(body.get('messages'), []))
    while toolRound < MAX_MANAGED_TOOL_ROUNDS:
        st = AnthropicNativeStreamState()
        roundBody = dict(reqBody)
        roundBody['messages'] = cast(JsonValue, currentMessages)
        roundBodyJson = cast(dict[str, object], as_dict(camelToSnake(roundBody), {}))
        async for rawEvent in client.streamSse(upstreamUrl, upstreamHeaders, roundBodyJson):
            event = cast('dict[str, JsonValue]', rawEvent)
            if as_str(event.get('type'), '') == 'error':
                yield writeAnthropicSseData('error', {'error': {'message': as_str(event.get('body'), as_str(event.get('error'), ''))}})
                return
            yield writeAnthropicSseDataOnly(event)
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
                st.process_message_stop(event)
            elif eventTypePayload == 'ping':
                st.process_ping(event)
        toolUses = st.get_tool_uses()
        if not toolUses:
            break
        classification = cast('dict[str, JsonValue]', classifyAnthropicToolUses(toolUses, managedLocalToolNames, clientToolNames))
        if not classification.get('has_managed'):
            break
        toolRound += 1
        assistantMsg: dict[str, JsonValue] = {'role': 'assistant', 'content': cast(JsonValue, list(st.data.content_blocks))}
        currentMessages.append(assistantMsg)
        for tu in as_list(classification.get('managed_tool_uses'), []):
            if not isinstance(tu, dict):
                continue
            toolName = as_str(tu.get('name'), '')
            toolInput = as_dict(tu.get('input'), {})
            toolUseId = as_str(tu.get('id'), f'toolu_{uuid.uuid4().hex[:16]}')
            try:
                result = await executeManagedProxyTool(toolName, toolInput)
                tr = ToolResultBlock(tool_use_id=toolUseId, content=formatManagedToolResult(toolName, result))
                currentMessages.append(tr.model_dump())  # type: ignore[misc]
            except Exception as exc:
                tr = ToolResultBlock(tool_use_id=toolUseId, content=f'Error: {exc}', is_error=True)
                currentMessages.append(tr.model_dump())  # type: ignore[misc]
        continue
    yield writeAnthropicSseData('message_stop', {'type': 'message_stop'})

async def _streamOpenaiAsAnthropic(upstreamUrl: str, upstreamHeaders: dict[str, str], body: dict[str, JsonValue], model: str, systemBlocks: list[dict[str, JsonValue]], knownTools: list[dict[str, JsonValue]], managedLocalToolNames: set[str], clientToolNames: set[str], client: BaseProviderClient) -> AsyncIterator[str]:
    """Stream from an OpenAI-format upstream and convert to Anthropic SSE."""
    openaiBody = buildOpenaiRequest(body, model, systemBlocks)
    if knownTools:
        openaiBody['tools'] = [anthropicToOpenaiToolDefinition(t) for t in knownTools]
    openaiBody['stream'] = True
    toolRound = 0
    currentMessages: list[dict[str, JsonValue]] = cast('list[dict[str, JsonValue]]', as_list(body.get('messages'), []))
    while toolRound < MAX_MANAGED_TOOL_ROUNDS:
        st = OpenaiToAnthropicStreamState()
        roundBody = dict(openaiBody)
        roundBody['messages'] = cast(JsonValue, currentMessages)
        roundBodyJson = cast(dict[str, object], as_dict(camelToSnake(roundBody), {}))
        async for rawChunk in client.streamSse(upstreamUrl, upstreamHeaders, roundBodyJson):
            chunk = cast('dict[str, JsonValue]', rawChunk)
            if as_str(chunk.get('type'), '') == 'error':
                yield writeAnthropicSseData('error', {'error': {'message': as_str(chunk.get('body'), as_str(chunk.get('error'), ''))}})
                return
            events = st.convert_chunk(chunk)
            for eventStr in events:
                yield eventStr
            choices = as_list(chunk.get('choices'), [])
            if choices and isinstance(choices[0], dict) and as_str(choices[0].get('finish_reason'), '') == 'tool_calls':
                toolCalls = []
                for tc in st.pending_tool_calls:
                    toolCalls.append(tc.to_anthropic_tool_use())
                if not toolCalls:
                    break
                classification = cast('dict[str, JsonValue]', classifyAnthropicToolUses(toolCalls, managedLocalToolNames, clientToolNames))
                if not classification.get('has_managed'):
                    break
                toolRound += 1
                currentMessages.append({'role': 'assistant', 'content': [{'type': 'text', 'text': st.accumulated_text}, *toolCalls]})
                for tu in as_list(classification.get('managed_tool_uses'), []):
                    if not isinstance(tu, dict):
                        continue
                    tuName = as_str(tu.get('name'), '')
                    tuInput = as_dict(tu.get('input'), {})
                    tuId = as_str(tu.get('id'), '')
                    try:
                        result = await executeManagedProxyTool(tuName, tuInput)
                        tr = ToolResultBlock(tool_use_id=tuId, content=formatManagedToolResult(tuName, result))
                        currentMessages.append(tr.model_dump())  # type: ignore[misc]
                    except Exception as exc:
                        tr = ToolResultBlock(tool_use_id=tuId, content=f'Error: {exc}', is_error=True)
                        currentMessages.append(tr.model_dump())  # type: ignore[misc]
                continue
        break
    yield writeAnthropicSseData('message_stop', {'type': 'message_stop'})

def _translateOpenaiToAnthropicResponse(openaiResponse: dict[str, JsonValue], model: str) -> dict[str, JsonValue]:
    """Convert an OpenAI Chat Completions response to Anthropic Messages format."""
    choices = as_list(openaiResponse.get('choices'), [])
    if not choices:
        resp = AnthropicResponse(id=f'msg_{uuid.uuid4().hex[:16]}', model=model)
        return resp.model_dump()  # type: ignore[return-value]
    choiceDict = as_dict(choices[0], {})
    message = choiceDict
    contentList: list[dict[str, JsonValue]] = []
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
        contentList.append({'type': 'tool_use', 'id': as_str(tc.get('id'), f'toolu_{uuid.uuid4().hex[:16]}'), 'name': as_str(tcFn.get('name'), ''), 'input': toolInput})
    finishReason = as_str(choiceDict.get('finish_reason'), 'stop')
    stopReasonMap = {'stop': 'end_turn', 'tool_calls': 'tool_use', 'length': 'max_tokens', 'content_filter': 'content_filter'}
    usage = as_dict(openaiResponse.get('usage'), {})
    resp = AnthropicResponse(
        id=as_str(openaiResponse.get('id'), f'msg_{uuid.uuid4().hex[:16]}'),
        model=as_str(openaiResponse.get('model'), model),
        content=contentList,
        stop_reason=stopReasonMap.get(finishReason, 'end_turn'),
        usage=AnthropicUsage(input_tokens=as_int(usage.get('prompt_tokens'), 0), output_tokens=as_int(usage.get('completion_tokens'), 0)),
    )
    return resp.model_dump()  # type: ignore[return-value]

async def handleCountTokens(body: dict[str, JsonValue], request: object=None) -> dict[str, JsonValue]:
    """Handle a POST /v1/messages/count_tokens request."""
    from app.providers.clients.base import estimateTokens
    messages = cast('list[dict[str, object]]', as_list(body.get('messages'), []))
    tools = cast('list[dict[str, object]]', as_list(body.get('tools'), []))
    estimated = estimateTokens(messages, tools)
    return {'input_tokens': estimated, 'estimated': True}

def translateMessagesToAnthropic(messages: list[dict[str, JsonValue]]) -> list[dict[str, JsonValue]]:
    """Convert session messages (OpenAI or mixed format) to Anthropic Messages format.

    Groups consecutive tool messages into a single user message with tool_result blocks.
    Maps OpenAI assistant tool_calls to Anthropic content blocks with type='tool_use'.
    """
    translated: list[dict[str, JsonValue]] = []
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
                contentBlocks = []
                contentVal = msg.get('content')
                if contentVal:
                    contentBlocks.append({'type': 'text', 'text': contentVal})
                for tc in as_list(msg.get('tool_calls'), []):
                    if not isinstance(tc, dict):
                        continue
                    fn = as_dict(tc.get('function'), {})
                    try:
                        fnArgs = fn.get('arguments', {})
                        args = json.loads(as_str(fn.get('arguments'), '{}')) if isinstance(fnArgs, str) else as_dict(fnArgs, {})
                    except Exception:
                        args = {}
                    contentBlocks.append({'type': 'tool_use', 'id': as_str(tc.get('id'), ''), 'name': as_str(fn.get('name'), ''), 'input': args})
                translated.append({'role': 'assistant', 'content': cast(JsonValue, contentBlocks)})
            elif role == 'assistant' and isinstance(msg.get('content'), list):
                contentList = as_list(msg.get('content'), [])
                filtered = [b for b in contentList if not (isinstance(b, dict) and as_str(b.get('type'), '') == 'thinking' and (not b.get('signature')))]
                translated.append({'role': 'assistant', 'content': filtered if filtered else [{'type': 'text', 'text': ''}]})
            else:
                translated.append(msg)
            i += 1
    return translated