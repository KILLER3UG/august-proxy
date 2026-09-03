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
        # Upstream failure metadata so the turn loop can retry rate limits.
        self.error_status: int | None = None
        self.error_retry_after_ms: int | None = None
        self.stop_reason: str | None = None

    def _absorb_usage(self, msg_usage: dict[str, object]) -> None:
        """Merge a provider usage payload into the aggregate.

        Anthropic splits its cumulative usage across two events: ``message_start``
        carries input + the prompt-cache split, ``message_delta`` carries output
        (and may omit input entirely). Merge field-by-field instead of
        overwriting the whole dict so neither event clobbers the other.
        """
        for key in ('input_tokens', 'output_tokens'):
            if msg_usage.get(key) is not None:
                self.usage[key] = as_int(msg_usage.get(key), 0)
        # Preserve Anthropic prompt-cache fields — the context ring
        # reads cache_read/cache_creation for the hit-rate split.
        if msg_usage.get('cache_read_input_tokens') is not None:
            self.usage['cache_read_input_tokens'] = as_int(
                msg_usage.get('cache_read_input_tokens'), 0
            )
        if msg_usage.get('cache_creation_input_tokens') is not None:
            self.usage['cache_creation_input_tokens'] = as_int(
                msg_usage.get('cache_creation_input_tokens'), 0
            )

    def on_event(self, event: dict[str, object]) -> None:
        event_type = event.get('_event_type', '')
        # HTTP/stream failures from BaseProvider.streamSse use type='error'
        # without _event_type — treat them as hard failures (not empty success).
        if event.get('type') == 'error' or (not event_type and event.get('error')):
            status = event.get('status')
            body = as_str(event.get('body') or event.get('error') or event.get('message'))
            if isinstance(status, int):
                self.error_status = status
            retryAfter = event.get('retryAfterMs')
            if isinstance(retryAfter, int) and retryAfter > 0:
                self.error_retry_after_ms = retryAfter
            if status:
                self.error = f'Stream error HTTP {status}: {body[:800]}'
            else:
                self.error = f'Stream error: {body[:800] or event}'
            return
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
                        parsed = json.loads(raw)
                        if isinstance(parsed, dict):
                            self.current_tool_block['input'] = parsed
                        else:
                            # Valid JSON that is NOT an object ([]/42/"text")
                            # must never execute as {} — the OpenAI path rejects
                            # these and this path must too (audit finding:
                            # non-object args were flattened to {} and tools
                            # ran with empty arguments).
                            self.current_tool_block['input'] = {'_raw': raw}
                    except json.JSONDecodeError:
                        from app.services.workbench.json_salvage import salvage_json_object

                        saved = salvage_json_object(raw)
                        self.current_tool_block['input'] = (
                            saved if saved is not None else {'_raw': raw}
                        )
                self.tool_uses.append(self.current_tool_block)
                self.current_tool_block = None
                self.current_tool_input_parts = []
                # P3.1: this tool block's arguments just finished arriving —
                # the loop diffs this against stream-end (early-dispatch
                # telemetry; measurement only, no behavior change).
                from app.lib.perf_timing import mark_tool_args_ready

                mark_tool_args_ready()
        elif event_type == 'message_start':
            self._absorb_usage(as_dict(as_dict(event.get('message')).get('usage')))
        elif event_type == 'message_delta':
            msg_usage = as_dict(event.get('usage', {}))
            if msg_usage:
                self._absorb_usage(msg_usage)
            delta = as_dict(event.get('delta', {}))
            stop = as_str(delta.get('stop_reason') or event.get('stop_reason'))
            if stop:
                self.stop_reason = stop
        elif event_type == 'error':
            self.error = f'Stream error: {event}'

    def result(self) -> dict[str, Any]:
        if self.error:
            return {'error': self.error}
        # Empty success with no tools is almost always a swallowed upstream failure
        # (e.g. context overflow 400 that arrived as type=error without _event_type).
        if (
            not self.accumulated_text
            and not self.accumulated_thinking
            and not self.tool_uses
        ):
            return {
                'error': (
                    'Provider returned an empty response. '
                    'The context may be full — try Free up chat memory, or start a new chat.'
                )
            }
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
