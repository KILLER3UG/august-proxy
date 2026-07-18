"""
Stream state dataclasses for proxy adapter accumulators.

Replaces ad-hoc dict-based stream states with typed @dataclass classes
that encapsulate accumulation logic in methods rather than scattered
functions operating on raw dicts.

SSE line formatting lives in :mod:`app.adapters.sse_format` (Phase 3 extract).
"""

from __future__ import annotations
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.adapters.sse_format import write_sse_data_only, write_sse_event

# Back-compat aliases (previous camelCase names on this module).
writeSseEvent = write_sse_event
writeSseDataOnly = write_sse_data_only


# ── Tool call accumulation ──────────────────────────────────────────────


@dataclass
class ToolCallDelta:
    """A single tool call accumulated from streaming deltas by index.

    Merges streaming deltas that arrive in chunks by matching on ``index``.
    Can be rendered to either OpenAI-format (``to_openai_dict``) or
    Anthropic-format (``to_anthropic_tool_use``).
    """

    index: int = 0
    id: str = ''
    type: str = 'function'
    function_name: str = ''
    function_arguments: str = ''

    def apply_delta(self, delta: dict[str, Any]) -> None:
        """Merge a streaming delta into this accumulator."""
        if delta.get('id'):
            self.id = delta['id']
        fn = delta.get('function', {})
        if isinstance(fn, dict):
            if fn.get('name'):
                self.function_name += fn['name']
            if fn.get('arguments'):
                self.function_arguments += fn['arguments']

    def to_openai_dict(self) -> dict[str, Any]:
        """Build an OpenAI-format tool call dict."""
        return {
            'id': self.id or f'call_{uuid.uuid4().hex[:8]}',
            'type': self.type,
            'function': {
                'name': self.function_name,
                'arguments': self.function_arguments,
            },
        }

    def to_anthropic_tool_use(self) -> dict[str, Any]:
        """Build an Anthropic-format tool_use content block."""
        try:
            tool_input = json.loads(self.function_arguments) if self.function_arguments else {}
        except (json.JSONDecodeError, TypeError):
            tool_input = {}
        return {
            'type': 'tool_use',
            'id': self.id or f'toolu_{uuid.uuid4().hex[:16]}',
            'name': self.function_name,
            'input': tool_input,
        }


# ── OpenAI stream accumulator ────────────────────────────────────────────


@dataclass
class OpenaiStreamAccumulator:
    """Accumulate OpenAI Chat Completions streaming chunks.

    Replaces the three disjoint functions:
    - ``createOpenaiStreamAccumulator``
    - ``accumulateOpenaiChunk``
    - ``buildOpenaiAggregatedFromStream``
    """

    id: str = ''
    model: str = ''
    created: int = 0
    content: str = ''
    reasoning: str = ''
    tool_calls: list[ToolCallDelta] = field(default_factory=list)
    finish_reason: str | None = None
    usage: dict[str, Any] | None = None

    def accumulate(self, chunk: dict[str, Any]) -> None:
        """Merge a streaming chunk into this accumulator.

        This is a faithful port of ``accumulateOpenaiChunk``.
        """
        if chunk.get('id'):
            self.id = chunk['id']
        if chunk.get('model'):
            self.model = chunk['model']
        if chunk.get('created'):
            self.created = chunk['created']
        if chunk.get('usage'):
            self.usage = chunk['usage']
        for choice in chunk.get('choices', []):
            if not isinstance(choice, dict):
                continue
            delta = choice.get('delta', {})
            if not isinstance(delta, dict):
                delta = {}
            if choice.get('finish_reason'):
                self.finish_reason = choice['finish_reason']
            content = delta.get('content', '')
            if content and isinstance(content, str):
                self.content += content
            reasoning = delta.get('reasoning') or delta.get('reasoning_content', '')
            if reasoning and isinstance(reasoning, str):
                self.reasoning += reasoning
            tool_calls = delta.get('tool_calls', [])
            if isinstance(tool_calls, list):
                for tc in tool_calls:
                    if not isinstance(tc, dict):
                        continue
                    existing = next(
                        (t for t in self.tool_calls if t.index == tc.get('index')),
                        None,
                    )
                    if existing:
                        existing.apply_delta(tc)
                    else:
                        new_tc = ToolCallDelta(index=tc.get('index', 0))
                        new_tc.apply_delta(tc)
                        self.tool_calls.append(new_tc)

    def build_response(self) -> dict[str, Any]:
        """Build a complete OpenAI-style response dict from accumulated state.

        This is a faithful port of ``buildOpenaiAggregatedFromStream``.
        """
        message: dict[str, Any] = {'role': 'assistant', 'content': self.content}
        if self.reasoning:
            # Both keys: DeepSeek/Kimi expect reasoning_content; some stacks use reasoning.
            message['reasoning'] = self.reasoning
            message['reasoning_content'] = self.reasoning
        if self.tool_calls:
            message['tool_calls'] = [tc.to_openai_dict() for tc in self.tool_calls]
        return {
            'id': self.id or f'chatcmpl-{uuid.uuid4().hex[:12]}',
            'object': 'chat.completion',
            'created': self.created or int(time.time()),
            'model': self.model or 'unknown',
            'choices': [
                {
                    'index': 0,
                    'message': message,
                    'finish_reason': self.finish_reason or 'stop',
                }
            ],
            'usage': self.usage
            or {
                'prompt_tokens': 0,
                'completion_tokens': 0,
                'total_tokens': 0,
            },
        }


