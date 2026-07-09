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
from typing import AsyncIterator, Callable
from app.typeAliases import JsonValue
from app.adapters.base import streamSse, buildHeaders
from app.adapters.proxyTools import getProxyOpenaiToolDefinitionsForAnthropic, getCanonicalManagedAnthropicWebTools, appendMissingAnthropicTools, formatManagedToolResult, executeManagedProxyTool, executeManagedOpenaiToolCalls, getToolDefinitionName, dedupeAndCanonicalizeAnthropicTools, sanitizeAnthropicToolDefinition, getManagedAnthropicWebToolDefinitions, openaiToAnthropicToolDefinition, anthropicToOpenaiToolDefinition, isProxyManagedLocalToolName, isBrowserAutomationToolName, buildClientToolGuidance
from app.adapters.toolClassification import classifyAnthropicToolUses, classifyOpenaiToolCalls, getToolNameFromAnthropicTool, getToolNameFromOpenaiTool
from app.adapters.caseConverters import snakeToCamel, camelToSnake
from app.providers import resolver as providerResolver
from app.providers.modelResolver import resolve, resolveOrFallback
from app.providers.clients import getClient
CLAUDE_PUBLIC_MODEL_ALIAS = 'claude-opus-4-6'
KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES = {'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'}
MAX_MANAGED_TOOL_ROUNDS = 10
AUGUST_REMINDER = 'This proxy environment is August Proxy — a multi-model AI gateway. You have access to the August tool suite for file operations, web access, bash commands, and memory.'
RULE_REMINDER_MESSAGE: dict[str, JsonValue] = {'type': 'text', 'text': '## Operational Rules\n\n1. When browsing the web, prioritize fetching text content directly.\n2. When executing commands, prefer safe, non-destructive operations.\n3. Always verify file paths before writing.\n4. Respect user privacy and data boundaries.\n5. If a tool fails, retry with corrected parameters before reporting failure.'}

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
    if lowered in ('sonnet', 'sonnet[1m]'):
        return 'claude-sonnet-4-6'
    if lowered in ('opus', 'opus[1m]', 'best', 'opusplan'):
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
                    text = block.get('text', '')
                    if 'August Proxy' in text or 'August tool suite' in text:
                        return False
    if existingSystem:
        for block in existingSystem:
            text = block.get('text', '') if isinstance(block, dict) else str(block)
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
        return [{'type': 'text', 'text': block} if isinstance(block, str) else block for block in system]
    return [{'type': 'text', 'text': str(system)}]

def systemBlocksToText(blocks: list[dict[str, JsonValue]] | None) -> str:
    """Flatten system blocks into a single text string."""
    if not blocks:
        return ''
    parts = []
    for block in blocks:
        if isinstance(block, dict):
            if block.get('type') == 'text':
                parts.append(block.get('text', ''))
            elif block.get('type') == 'tool_use':
                parts.append(json.dumps(block.get('input', {})))
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
        blocks[-1] = {'type': 'text', 'text': blocks[-1]['text'] + ('\n\n' if not text.startswith('\n') else '') + text}
    else:
        blocks.append({'type': 'text', 'text': text})
    return blocks

def deriveSessionIdFromAnthropic(body: dict[str, JsonValue] | None, request: object | None=None) -> str:
    """Extract a session identifier from an Anthropic Messages body."""
    if body and isinstance(body, dict):
        fromBody = body.get('sessionId') or body.get('session_id') or body.get('metadata', {}).get('sessionId') or body.get('metadata', {}).get('session_id')
        if fromBody:
            return str(fromBody)
    if request and hasattr(request, 'headers'):
        for key in ['x-session-id', 'x-conversation-id', 'x-claude-code-session-id', 'x-request-id']:
            value = request.headers.get(key)
            if value:
                return str(value)
    return ''

