"""Workbench-facing stream event aggregation (Anthropic Messages SSE shape).

Keeps provider streaming quirks out of ``providers.py`` / the chat loop:
consume raw ``_event_type`` events from the Anthropic client and produce
workbench emit payloads (``finalOutput`` / ``thinking``) plus the aggregated
response dict.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any

from app.json_narrowing import as_dict, as_int, as_str

EmitFn = Callable[[dict[str, object]], None]


class AnthropicWorkbenchStreamAggregator:
    """Stateful aggregator for one Anthropic workbench stream turn."""

    def __init__(self, emit: EmitFn | None = None) -> None:
        self.emit = emit
        self.content_blocks: list[dict[str, object]] = []
        self.accumulated_text = ''
        self.accumulated_thinking = ''
        self.thinking_signature: str | None = None
        self.tool_uses: list[dict[str, object]] = []
        self.current_tool_block: dict[str, object] | None = None
        self.current_tool_input_parts: list[str] = []
        self.usage: dict[str, int] = {}
        self.error: str | None = None
        self.stop_reason: str | None = None

    def on_event(self, event: dict[str, object]) -> None:
        event_type = event.get('_event_type', '')
        if event_type == 'content_block_start':
            block = as_dict(event.get('content_block', {}))
            block_type = block.get('type', '')
            if block_type == 'tool_use':
                self.current_tool_block = {
                    'type': 'tool_use',
                    'id': block.get('id', f'toolu_{uuid.uuid4().hex[:16]}'),
                    'name': block.get('name', ''),
                    'input': {},
                }
                self.current_tool_input_parts = []
            elif block_type == 'text':
                text = as_str(block.get('text', ''))
                if text:
                    self.accumulated_text += text
                    if self.emit:
                        self.emit({'type': 'finalOutput', 'content': text})
            elif block_type == 'thinking':
                text = as_str(block.get('thinking', '')) or as_str(block.get('text', ''))
                sig = as_str(block.get('signature'), '')
                if sig:
                    self.thinking_signature = sig
                if text:
                    self.accumulated_thinking += text
                    if self.emit:
                        self.emit({'type': 'thinking', 'content': text})
        elif event_type == 'content_block_delta':
            delta = as_dict(event.get('delta', {}))
            delta_type = delta.get('type', '')
            if delta_type == 'text_delta':
                text = as_str(delta.get('text', ''))
                if text:
                    self.accumulated_text += text
                    if self.emit:
                        self.emit({'type': 'finalOutput', 'content': text})
            elif delta_type == 'thinking_delta':
                text = as_str(delta.get('thinking', ''))
                if text:
                    self.accumulated_thinking += text
                    if self.emit:
                        self.emit({'type': 'thinking', 'content': text})
            elif delta_type == 'signature_delta':
                # Anthropic extended thinking: signature must be re-sent with the
                # thinking block on subsequent turns (tool loops).
                sig = as_str(delta.get('signature'), '')
                if sig:
                    self.thinking_signature = sig
            elif delta_type == 'input_json_delta':
                self.current_tool_input_parts.append(as_str(delta.get('partial_json', '')))
        elif event_type == 'content_block_stop':
            if self.current_tool_block:
                raw = ''.join(self.current_tool_input_parts)
                if raw:
                    try:
                        self.current_tool_block['input'] = json.loads(raw)
                    except json.JSONDecodeError:
                        self.current_tool_block['input'] = {'_raw': raw}
                self.tool_uses.append(self.current_tool_block)
                self.current_tool_block = None
                self.current_tool_input_parts = []
        elif event_type == 'message_delta':
            msg_usage = as_dict(event.get('usage', {}))
            if msg_usage:
                self.usage['input_tokens'] = as_int(msg_usage.get('input_tokens', 0))
                self.usage['output_tokens'] = as_int(msg_usage.get('output_tokens', 0))
            delta = as_dict(event.get('delta', {}))
            stop = as_str(delta.get('stop_reason') or event.get('stop_reason'))
            if stop:
                self.stop_reason = stop
        elif event_type == 'error':
            self.error = f'Stream error: {event}'

    def result(self) -> dict[str, Any]:
        if self.error:
            return {'error': self.error}
        blocks: list[dict[str, object]] = []
        if self.accumulated_thinking:
            thinking_block: dict[str, object] = {
                'type': 'thinking',
                'thinking': self.accumulated_thinking,
                'text': self.accumulated_thinking,
            }
            if self.thinking_signature:
                thinking_block['signature'] = self.thinking_signature
            blocks.append(thinking_block)
        if self.accumulated_text:
            blocks.append({'type': 'text', 'text': self.accumulated_text})
        blocks.extend(self.tool_uses)
        out: dict[str, Any] = {
            'content': blocks,
            'text': self.accumulated_text,
            'thinking': self.accumulated_thinking,
            'tool_uses': self.tool_uses,
            'usage': self.usage,
        }
        if getattr(self, 'stop_reason', None):
            out['stop_reason'] = self.stop_reason
        return out
