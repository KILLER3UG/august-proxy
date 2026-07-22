"""Anthropic SSE stream translation helpers (extracted from anthropic adapter)."""

from __future__ import annotations

import json
import time
import uuid

from app.adapters.anthropic_sse import write_anthropic_sse_data
from app.json_narrowing import as_dict, as_int, as_list, as_str


def createAnthropicNativeStreamState() -> dict[str, object]:
    """Create state for tracking an Anthropic native stream.

    Returns a mutable dict used as an accumulator. The keys are:
    message_id, model, role, content_blocks, current_index,
    stop_reason, input_tokens, output_tokens, _started, _text_block_started,
    _reasoning_block_started.
    """
    return {
        'message_id': '',
        'model': '',
        'role': 'assistant',
        'content_blocks': [],
        'current_index': -1,
        'stop_reason': None,
        'input_tokens': 0,
        'output_tokens': 0,
    }


def createOpenaiToAnthropicStreamState() -> dict[str, object]:
    """Create state for converting OpenAI SSE to Anthropic format."""
    return {
        'message_id': f'msg_{uuid.uuid4().hex[:16]}',
        'model': '',
        'role': 'assistant',
        'content_blocks': [],
        'current_index': -1,
        'stop_reason': None,
        'input_tokens': 0,
        'output_tokens': 0,
        'accumulated_text': '',
        'accumulated_reasoning': '',
        'pending_tool_calls': [],
        '_text_block_index': None,
        '_reasoning_block_index': None,
    }


def _close_openai_text_block(state: dict[str, object], events: list[str]) -> None:
    if not state.get('_text_block_started'):
        return
    idx = state.get('_text_block_index')
    if idx is None:
        idx = as_int(state.get('current_index'), -1)
    events.append(
        write_anthropic_sse_data(
            'content_block_stop',
            {'type': 'content_block_stop', 'index': idx},
        )
    )
    state['_text_block_started'] = False
    state['_text_block_index'] = None


def _close_openai_reasoning_block(state: dict[str, object], events: list[str]) -> None:
    if not state.get('_reasoning_block_started'):
        return
    idx = state.get('_reasoning_block_index')
    if idx is None:
        idx = as_int(state.get('current_index'), -1)
    events.append(
        write_anthropic_sse_data(
            'content_block_stop',
            {'type': 'content_block_stop', 'index': idx},
        )
    )
    state['_reasoning_block_started'] = False
    state['_reasoning_block_index'] = None


