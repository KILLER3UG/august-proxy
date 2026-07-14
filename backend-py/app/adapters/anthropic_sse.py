"""Anthropic Messages SSE wire formatting helpers.

Extracted from ``anthropic`` so the adapter stays focused on request/response
translation and tool loops while SSE framing lives in one small module.
"""

from __future__ import annotations

import json
import uuid

from app.adapters.sse_format import write_sse_data_only, write_sse_event
from app.json_narrowing import as_dict, as_int, as_list, as_str


def write_anthropic_sse_data(event: str, data: dict[str, object]) -> str:
    """Serialize an Anthropic SSE event."""
    return write_sse_event(event, data)


def write_anthropic_sse_data_only(data: dict[str, object]) -> str:
    """Serialize data with just the data: line (event omitted)."""
    return write_sse_data_only(data)


def send_simulated_anthropic_stream(response: dict[str, object]) -> list[str]:
    """Create Anthropic SSE events from a full JSON response.

    Used when the proxy forced non-streaming upstream to do tool resolution,
    then needs to simulate a stream back to the client.
    """
    events: list[str] = []
    response_id = as_str(response.get('id'), f'msg_{uuid.uuid4().hex[:16]}')
    model = as_str(response.get('model'), 'unknown')
    role = as_str(response.get('role'), 'assistant')
    content = as_list(response.get('content'), [])
    usage = as_dict(response.get('usage'), {})
    events.append(
        write_anthropic_sse_data(
            'message_start',
            {
                'type': 'message_start',
                'message': {
                    'id': response_id,
                    'type': 'message',
                    'role': role,
                    'content': [],
                    'model': model,
                    'stop_reason': None,
                    'stop_sequence': None,
                    'usage': {
                        'input_tokens': as_int(usage.get('input_tokens'), 0),
                        'output_tokens': 0,
                    },
                },
            },
        )
    )
    for i, block in enumerate(content):
        if not isinstance(block, dict):
            continue
        events.append(
            write_anthropic_sse_data(
                'content_block_start',
                {'type': 'content_block_start', 'index': i, 'content_block': block},
            )
        )
        block_type = as_str(block.get('type'), '')
        if block_type == 'text':
            events.append(
                write_anthropic_sse_data(
                    'content_block_delta',
                    {
                        'type': 'content_block_delta',
                        'index': i,
                        'delta': {
                            'type': 'text_delta',
                            'text': as_str(block.get('text'), ''),
                        },
                    },
                )
            )
        elif block_type == 'tool_use':
            events.append(
                write_anthropic_sse_data(
                    'content_block_delta',
                    {
                        'type': 'content_block_delta',
                        'index': i,
                        'delta': {
                            'type': 'input_json_delta',
                            'partial_json': json.dumps(as_dict(block.get('input'), {})),
                        },
                    },
                )
            )
        events.append(
            write_anthropic_sse_data(
                'content_block_stop', {'type': 'content_block_stop', 'index': i}
            )
        )
    stop_reason = as_str(response.get('stop_reason'), '') or 'end_turn'
    if (
        content
        and isinstance(content[-1], dict)
        and as_str(content[-1].get('type'), '') == 'tool_use'
    ):
        stop_reason = 'tool_use'
    events.append(
        write_anthropic_sse_data(
            'message_delta',
            {
                'type': 'message_delta',
                'delta': {'stop_reason': stop_reason, 'stop_sequence': None},
                'usage': {'output_tokens': as_int(usage.get('output_tokens'), 0)},
            },
        )
    )
    events.append(write_anthropic_sse_data('message_stop', {'type': 'message_stop'}))
    return events