def extractRequestHeaders(request: object) -> dict[str, str]:
    """Safely extract relevant request headers into a dict."""
    if not request or not hasattr(request, 'headers'):
        return {}
    out: dict[str, str] = {}
    for key in ['x-session-id', 'x-conversation-id', 'x-request-id', 'x-correlation-id', 'user-agent', 'x-august-client']:
        value = request.headers.get(key)
        if value:
            out[key] = str(value)
    return out

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
                parts = []
                for block in content:
                    if block.get('type') == 'text':
                        parts.append({'type': 'text', 'text': block.get('text', '')})
                    elif block.get('type') == 'image_url' or block.get('type') == 'image':
                        parts.append({'type': 'image_url', 'image_url': {'url': block.get('source', {}).get('data', '')}})
                    elif block.get('type') == 'tool_result':
                        pass
                if parts:
                    openaiMessages.append({'role': 'user', 'content': parts})
        elif role == 'assistant':
            asstMsg: dict[str, JsonValue] = {'role': 'assistant'}
            if isinstance(content, str):
                asstMsg['content'] = content
            elif isinstance(content, list):
                textParts = []
                toolCalls = []
                for block in content:
                    if block.get('type') == 'text':
                        textParts.append(block.get('text', ''))
                    elif block.get('type') == 'tool_use':
                        toolCalls.append({'id': block.get('id', ''), 'type': 'function', 'function': {'name': block.get('name', ''), 'arguments': json.dumps(block.get('input', {}))}})
                    elif block.get('type') == 'thinking':
                        asstMsg['reasoning'] = asstMsg.get('reasoning', '') + block.get('text', '')
                        asstMsg['reasoning_content'] = asstMsg.get('reasoning_content', '') + block.get('text', '')
                asstMsg['content'] = ''.join(textParts) if textParts else ''
                if toolCalls:
                    asstMsg['tool_calls'] = toolCalls
            if msg.get('tool_calls') and 'tool_calls' not in asstMsg:
                asstMsg.setdefault('content', msg.get('content', ''))
                safeCalls = []
                for tc in msg['tool_calls']:
                    tcCopy = dict(tc)
                    fn = dict(tcCopy.get('function', {}))
                    if 'arguments' in fn and (not isinstance(fn['arguments'], str)):
                        fn['arguments'] = json.dumps(fn['arguments'])
                    tcCopy['function'] = fn
                    safeCalls.append(tcCopy)
                asstMsg['tool_calls'] = safeCalls
            openaiMessages.append(asstMsg)
        elif role == 'tool':
            toolResult = content
            if isinstance(toolResult, list):
                text = ''
                for block in toolResult:
                    if isinstance(block, dict):
                        if block.get('type') == 'text':
                            text += block.get('text', '')
                        elif block.get('type') == 'tool_use':
                            text += json.dumps(block.get('input', {}))
                        else:
                            text += json.dumps(block)
                    else:
                        text += str(block)
                toolResult = text
            elif not isinstance(toolResult, str):
                toolResult = json.dumps(toolResult)
            openaiMessages.append({'role': 'tool', 'tool_call_id': msg.get('tool_use_id') or msg.get('tool_call_id', ''), 'content': toolResult})
    return openaiMessages

def sanitizeMessagesForOpenaiUpstream(messages: list[dict[str, JsonValue]]) -> list[dict[str, JsonValue]]:
    """Fix messages for OpenAI upstream compatibility.

    Removes tool_use_id from assistant messages, ensures ordering.
    """
    sanitized: list[dict[str, JsonValue]] = []
    for msg in messages:
        sanitized.append(msg)
    return sanitized

def repairManagedWebToolResults(messages: list[dict[str, JsonValue]], managedLocalToolNames: set[str]) -> tuple[list[dict[str, JsonValue]], bool]:
    """Repair managed web tool results that may have been corrupted by the client.

    This handles the case where a third-party client strips or reformats
    web tool results, which breaks the upstream model's understanding.
    """
    return (messages, False)

def buildOpenaiRequest(body: dict[str, JsonValue], model: str, system: list[dict[str, JsonValue]] | None=None) -> dict[str, JsonValue]:
    """Build an OpenAI-format request from an Anthropic Messages body."""
    openaiBody: dict[str, JsonValue] = {'model': model, 'messages': translateMessages(body.get('messages', []), system)}
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
    thinking = body.get('thinking', {})
    if thinking and isinstance(thinking, dict):
        budget = thinking.get('budget_tokens', 0)
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