def streamOpenaiDeltaAsAnthropic(chunk: dict[str, object], state: dict[str, object]) -> list[str]:
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
        events.append(
            write_anthropic_sse_data(
                'message_start',
                {
                    'type': 'message_start',
                    'message': {
                        'id': state['message_id'],
                        'type': 'message',
                        'role': 'assistant',
                        'content': [],
                        'model': as_str(state.get('model'), 'unknown'),
                        'stop_reason': None,
                        'stop_sequence': None,
                        'usage': {'input_tokens': 0, 'output_tokens': 0},
                    },
                },
            )
        )
    content = as_str(delta.get('content'), '')
    reasoning = as_str(delta.get('reasoning'), '') or as_str(delta.get('reasoning_content'), '')
    if content:
        if state.get('_reasoning_block_started'):
            _close_openai_reasoning_block(state, events)
        if not state.get('_text_block_started'):
            state['_text_block_started'] = True
            idx = as_int(state.get('current_index'), -1) + 1
            state['current_index'] = idx
            state['_text_block_index'] = idx
            events.append(
                write_anthropic_sse_data(
                    'content_block_start',
                    {'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'text', 'text': ''}},
                )
            )
        text_idx = as_int(state.get('_text_block_index'), as_int(state.get('current_index'), -1))
        events.append(
            write_anthropic_sse_data(
                'content_block_delta',
                {
                    'type': 'content_block_delta',
                    'index': text_idx,
                    'delta': {'type': 'text_delta', 'text': content},
                },
            )
        )
        state['accumulated_text'] = as_str(state.get('accumulated_text'), '') + content
    if reasoning:
        if state.get('_text_block_started'):
            _close_openai_text_block(state, events)
        if not state.get('_reasoning_block_started'):
            state['_reasoning_block_started'] = True
            idx = as_int(state.get('current_index'), -1) + 1
            state['current_index'] = idx
            state['_reasoning_block_index'] = idx
            events.append(
                write_anthropic_sse_data(
                    'content_block_start',
                    {'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'thinking', 'text': ''}},
                )
            )
        think_idx = as_int(state.get('_reasoning_block_index'), as_int(state.get('current_index'), -1))
        events.append(
            write_anthropic_sse_data(
                'content_block_delta',
                {
                    'type': 'content_block_delta',
                    'index': think_idx,
                    'delta': {'type': 'thinking_delta', 'thinking': reasoning},
                },
            )
        )
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
            pending.append(
                {
                    'index': as_int(tc.get('index'), 0),
                    'id': as_str(tc.get('id'), ''),
                    'type': 'function',
                    'function': {'name': as_str(tcFn.get('name'), ''), 'arguments': as_str(tcFn.get('arguments'), '')},
                }
            )
    state['pending_tool_calls'] = pending
    if finishReason and finishReason != 'null':
        _close_openai_text_block(state, events)
        _close_openai_reasoning_block(state, events)
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
            events.append(
                write_anthropic_sse_data(
                    'content_block_start',
                    {
                        'type': 'content_block_start',
                        'index': idx,
                        'content_block': {
                            'type': 'tool_use',
                            'id': tc.get('id', f'toolu_{uuid.uuid4().hex[:16]}'),
                            'name': toolName,
                            'input': toolInput,
                        },
                    },
                )
            )
            events.append(
                write_anthropic_sse_data(
                    'content_block_delta',
                    {
                        'type': 'content_block_delta',
                        'index': idx,
                        'delta': {'type': 'input_json_delta', 'partial_json': toolArgsStr},
                    },
                )
            )
            events.append(write_anthropic_sse_data('content_block_stop', {'type': 'content_block_stop', 'index': idx}))
            contentBlocks = as_list(state.get('content_blocks'), [])
            contentBlocks.append(
                {'type': 'tool_use', 'id': as_str(tc.get('id'), ''), 'name': toolName, 'input': toolInput}
            )
            state['content_blocks'] = contentBlocks
        anthropicStopReason = 'end_turn'
        if finishReason == 'tool_calls':
            anthropicStopReason = 'tool_use'
        elif finishReason == 'length':
            anthropicStopReason = 'max_tokens'
        events.append(
            write_anthropic_sse_data(
                'message_delta',
                {
                    'type': 'message_delta',
                    'delta': {'stop_reason': anthropicStopReason, 'stop_sequence': None},
                    'usage': {
                        'input_tokens': as_int(state.get('input_tokens'), 0),
                        'output_tokens': as_int(state.get('output_tokens'), 0),
                    },
                },
            )
        )
        events.append(write_anthropic_sse_data('message_stop', {'type': 'message_stop'}))
    usage = as_dict(chunk.get('usage'), {})
    if usage:
        state['input_tokens'] = as_int(usage.get('prompt_tokens'), 0)
        state['output_tokens'] = as_int(usage.get('completion_tokens'), 0)
    return events


def buildOpenaiAggregatedForAnthropicFromStream(state: dict[str, object]) -> dict[str, object]:
    """Build an OpenAI chat completion response from accumulated Anthropic stream state."""
    inputTokens = as_int(state.get('input_tokens'), 0)
    outputTokens = as_int(state.get('output_tokens'), 0)
    return {
        'id': state.get('message_id', f'chatcmpl-{uuid.uuid4().hex[:12]}'),
        'object': 'chat.completion',
        'created': int(time.time()),
        'model': as_str(state.get('model'), 'unknown'),
        'choices': [
            {
                'index': 0,
                'message': {'role': 'assistant', 'content': as_str(state.get('accumulated_text'), '')},
                'finish_reason': as_str(state.get('stop_reason'), 'stop'),
            }
        ],
        'usage': {
            'prompt_tokens': inputTokens,
            'completion_tokens': outputTokens,
            'total_tokens': inputTokens + outputTokens,
        },
    }


