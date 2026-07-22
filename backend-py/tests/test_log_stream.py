"""Tests for the thread-safe log-stream hub (app.services.log_stream)."""

from __future__ import annotations

import pytest
from app.services import log_stream


def testNewestFirstRingBuffer():
    log_stream._buffer.clear()
    for i in range(5):
        log_stream.emitLogEvent({'category': 'info', 'level': 'info', 'message': f'msg-{i}'})
    recent = log_stream.getRecentLogEvents(10)
    assert len(recent) == 5
    # newest first → last emitted (msg-4) is at index 0
    assert recent[0]['message'] == 'msg-4'
    assert recent[-1]['message'] == 'msg-0'


def testRecentLimit():
    log_stream._buffer.clear()
    for i in range(20):
        log_stream.emitLogEvent({'category': 'info', 'level': 'info', 'message': f'm-{i}'})
    assert len(log_stream.getRecentLogEvents(5)) == 5
    assert len(log_stream.getRecentLogEvents(0)) == 0


def testEventSchema():
    log_stream._buffer.clear()
    ev = log_stream.buildEvent(category='proxy_upstream', level='info', message='hi', metadata={'k': 'v'})
    assert set(ev.keys()) >= {'id', 'timestamp', 'category', 'level', 'message', 'metadata', 'raw'}
    assert isinstance(ev['timestamp'], int)
    assert ev['category'] == 'proxy_upstream'


def testDefaultCategoryIsInfo():
    log_stream._buffer.clear()
    log_stream.emitLogEvent({'message': 'no category'})
    assert log_stream.getRecentLogEvents(1)[0]['category'] == 'info'


def testRedactionStripsSecrets():
    log_stream._buffer.clear()
    log_stream.emitLogEvent(
        {
            'category': 'security',
            'level': 'warn',
            'message': 'auth',
            'metadata': {'apiKey': 'secret', 'note': 'ok', 'password': 'hunter2'},
        }
    )
    meta = log_stream.getRecentLogEvents(1)[0]['metadata']
    assert meta['apiKey'] == '[REDACTED]'
    assert meta['password'] == '[REDACTED]'
    assert meta['note'] == 'ok'


def testClientManagement():
    class FakeWs:
        pass

    ws = FakeWs()
    log_stream.addLogWsClient(ws)
    assert ws in log_stream._clients
    log_stream.removeLogWsClient(ws)
    assert ws not in log_stream._clients
