"""Characterization tests for adapters.openai_sse helpers."""
from __future__ import annotations

import json

from app.adapters import openai as openai_adapter
from app.adapters.openai_sse import (
    send_simulated_openai_stream,
    write_openai_sse_data,
    write_openai_sse_done,
    write_openai_sse_error,
    write_openai_sse_headers,
)


def test_write_openai_sse_headers():
    headers = write_openai_sse_headers()
    assert headers['Content-Type'] == 'text/event-stream'
    assert headers['Cache-Control'] == 'no-cache'
    assert headers['Connection'] == 'keep-alive'
    assert headers['X-Accel-Buffering'] == 'no'


def test_write_openai_sse_data_format():
    line = write_openai_sse_data({'choices': [{'delta': {'content': 'hi'}}]})
    assert line.startswith('data: ')
    assert line.endswith('\n\n')
    payload = line[len('data: ') :].strip()
    assert json.loads(payload) == {'choices': [{'delta': {'content': 'hi'}}]}


def test_write_openai_sse_error_format():
    line = write_openai_sse_error('boom')
    assert line.startswith('data: ')
    assert line.endswith('\n\n')
    payload = json.loads(line[len('data: ') :].strip())
    assert payload == {'error': {'message': 'boom'}}


def test_write_openai_sse_done_format():
    line = write_openai_sse_done()
    assert line == 'data: [DONE]\n\n'
    assert '[DONE]' in line


def test_send_simulated_openai_stream_wire_format():
    events = send_simulated_openai_stream(
        {
            'id': 'chatcmpl-test',
            'created': 123,
            'model': 'gpt-4o',
            'choices': [
                {
                    'index': 0,
                    'message': {'role': 'assistant', 'content': 'hello'},
                    'finish_reason': 'stop',
                }
            ],
            'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
        }
    )
    assert len(events) >= 3
    assert events[-1] == write_openai_sse_done()
    first = events[0]
    assert first.startswith('data: ')
    chunk = json.loads(first[len('data: ') :].strip())
    assert chunk['id'] == 'chatcmpl-test'
    assert chunk['object'] == 'chat.completion.chunk'
    assert chunk['model'] == 'gpt-4o'
    assert chunk['choices'][0]['delta']['content'] == 'hello'


def test_openai_module_reexports_compat_aliases():
    assert openai_adapter.writeOpenaiSseHeaders is write_openai_sse_headers
    assert openai_adapter.writeOpenaiSseData is write_openai_sse_data
    assert openai_adapter.writeOpenaiSseError is write_openai_sse_error
    assert openai_adapter.writeOpenaiSseDone is write_openai_sse_done
    assert openai_adapter.sendSimulatedOpenaiStream is send_simulated_openai_stream
