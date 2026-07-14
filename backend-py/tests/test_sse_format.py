"""Characterization tests for adapters.sse_format helpers."""
from __future__ import annotations

import json

from app.adapters.sse_format import write_sse_data_only, write_sse_event
from app.adapters import stream_state


def test_write_sse_event_format():
    line = write_sse_event('message_start', {'type': 'message_start', 'id': 1})
    assert line.startswith('event: message_start\n')
    assert 'data: ' in line
    payload = line.split('data: ', 1)[1].strip()
    assert json.loads(payload) == {'type': 'message_start', 'id': 1}
    assert line.endswith('\n\n')


def test_write_sse_data_only_format():
    line = write_sse_data_only({'ok': True})
    assert line.startswith('data: ')
    assert 'event:' not in line
    assert json.loads(line[len('data: ') :].strip()) == {'ok': True}


def test_stream_state_reexports_compat_aliases():
    assert stream_state.writeSseEvent is write_sse_event
    assert stream_state.writeSseDataOnly is write_sse_data_only
