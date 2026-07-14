"""OpenAI Chat Completions SSE wire formatting helpers.

Extracted from ``openai`` so the adapter stays focused on request/response
translation and tool loops while SSE framing lives in one small module.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import cast

from app.json_narrowing import as_dict, as_int, as_list, as_str


def write_openai_sse_headers() -> dict[str, str]:
    """Return SSE response headers for OpenAI-compatible streaming."""
    return {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    }


def write_openai_sse_data(chunk: dict[str, object]) -> str:
    """Serialize a chunk as SSE data line."""
    return f'data: {json.dumps(chunk)}\n\n'


def write_openai_sse_error(error: str) -> str:
    """Serialize an error as SSE."""
    return write_openai_sse_data({'error': {'message': error}})


def write_openai_sse_done() -> str:
    """Return the terminal SSE event."""
    return 'data: [DONE]\n\n'


def send_simulated_openai_stream(response: dict[str, object]) -> list[str]:
    """Create SSE events from a full JSON response, simulating a stream."""
    events: list[str] = []
    response_id = as_str(response.get('id'), f'chatcmpl-{uuid.uuid4().hex[:12]}')
    created = as_int(response.get('created'), int(time.time()))
    model = as_str(response.get('model'), 'unknown')
    choices = as_list(response.get('choices'), [])
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        choice_dict = cast('dict[str, object]', choice)
        index = as_int(choice_dict.get('index'), 0)
        delta = as_dict(choice_dict.get('delta'), {}) or as_dict(choice_dict.get('message'), {})
        events.append(
            write_openai_sse_data(
                {
                    'id': response_id,
                    'object': 'chat.completion.chunk',
                    'created': created,
                    'model': model,
                    'choices': [{'index': index, 'delta': delta, 'finish_reason': None}],
                }
            )
        )
        events.append(
            write_openai_sse_data(
                {
                    'id': response_id,
                    'object': 'chat.completion.chunk',
                    'created': created,
                    'model': model,
                    'choices': [
                        {
                            'index': index,
                            'delta': {},
                            'finish_reason': cast('dict[str, object]', choice_dict).get(
                                'finish_reason', 'stop'
                            ),
                        }
                    ],
                }
            )
        )
    if response.get('usage'):
        events.append(
            write_openai_sse_data(
                {
                    'id': response_id,
                    'object': 'chat.completion.chunk',
                    'created': created,
                    'model': model,
                    'choices': [],
                    'usage': response['usage'],
                }
            )
        )
    events.append(write_openai_sse_done())
    return events
