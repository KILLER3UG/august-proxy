"""Characterization tests for adapters.anthropic_sse helpers."""
from __future__ import annotations

import json

from app.adapters.anthropic_sse import (
    send_simulated_anthropic_stream,
    write_anthropic_sse_data,
    write_anthropic_sse_data_only,
)
from app.adapters import anthropic as anthropic_adapter


def test_write_anthropic_sse_data_format():
    line = write_anthropic_sse_data(
        'message_start', {'type': 'message_start', 'message': {'id': 'test'}}
    )
    assert line.startswith('event: message_start\n')
    assert 'data: ' in line
    payload = line.split('data: ', 1)[1].strip()
    assert json.loads(payload) == {'type': 'message_start', 'message': {'id': 'test'}}
    assert line.endswith('\n\n')


def test_write_anthropic_sse_data_only_format():
    line = write_anthropic_sse_data_only({'type': 'ping'})
    assert line.startswith('data: ')
    assert 'event:' not in line
    assert line.endswith('\n\n')
    assert json.loads(line[len('data: ') :].strip()) == {'type': 'ping'}


def test_send_simulated_anthropic_stream_wire_format():
    events = send_simulated_anthropic_stream(
        {
            'id': 'msg_test',
            'model': 'claude-3',
            'role': 'assistant',
            'content': [{'type': 'text', 'text': 'Hello!'}],
            'usage': {'input_tokens': 10, 'output_tokens': 5},
        }
    )
    assert len(events) >= 4
    assert events[0].startswith('event: message_start\n')
    first_payload = events[0].split('data: ', 1)[1].strip()
    message_start = json.loads(first_payload)
    assert message_start['type'] == 'message_start'
    assert message_start['message']['id'] == 'msg_test'
    assert message_start['message']['model'] == 'claude-3'
    assert events[-1].startswith('event: message_stop\n')


def test_send_simulated_anthropic_stream_tool_use_stop_reason():
    events = send_simulated_anthropic_stream(
        {
            'id': 'msg_tool',
            'model': 'claude-3',
            'content': [
                {
                    'type': 'tool_use',
                    'id': 'toolu_1',
                    'name': 'bash',
                    'input': {'command': 'ls'},
                }
            ],
            'usage': {'input_tokens': 1, 'output_tokens': 2},
        }
    )
    delta_events = [e for e in events if e.startswith('event: message_delta\n')]
    assert len(delta_events) == 1
    payload = json.loads(delta_events[0].split('data: ', 1)[1].strip())
    assert payload['delta']['stop_reason'] == 'tool_use'


def test_anthropic_module_reexports_compat_aliases():
    assert anthropic_adapter.writeAnthropicSseData is write_anthropic_sse_data
    assert anthropic_adapter.writeAnthropicSseDataOnly is write_anthropic_sse_data_only
    assert anthropic_adapter.sendSimulatedAnthropicStream is send_simulated_anthropic_stream