# ── Anthropic shared stream data ────────────────────────────────────────


@dataclass
class AnthropicStreamData:
    """Shared state fields for Anthropic SSE stream tracking.

    Used by both ``AnthropicNativeStreamState`` and
    ``OpenaiToAnthropicStreamState`` via **composition** (not inheritance),
    since the two classes process different input formats (Anthropic SSE
    events vs. OpenAI chunks) but share the same output state shape.
    """

    message_id: str = ''
    model: str = ''
    role: str = 'assistant'
    content_blocks: list[dict[str, Any]] = field(default_factory=list)
    current_index: int = -1
    stop_reason: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0


# ── Anthropic native stream state ────────────────────────────────────────


@dataclass
class AnthropicNativeStreamState:
    """Tracks state from a native Anthropic SSE stream.

    Handles all Anthropic SSE event types:
    ``message_start``, ``content_block_start``, ``content_block_delta``,
    ``content_block_stop``, ``message_delta``, ``message_stop``, ``ping``.

    Replaces ``createAnthropicNativeStreamState`` and the inline
    event-processing code in ``_streamAnthropicNative``.
    """

    data: AnthropicStreamData = field(default_factory=AnthropicStreamData)

    def process_message_start(self, event: dict[str, Any]) -> None:
        """Extract id, model, and input_tokens from message_start."""
        msg = event.get('message')
        if isinstance(msg, dict):
            self.data.message_id = msg.get('id', '')
            self.data.model = msg.get('model', '')
            usage = msg.get('usage', {})
            if isinstance(usage, dict):
                self.data.input_tokens = usage.get('input_tokens', 0)

    def process_content_block_start(self, event: dict[str, Any]) -> None:
        """Append the content block and update current_index."""
        block = event.get('content_block')
        if isinstance(block, dict):
            self.data.content_blocks.append(block)
        self.data.current_index = event.get('index', -1)

    def process_content_block_delta(self, event: dict[str, Any]) -> None:
        """No state update needed; delta is forwarded as-is."""
        pass

    def process_content_block_stop(self, event: dict[str, Any]) -> None:
        """No state update needed; forwarded as-is."""
        pass

    def process_message_delta(self, event: dict[str, Any]) -> None:
        """Extract stop_reason and output_tokens."""
        delta = event.get('delta')
        if isinstance(delta, dict):
            self.data.stop_reason = delta.get('stop_reason')
        usage = event.get('usage')
        if isinstance(usage, dict):
            self.data.output_tokens = usage.get('output_tokens', 0)

    def process_message_stop(self, event: dict[str, Any]) -> None:
        """No state update needed; tool uses are read after this event."""
        pass

    def process_ping(self, event: dict[str, Any]) -> None:
        """No state update needed; ping events are ignored."""
        pass

    def get_tool_uses(self) -> list[dict[str, Any]]:
        """Return all content blocks with type='tool_use'."""
        return [b for b in self.data.content_blocks if isinstance(b, dict) and b.get('type') == 'tool_use']


