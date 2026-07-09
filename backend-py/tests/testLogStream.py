"""Tests for the thread-safe log-stream hub (app.services.logStream)."""
from __future__ import annotations

import pytest

from app.services import logStream


def testNewestFirstRingBuffer():
    logStream._buffer.clear()
    for i in range(5):
        logStream.emitLogEvent({'category': 'info', 'level': 'info', 'message': f'msg-{i}'})
    recent = logStream.getRecentLogEvents(10)
    assert len(recent) == 5
    # newest first → last emitted (msg-4) is at index 0
    assert recent[0]['message'] == 'msg-4'
    assert recent[-1]['message'] == 'msg-0'


def testRecentLimit():
    logStream._buffer.clear()
    for i in range(20):
        logStream.emitLogEvent({'category': 'info', 'level': 'info', 'message': f'm-{i}'})
    assert len(logStream.getRecentLogEvents(5)) == 5
    assert len(logStream.getRecentLogEvents(0)) == 0


def testEventSchema():
    logStream._buffer.clear()
    ev = logStream.buildEvent(category='proxy_upstream', level='info', message='hi', metadata={'k': 'v'})
    assert set(ev.keys()) >= {'id', 'timestamp', 'category', 'level', 'message', 'metadata', 'raw'}
    assert isinstance(ev['timestamp'], int)
    assert ev['category'] == 'proxy_upstream'


def testDefaultCategoryIsInfo():
    logStream._buffer.clear()
    logStream.emitLogEvent({'message': 'no category'})
    assert logStream.getRecentLogEvents(1)[0]['category'] == 'info'


def testRedactionStripsSecrets():
    logStream._buffer.clear()
    logStream.emitLogEvent({
        'category': 'security',
        'level': 'warn',
        'message': 'auth',
        'metadata': {'apiKey': 'secret', 'note': 'ok', 'password': 'hunter2'},
    })
    meta = logStream.getRecentLogEvents(1)[0]['metadata']
    assert meta['apiKey'] == '[REDACTED]'
    assert meta['password'] == '[REDACTED]'
    assert meta['note'] == 'ok'


def testClientManagement():
    class FakeWs:
        pass
    ws = FakeWs()
    logStream.addLogWsClient(ws)
    assert ws in logStream._clients
    logStream.removeLogWsClient(ws)
    assert ws not in logStream._clients