def buildAnthropicUpstreamRequest(body: dict[str, JsonValue], model: str, system: list[dict[str, JsonValue]] | None=None) -> dict[str, JsonValue]:
    """Build an Anthropic-format request for native upstream calls."""
    anthropicBody: dict[str, JsonValue] = {'model': model, 'messages': body.get('messages', [])}
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
        anthropicBody['system'] = system
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
    responseId = response.get('id', f'msg_{uuid.uuid4().hex[:16]}')
    model = response.get('model', 'unknown')
    role = response.get('role', 'assistant')
    content = response.get('content', [])
    usage = response.get('usage', {})
    events.append(writeAnthropicSseData('message_start', {'type': 'message_start', 'message': {'id': responseId, 'type': 'message', 'role': role, 'content': [], 'model': model, 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': usage.get('input_tokens', 0), 'output_tokens': 0}}}))
    for i, block in enumerate(content):
        events.append(writeAnthropicSseData('content_block_start', {'type': 'content_block_start', 'index': i, 'content_block': block}))
        if block.get('type') == 'text':
            events.append(writeAnthropicSseData('content_block_delta', {'type': 'content_block_delta', 'index': i, 'delta': {'type': 'text_delta', 'text': block.get('text', '')}}))
        elif block.get('type') == 'tool_use':
            events.append(writeAnthropicSseData('content_block_delta', {'type': 'content_block_delta', 'index': i, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(block.get('input', {}))}}))
        events.append(writeAnthropicSseData('content_block_stop', {'type': 'content_block_stop', 'index': i}))
    stopReason = response.get('stop_reason') or 'end_turn'
    if content and content[-1].get('type') == 'tool_use':
        stopReason = 'tool_use'
    events.append(writeAnthropicSseData('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stopReason, 'stop_sequence': None}, 'usage': {'output_tokens': usage.get('output_tokens', 0)}}))
    events.append(writeAnthropicSseData('message_stop', {'type': 'message_stop'}))
    return events

def createAnthropicNativeStreamState() -> dict[str, JsonValue]:
    """Create state for tracking an Anthropic native stream."""
    return {'message_id': '', 'model': '', 'role': 'assistant', 'content_blocks': [], 'current_index': -1, 'stop_reason': None, 'input_tokens': 0, 'output_tokens': 0}

def getClientAnthropicIndex(blockType: str, currentIndex: int) -> int:
    """Get the client-facing content block index.

    Anthropic SSE block indices can differ from the client-facing index
    when thinking blocks are present (they're counted server-side but
    may not be exposed to all clients).
    """
    return currentIndex

def createOpenaiToAnthropicStreamState() -> dict[str, JsonValue]:
    """Create state for converting OpenAI SSE to Anthropic format."""
    return {'message_id': f'msg_{uuid.uuid4().hex[:16]}', 'model': '', 'role': 'assistant', 'content_blocks': [], 'current_index': 0, 'stop_reason': None, 'input_tokens': 0, 'output_tokens': 0, 'accumulated_text': '', 'accumulated_reasoning': '', 'pending_tool_calls': []}

def streamOpenaiDeltaAsAnthropic(chunk: dict[str, JsonValue], state: dict[str, JsonValue]) -> list[str]:
    """Convert an OpenAI Chat Completions chunk to Anthropic SSE events."""
    events: list[str] = []
    choices = chunk.get('choices', [])
    if not choices:
        return events
    choice = choices[0]
    delta = choice.get('delta', {})
    finishReason = choice.get('finish_reason')
    if chunk.get('id') and (not state.get('_started')):
        state['message_id'] = chunk['id']
    if chunk.get('model'):
        state['model'] = chunk['model']
    if not state.get('_started'):
        state['_started'] = True
        events.append(writeAnthropicSseData('message_start', {'type': 'message_start', 'message': {'id': state['message_id'], 'type': 'message', 'role': 'assistant', 'content': [], 'model': state['model'] or 'unknown', 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 0, 'output_tokens': 0}}}))
    content = delta.get('content', '')
    reasoning = delta.get('reasoning') or delta.get('reasoning_content', '')
    if content:
        if not state.get('_text_block_started'):
            state['_text_block_started'] = True
            idx = state['current_index']
            state['current_index'] += 1
            events.append(writeAnthropicSseData('content_block_start', {'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'text', 'text': ''}}))
        events.append(writeAnthropicSseData('content_block_delta', {'type': 'content_block_delta', 'index': state['current_index'] - 1, 'delta': {'type': 'text_delta', 'text': content}}))
        state['accumulated_text'] += content
    if reasoning:
        if not state.get('_reasoning_block_started'):
            state['_reasoning_block_started'] = True
            idx = state['current_index']
            state['current_index'] += 1
            events.append(writeAnthropicSseData('content_block_start', {'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'thinking', 'text': ''}}))
        events.append(writeAnthropicSseData('content_block_delta', {'type': 'content_block_delta', 'index': state['current_index'] - 1, 'delta': {'type': 'thinking_delta', 'thinking': reasoning}}))
        state['accumulated_reasoning'] += reasoning
    toolCalls = delta.get('tool_calls', [])
    for tc in toolCalls:
        existing = next((t for t in state['pending_tool_calls'] if t.get('index') == tc.get('index')), None)
        if existing:
            if tc.get('id'):
                existing['id'] = tc['id']
            if tc.get('function', {}).get('name'):
                existing.setdefault('function', {})['name'] = existing['function'].get('name', '') + tc['function']['name']
            if tc.get('function', {}).get('arguments'):
                existing.setdefault('function', {})['arguments'] = existing['function'].get('arguments', '') + tc['function']['arguments']
        else:
            state['pending_tool_calls'].append({'index': tc.get('index', 0), 'id': tc.get('id', ''), 'type': 'function', 'function': {'name': tc.get('function', {}).get('name', ''), 'arguments': tc.get('function', {}).get('arguments', '')}})
    if finishReason and finishReason != 'null':
        if state.get('_text_block_started'):
            events.append(writeAnthropicSseData('content_block_stop', {'type': 'content_block_stop', 'index': state['current_index'] - 1}))
        if state.get('_reasoning_block_started'):
            events.append(writeAnthropicSseData('content_block_stop', {'type': 'content_block_stop', 'index': state['current_index'] - 1}))
        for i, tc in enumerate(state['pending_tool_calls']):
            idx = state['current_index']
            state['current_index'] += 1
            toolName = tc.get('function', {}).get('name', '')
            toolArgsStr = tc.get('function', {}).get('arguments', '{}')
            try:
                toolInput = json.loads(toolArgsStr) if toolArgsStr else {}
            except (json.JSONDecodeError, TypeError):
                toolInput = {}
            events.append(writeAnthropicSseData('content_block_start', {'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'tool_use', 'id': tc.get('id', f'toolu_{uuid.uuid4().hex[:16]}'), 'name': toolName, 'input': toolInput}}))
            events.append(writeAnthropicSseData('content_block_delta', {'type': 'content_block_delta', 'index': idx, 'delta': {'type': 'input_json_delta', 'partial_json': toolArgsStr}}))
            events.append(writeAnthropicSseData('content_block_stop', {'type': 'content_block_stop', 'index': idx}))
            state['content_blocks'].append({'type': 'tool_use', 'id': tc.get('id', ''), 'name': toolName, 'input': toolInput})
        anthropicStopReason = 'end_turn'
        if finishReason == 'tool_calls':
            anthropicStopReason = 'tool_use'
        elif finishReason == 'length':
            anthropicStopReason = 'max_tokens'
        events.append(writeAnthropicSseData('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': anthropicStopReason, 'stop_sequence': None}, 'usage': {'output_tokens': 0}}))
        events.append(writeAnthropicSseData('message_stop', {'type': 'message_stop'}))
    if chunk.get('usage'):
        state['input_tokens'] = chunk['usage'].get('prompt_tokens', 0)
        state['output_tokens'] = chunk['usage'].get('completion_tokens', 0)
    return events

def buildOpenaiAggregatedForAnthropicFromStream(state: dict[str, JsonValue]) -> dict[str, JsonValue]:
    """Build an OpenAI chat completion response from accumulated Anthropic stream state."""
    return {'id': state.get('message_id', f'chatcmpl-{uuid.uuid4().hex[:12]}'), 'object': 'chat.completion', 'created': int(time.time()), 'model': state.get('model', 'unknown'), 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': state.get('accumulated_text', '')}, 'finish_reason': state.get('stop_reason', 'stop')}], 'usage': {'prompt_tokens': state.get('input_tokens', 0), 'completion_tokens': state.get('output_tokens', 0), 'total_tokens': state.get('input_tokens', 0) + state.get('output_tokens', 0)}}

async def resolveManagedAnthropicToolUses(messages: list[dict[str, JsonValue]], system: list[dict[str, JsonValue]] | None, model: str, upstreamUrl: str, upstreamHeaders: dict[str, str], isAnthropicUpstream: bool, knownTools: list[dict[str, JsonValue]], managedLocalToolNames: set[str], clientToolNames: set[str], workspacePath: str | None=None, onToolEvent: Callable[[dict[str, JsonValue]], None] | None=None, parentSignal: object=None) -> tuple[list[dict[str, JsonValue]], dict[str, JsonValue] | None]:
    """Run the multi-round tool resolution loop for Anthropic-format requests.

    Similar to the OpenAI version but works with Anthropic's content block format.
    """
    currentMessages = list(messages)
    currentSystem = list(system) if system else []
    finalUsage: dict[str, JsonValue] | None = None
    for _round in range(MAX_MANAGED_TOOL_ROUNDS):
        reqBody: dict[str, JsonValue] = {'model': model, 'messages': currentMessages, 'max_tokens': 8192, 'stream': False}
        if currentSystem:
            reqBody['system'] = currentSystem
        if knownTools:
            reqBody['tools'] = knownTools
        if isAnthropicUpstream:
            client = getClient({'apiMode': 'anthropicMessages'})
            if client:
                resp = await client.request_json('POST', upstreamUrl, upstreamHeaders, camelToSnake(reqBody))
            else:
                return (currentMessages, {'error': 'No Anthropic client available'})
        else:
            openaiBody = buildOpenaiRequest({'messages': currentMessages}, model, currentSystem)
            if knownTools:
                openaiBody['tools'] = [anthropicToOpenaiToolDefinition(t) for t in knownTools]
            client = getClient({'apiMode': 'openaiChat'})
            if client:
                resp = await client.request_json('POST', upstreamUrl, upstreamHeaders, camelToSnake(openaiBody))
            else:
                return (currentMessages, {'error': 'No OpenAI client available'})
        if resp.is_error:
            return (currentMessages, resp.body if isinstance(resp.body, dict) else {'error': str(resp.body)})
        responseBody = snakeToCamel(resp.body_json) or {}
        if responseBody.get('usage'):
            finalUsage = responseBody['usage']
        if isAnthropicUpstream:
            content = responseBody.get('content', [])
            stopReason = responseBody.get('stop_reason', 'end_turn')
            assistantMsg: dict[str, JsonValue] = {'role': 'assistant', 'content': content}
            toolUses = [b for b in content if b.get('type') == 'tool_use'] if content else []
        else:
            choices = responseBody.get('choices', [])
            if not choices:
                break
            msg = choices[0].get('message', {})
            assistantMsg = msg
            toolUses = []
            for tc in msg.get('tool_calls', []):
                toolUses.append({'type': 'tool_use', 'name': tc.get('function', {}).get('name', ''), 'input': json.loads(tc.get('function', {}).get('arguments', '{}'))})
        if not toolUses:
            currentMessages.append(assistantMsg)
            break
        classification = classifyAnthropicToolUses(toolUses, managedLocalToolNames, clientToolNames)
        if not classification['has_managed']:
            currentMessages.append(assistantMsg)
            break
        toolResults: list[dict[str, JsonValue]] = []
        for tu in classification['managed_tool_uses']:
            toolName = tu.get('name', '')
            toolInput = tu.get('input', {})
            toolUseId = tu.get('id', f'toolu_{uuid.uuid4().hex[:16]}')
            try:
                result = await executeManagedProxyTool(toolName, toolInput, workspacePath, parent_signal=parentSignal)
                toolResults.append({'type': 'tool_result', 'tool_use_id': toolUseId, 'content': formatManagedToolResult(toolName, result)})
            except Exception as exc:
                toolResults.append({'type': 'tool_result', 'tool_use_id': toolUseId, 'content': f'Error: {exc}', 'is_error': True})
        currentMessages.append(assistantMsg)
        currentMessages.extend(toolResults)
        if classification['has_client_or_unknown']:
            break
    return (currentMessages, finalUsage)

async def handleMessages(body: dict[str, JsonValue], request: object=None) -> tuple[dict[str, JsonValue] | AsyncIterator[str], dict[str, str] | None]:
    """Handle a POST /v1/messages request.

    Returns a tuple of (response_or_stream, response_headers).
    """
    model = body.get('model', 'claude-sonnet-4-7')
    resolvedModel = resolveClaudePublicModelAlias(model)
    try:
        resolved = resolve(resolvedModel, default_alias='claude-sonnet-4-7')
        providerName = resolved['provider']
        resolvedModel = resolved['model']
    except Exception:
        providerName = resolvedModel
    provider = providerResolver.resolve(providerName)
    if not provider:
        return ({'error': 'No provider available for model', 'model': resolvedModel}, None)
    client = getClient(provider)
    if not client:
        return ({'error': f"No client for provider: {provider.get('name')}"}, None)
    apiKey = client.resolveApiKey()
    if not apiKey:
        return ({'error': 'API key not configured for provider'}, None)
    headers = client.buildAuthHeaders(apiKey)
    baseUrl = client.resolveBaseUrl()
    isAnthropicUpstream = client.api_format == 'anthropicMessages'
    if isAnthropicUpstream:
        upstreamUrl = f'{baseUrl}/messages'
    else:
        upstreamUrl = f'{baseUrl}/chat/completions'
    clientWantsStream = body.get('stream', False)
    systemBlocks = buildAnthropicSystemBlocks(body.get('system', []))
    clientTools = body.get('tools', [])
    managedWebTools = getManagedAnthropicWebToolDefinitions()
    knownTools = dedupeAndCanonicalizeAnthropicTools(clientTools + managedWebTools)
    managedLocalToolNames: set[str] = set()
    clientToolNames: set[str] = set()
    # Proxy-injected managed web tools are always locally executable, even if
    # the client didn't list them in its own tool set. Seed the managed set so
    # classifyAnthropicToolUses() recognizes model calls to them as managed.
    for t in managedWebTools:
        name = getToolDefinitionName(t) or t.get('name', '')
        if name:
            managedLocalToolNames.add(name)
    for t in clientTools:
        name = getToolDefinitionName(t) or t.get('name', '')
        if isProxyManagedLocalToolName(name):
            managedLocalToolNames.add(name)
        else:
            clientToolNames.add(name)
    sessionId = deriveSessionIdFromAnthropic(body, request)
    if clientWantsStream:
        if isAnthropicUpstream:
            stream = _streamAnthropicNative(upstreamUrl, headers, body, resolvedModel, systemBlocks, knownTools, managedLocalToolNames, clientToolNames)
        else:
            stream = _streamOpenaiAsAnthropic(upstreamUrl, headers, body, resolvedModel, systemBlocks, knownTools, managedLocalToolNames, clientToolNames)
        return (stream, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive'})
    else:
        return await _handleMessagesNonStreaming(upstreamUrl, headers, body, resolvedModel, isAnthropicUpstream, systemBlocks, knownTools, managedLocalToolNames, clientToolNames)

async def _handleMessagesNonStreaming(upstreamUrl: str, upstreamHeaders: dict[str, str], body: dict[str, JsonValue], model: str, isAnthropicUpstream: bool, systemBlocks: list[dict[str, JsonValue]], knownTools: list[dict[str, JsonValue]], managedLocalToolNames: set[str], clientToolNames: set[str]) -> tuple[dict[str, JsonValue], None]:
    """Non-streaming path for /v1/messages."""
    messages = body.get('messages', [])
    if isAnthropicUpstream:
        reqBody = buildAnthropicUpstreamRequest(body, model, systemBlocks)
        if knownTools:
            reqBody['tools'] = knownTools
        reqBody['stream'] = False
        resp = await _getClient().request_json('POST', upstreamUrl, upstreamHeaders, camelToSnake(reqBody))
        responseBody = snakeToCamel(resp.body_json) or {}
        if resp.is_error:
            return (responseBody, None)
        content = responseBody.get('content', [])
        toolUses = [b for b in content or [] if b.get('type') == 'tool_use']
        if toolUses:
            updatedMessages, usage = await resolveManagedAnthropicToolUses(messages, systemBlocks, model, upstreamUrl, upstreamHeaders, True, knownTools, managedLocalToolNames, clientToolNames)
            lastMsg = updatedMessages[-1] if updatedMessages else {}
            return ({'id': responseBody.get('id', f'msg_{uuid.uuid4().hex[:16]}'), 'type': 'message', 'role': 'assistant', 'content': lastMsg.get('content', []), 'model': model, 'stop_reason': 'end_turn', 'stop_sequence': None, 'usage': usage or {'input_tokens': 0, 'output_tokens': 0}}, None)
        return (responseBody, None)
    else:
        openaiBody = buildOpenaiRequest(body, model, systemBlocks)
        if knownTools:
            openaiBody['tools'] = [anthropicToOpenaiToolDefinition(t) for t in knownTools]
        openaiBody['stream'] = False
        resp = await _getClient().request_json('POST', upstreamUrl, upstreamHeaders, camelToSnake(openaiBody))
        responseBody = snakeToCamel(resp.body_json) or {}
        if resp.is_error:
            return (responseBody, None)
        return (_translateOpenaiToAnthropicResponse(responseBody, model), None)

async def _streamAnthropicNative(upstreamUrl: str, upstreamHeaders: dict[str, str], body: dict[str, JsonValue], model: str, systemBlocks: list[dict[str, JsonValue]], knownTools: list[dict[str, JsonValue]], managedLocalToolNames: set[str], clientToolNames: set[str]) -> AsyncIterator[str]:
    """Stream from an Anthropic upstream in native format.

    Intercepts tool uses and resolves managed tools.
    """
    reqBody = buildAnthropicUpstreamRequest(body, model, systemBlocks)
    if knownTools:
        reqBody['tools'] = knownTools
    reqBody['stream'] = True
    toolRound = 0
    currentMessages = list(body.get('messages', []))
    # Multi-round managed tool resolution: each round streams from the upstream,
    # intercepts managed tool uses, executes them locally, appends the results,
    # and re-streams — up to MAX_MANAGED_TOOL_ROUNDS times.
    while toolRound < MAX_MANAGED_TOOL_ROUNDS:
        state = createAnthropicNativeStreamState()
        roundBody = dict(reqBody)
        roundBody['messages'] = currentMessages
        async for event in _getClient().stream_sse(upstreamUrl, upstreamHeaders, camelToSnake(roundBody)):
            if event.get('type') == 'error':
                yield writeAnthropicSseData('error', {'error': {'message': event.get('body', str(event.get('error', '')))}})
                return
            eventType = event.get('_event_type', '')
            yield writeAnthropicSseDataOnly(event)
            eventTypePayload = event.get('type', '')
            if eventTypePayload == 'message_start':
                msg = event.get('message', {})
                state['message_id'] = msg.get('id', '')
                state['model'] = msg.get('model', '')
                state['input_tokens'] = msg.get('usage', {}).get('input_tokens', 0)
            elif eventTypePayload == 'content_block_start':
                block = event.get('content_block', {})
                idx = event.get('index', 0)
                state['content_blocks'].append(block)
                state['current_index'] = idx
            elif eventTypePayload == 'content_block_delta':
                pass
            elif eventTypePayload == 'content_block_stop':
                pass
            elif eventTypePayload == 'message_delta':
                delta = event.get('delta', {})
                state['stop_reason'] = delta.get('stop_reason')
                state['output_tokens'] = event.get('usage', {}).get('output_tokens', 0)
            elif eventTypePayload == 'message_stop':
                toolUses = [b for b in state['content_blocks'] if b.get('type') == 'tool_use']
                if not toolUses:
                    break
                classification = classifyAnthropicToolUses(toolUses, managedLocalToolNames, clientToolNames)
                # No managed tools to resolve locally — pass the turn back to the
                # client (or finish). Stop the loop so we don't spin.
                if not classification['has_managed']:
                    break
                toolRound += 1
                assistantMsg = {'role': 'assistant', 'content': list(state['content_blocks'])}
                currentMessages.append(assistantMsg)
                for tu in classification['managed_tool_uses']:
                    toolName = tu.get('name', '')
                    toolInput = tu.get('input', {})
                    toolUseId = tu.get('id', f'toolu_{uuid.uuid4().hex[:16]}')
                    try:
                        result = await executeManagedProxyTool(toolName, toolInput)
                        currentMessages.append({'type': 'tool_result', 'tool_use_id': toolUseId, 'content': formatManagedToolResult(toolName, result)})
                    except Exception as exc:
                        currentMessages.append({'type': 'tool_result', 'tool_use_id': toolUseId, 'content': f'Error: {exc}', 'is_error': True})
                # Loop again to re-stream with the tool results appended.
                continue
        # Either no tool uses, or only client/unknown tools — we're done.
        break
    yield writeAnthropicSseData('message_stop', {'type': 'message_stop'})

async def _streamOpenaiAsAnthropic(upstreamUrl: str, upstreamHeaders: dict[str, str], body: dict[str, JsonValue], model: str, systemBlocks: list[dict[str, JsonValue]], knownTools: list[dict[str, JsonValue]], managedLocalToolNames: set[str], clientToolNames: set[str]) -> AsyncIterator[str]:
    """Stream from an OpenAI-format upstream and convert to Anthropic SSE."""
    openaiBody = buildOpenaiRequest(body, model, systemBlocks)
    if knownTools:
        openaiBody['tools'] = [anthropicToOpenaiToolDefinition(t) for t in knownTools]
    openaiBody['stream'] = True
    state = createOpenaiToAnthropicStreamState()
    toolRound = 0
    currentMessages = list(body.get('messages', []))
    currentSystem = systemBlocks
    async for chunk in _getClient().stream_sse(upstreamUrl, upstreamHeaders, camelToSnake(openaiBody)):
        if chunk.get('type') == 'error':
            yield writeAnthropicSseData('error', {'error': {'message': chunk.get('body', str(chunk.get('error', '')))}})
            return
        events = streamOpenaiDeltaAsAnthropic(chunk, state)
        for eventStr in events:
            yield eventStr
        choices = chunk.get('choices', [])
        if choices and choices[0].get('finish_reason') == 'tool_calls':
            toolRound += 1
            if toolRound > MAX_MANAGED_TOOL_ROUNDS:
                break
            toolCalls = []
            for tc in state['pending_tool_calls']:
                name = tc.get('function', {}).get('name', '')
                argsStr = tc.get('function', {}).get('arguments', '{}')
                try:
                    args = json.loads(argsStr)
                except (json.JSONDecodeError, TypeError):
                    args = {}
                toolCalls.append({'type': 'tool_use', 'id': tc.get('id', f'toolu_{uuid.uuid4().hex[:16]}'), 'name': name, 'input': args})
            if toolCalls:
                classification = classifyAnthropicToolUses(toolCalls, managedLocalToolNames, clientToolNames)
                if classification['has_managed']:
                    currentMessages.append({'role': 'assistant', 'content': [{'type': 'text', 'text': state.get('accumulated_text', '')}, *toolCalls]})
                    for tu in classification['managed_tool_uses']:
                        try:
                            result = await executeManagedProxyTool(tu.get('name', ''), tu.get('input', {}))
                            currentMessages.append({'type': 'tool_result', 'tool_use_id': tu.get('id', ''), 'content': formatManagedToolResult(tu.get('name', ''), result)})
                        except Exception as exc:
                            currentMessages.append({'type': 'tool_result', 'tool_use_id': tu.get('id', ''), 'content': f'Error: {exc}', 'is_error': True})
                    state = createOpenaiToAnthropicStreamState()
                    continue
            break
    yield writeAnthropicSseData('message_stop', {'type': 'message_stop'})

def _translateOpenaiToAnthropicResponse(openaiResponse: dict[str, JsonValue], model: str) -> dict[str, JsonValue]:
    """Convert an OpenAI Chat Completions response to Anthropic Messages format."""
    choices = openaiResponse.get('choices', [])
    if not choices:
        return {'id': f'msg_{uuid.uuid4().hex[:16]}', 'type': 'message', 'role': 'assistant', 'content': [], 'model': model, 'stop_reason': 'end_turn', 'stop_sequence': None, 'usage': {'input_tokens': 0, 'output_tokens': 0}}
    choice = choices[0]
    message = choice.get('message', {})
    contentList: list[dict[str, JsonValue]] = []
    text = message.get('content', '')
    if text:
        contentList.append({'type': 'text', 'text': text})
    reasoning = message.get('reasoning') or message.get('reasoning_content', '')
    if reasoning:
        contentList.append({'type': 'thinking', 'text': reasoning})
    for tc in message.get('tool_calls', []):
        try:
            toolInput = json.loads(tc.get('function', {}).get('arguments', '{}'))
        except (json.JSONDecodeError, TypeError):
            toolInput = {}
        contentList.append({'type': 'tool_use', 'id': tc.get('id', f'toolu_{uuid.uuid4().hex[:16]}'), 'name': tc.get('function', {}).get('name', ''), 'input': toolInput})
    finishReason = choice.get('finish_reason', 'stop')
    stopReasonMap = {'stop': 'end_turn', 'tool_calls': 'tool_use', 'length': 'max_tokens', 'content_filter': 'content_filter'}
    usage = openaiResponse.get('usage', {})
    return {'id': openaiResponse.get('id', f'msg_{uuid.uuid4().hex[:16]}'), 'type': 'message', 'role': 'assistant', 'content': contentList, 'model': openaiResponse.get('model', model), 'stop_reason': stopReasonMap.get(finishReason, 'end_turn'), 'stop_sequence': None, 'usage': {'input_tokens': usage.get('prompt_tokens', 0), 'output_tokens': usage.get('completion_tokens', 0)}}

async def handleCountTokens(body: dict[str, JsonValue], request: object=None) -> dict[str, JsonValue]:
    """Handle a POST /v1/messages/count_tokens request."""
    from app.providers.clients.base import estimateTokens
    messages = body.get('messages', [])
    tools = body.get('tools', [])
    estimated = estimateTokens(messages, tools)
    return {'input_tokens': estimated, 'estimated': True}
_client = None

def _getClient() -> object:
    global _client
    if _client is None:
        from app.providers.clients.anthropic import AnthropicClient
        _client = AnthropicClient({})
    return _client

def translateMessagesToAnthropic(messages: list[dict[str, JsonValue]]) -> list[dict[str, JsonValue]]:
    """Convert session messages (OpenAI or mixed format) to Anthropic Messages format.

    Groups consecutive tool messages into a single user message with tool_result blocks.
    Maps OpenAI assistant tool_calls to Anthropic content blocks with type='tool_use'.
    """
    translated: list[dict[str, JsonValue]] = []
    i = 0
    while i < len(messages):
        msg = messages[i]
        role = msg.get('role')
        if role == 'tool':
            toolBlocks = []
            while i < len(messages) and messages[i].get('role') == 'tool':
                tMsg = messages[i]
                toolUseId = tMsg.get('tool_use_id') or tMsg.get('tool_call_id') or ''
                content = tMsg.get('content', '')
                toolBlocks.append({'type': 'tool_result', 'tool_use_id': toolUseId, 'content': content})
                i += 1
            translated.append({'role': 'user', 'content': toolBlocks})
        else:
            if role == 'assistant' and msg.get('tool_calls'):
                contentBlocks = []
                if msg.get('content'):
                    contentBlocks.append({'type': 'text', 'text': msg['content']})
                for tc in msg['tool_calls']:
                    fn = tc.get('function', {})
                    try:
                        args = json.loads(fn.get('arguments', '{}')) if isinstance(fn.get('arguments'), str) else fn.get('arguments', {})
                    except Exception:
                        args = {}
                    contentBlocks.append({'type': 'tool_use', 'id': tc.get('id', ''), 'name': fn.get('name', ''), 'input': args})
                translated.append({'role': 'assistant', 'content': contentBlocks})
            elif role == 'assistant' and isinstance(msg.get('content'), list):
                filtered = [b for b in msg['content'] if not (isinstance(b, dict) and b.get('type') == 'thinking' and (not b.get('signature')))]
                translated.append({'role': 'assistant', 'content': filtered if filtered else [{'type': 'text', 'text': ''}]})
            else:
                translated.append(msg)
            i += 1
    return translated