# ── OpenAI-to-Anthropic stream converter state ───────────────────────────


def _make_conversion_data() -> AnthropicStreamData:
    """Factory for the default data in OpenaiToAnthropicStreamState."""
    return AnthropicStreamData(
        message_id=f'msg_{uuid.uuid4().hex[:16]}',
        current_index=0,
    )


@dataclass
class OpenaiToAnthropicStreamState:
    """Converts OpenAI streaming chunks to Anthropic SSE events.

    Owns an ``AnthropicStreamData`` for the shared state fields and adds
    fields specific to cross-format conversion (accumulated text, reasoning,
    and pending tool call deltas).

    Replaces ``createOpenaiToAnthropicStreamState`` and
    ``streamOpenaiDeltaAsAnthropic``.
    """

    data: AnthropicStreamData = field(default_factory=_make_conversion_data)
    accumulated_text: str = ''
    accumulated_reasoning: str = ''
    pending_tool_calls: list[ToolCallDelta] = field(default_factory=list)
    _started: bool = False
    _text_block_started: bool = False
    _reasoning_block_started: bool = False

    def convert_chunk(self, chunk: dict[str, Any]) -> list[str]:
        """Convert one OpenAI chunk to Anthropic SSE event strings.

        This is a faithful port of ``streamOpenaiDeltaAsAnthropic``.
        """
        events: list[str] = []
        choices = chunk.get('choices', [])
        if not choices:
            return events
        choice = choices[0] if isinstance(choices, list) and choices else {}
        if not isinstance(choice, dict):
            return events
        delta = choice.get('delta', {})
        if not isinstance(delta, dict):
            delta = {}
        finish_reason = choice.get('finish_reason')

        chunk_id = chunk.get('id')
        if chunk_id and not self._started:
            self.data.message_id = chunk_id
        chunk_model = chunk.get('model')
        if chunk_model:
            self.data.model = chunk_model

        if not self._started:
            self._started = True
            events.append(
                write_sse_event(
                    'message_start',
                    {
                        'type': 'message_start',
                        'message': {
                            'id': self.data.message_id,
                            'type': 'message',
                            'role': 'assistant',
                            'content': [],
                            'model': self.data.model or 'unknown',
                            'stop_reason': None,
                            'stop_sequence': None,
                            'usage': {'input_tokens': 0, 'output_tokens': 0},
                        },
                    },
                )
            )

        # Text content → Anthropic text_delta
        content = delta.get('content', '')
        if content and isinstance(content, str):
            if not self._text_block_started:
                self._text_block_started = True
                self.data.current_index += 1
                idx = self.data.current_index
                events.append(
                    write_sse_event(
                        'content_block_start',
                        {
                            'type': 'content_block_start',
                            'index': idx,
                            'content_block': {'type': 'text', 'text': ''},
                        },
                    )
                )
            events.append(
                write_sse_event(
                    'content_block_delta',
                    {
                        'type': 'content_block_delta',
                        'index': self.data.current_index,
                        'delta': {'type': 'text_delta', 'text': content},
                    },
                )
            )
            self.accumulated_text += content

        # Reasoning content → Anthropic thinking_delta
        reasoning = delta.get('reasoning') or delta.get('reasoning_content', '')
        if reasoning and isinstance(reasoning, str):
            if not self._reasoning_block_started:
                self._reasoning_block_started = True
                self.data.current_index += 1
                idx = self.data.current_index
                events.append(
                    write_sse_event(
                        'content_block_start',
                        {
                            'type': 'content_block_start',
                            'index': idx,
                            'content_block': {'type': 'thinking', 'text': ''},
                        },
                    )
                )
            events.append(
                write_sse_event(
                    'content_block_delta',
                    {
                        'type': 'content_block_delta',
                        'index': self.data.current_index,
                        'delta': {'type': 'thinking_delta', 'thinking': reasoning},
                    },
                )
            )
            self.accumulated_reasoning += reasoning

        # Tool call deltas → pending (emitted as tool_use blocks on finish)
        tc_list = delta.get('tool_calls')
        if isinstance(tc_list, list):
            for tc in tc_list:
                if not isinstance(tc, dict):
                    continue
                existing = next(
                    (t for t in self.pending_tool_calls if t.index == tc.get('index')),
                    None,
                )
                if existing:
                    existing.apply_delta(tc)
                else:
                    new_tc = ToolCallDelta(index=tc.get('index', 0))
                    new_tc.apply_delta(tc)
                    self.pending_tool_calls.append(new_tc)

        # On finish_reason, flush pending blocks and emit message_delta
        if finish_reason and finish_reason != 'null':
            self._emit_content_block_stops(events)
            self._emit_tool_use_blocks(events)
            anthropic_stop = self._map_finish_reason(finish_reason)
            events.append(
                write_sse_event(
                    'message_delta',
                    {
                        'type': 'message_delta',
                        'delta': {'stop_reason': anthropic_stop, 'stop_sequence': None},
                        'usage': {
                            'input_tokens': self.data.input_tokens,
                            'output_tokens': self.data.output_tokens,
                        },
                    },
                )
            )
            events.append(write_sse_event('message_stop', {'type': 'message_stop'}))

        # Capture upstream usage stats
        chunk_usage = chunk.get('usage')
        if isinstance(chunk_usage, dict):
            self.data.input_tokens = chunk_usage.get('prompt_tokens', 0)
            self.data.output_tokens = chunk_usage.get('completion_tokens', 0)

        return events

    # ── Internal helpers ─────────────────────────────────────────────────

    def _emit_content_block_stops(self, events: list[str]) -> None:
        """Close any open text/thinking content blocks."""
        idx = self.data.current_index
        if self._text_block_started:
            events.append(
                write_sse_event(
                    'content_block_stop',
                    {
                        'type': 'content_block_stop',
                        'index': idx,
                    },
                )
            )
        if self._reasoning_block_started:
            events.append(
                write_sse_event(
                    'content_block_stop',
                    {
                        'type': 'content_block_stop',
                        'index': idx,
                    },
                )
            )

    def _emit_tool_use_blocks(self, events: list[str]) -> None:
        """Emit tool_use content blocks for all pending tool calls."""
        for tc in self.pending_tool_calls:
            self.data.current_index += 1
            idx = self.data.current_index
            tu = tc.to_anthropic_tool_use()
            events.append(
                write_sse_event(
                    'content_block_start',
                    {
                        'type': 'content_block_start',
                        'index': idx,
                        'content_block': tu,
                    },
                )
            )
            events.append(
                write_sse_event(
                    'content_block_delta',
                    {
                        'type': 'content_block_delta',
                        'index': idx,
                        'delta': {'type': 'input_json_delta', 'partial_json': tc.function_arguments},
                    },
                )
            )
            events.append(
                write_sse_event(
                    'content_block_stop',
                    {
                        'type': 'content_block_stop',
                        'index': idx,
                    },
                )
            )
            self.data.content_blocks.append(tu)

    @staticmethod
    def _map_finish_reason(finish_reason: str) -> str:
        """Map OpenAI finish_reason to Anthropic stop_reason."""
        mapping = {
            'tool_calls': 'tool_use',
            'length': 'max_tokens',
            'stop': 'end_turn',
        }
        return mapping.get(finish_reason, 'end_turn')

    def build_openai_response(self) -> dict[str, Any]:
        """Build an OpenAI chat completion response from accumulated state.

        Used when the proxy forced non-streaming upstream to do tool
        resolution and needs to produce a final response.
        """
        return {
            'id': self.data.message_id or f'chatcmpl-{uuid.uuid4().hex[:12]}',
            'object': 'chat.completion',
            'created': int(time.time()),
            'model': self.data.model or 'unknown',
            'choices': [
                {
                    'index': 0,
                    'message': {'role': 'assistant', 'content': self.accumulated_text},
                    'finish_reason': self.data.stop_reason or 'stop',
                }
            ],
            'usage': {
                'prompt_tokens': self.data.input_tokens,
                'completion_tokens': self.data.output_tokens,
                'total_tokens': self.data.input_tokens + self.data.output_tokens,
            },
        }
