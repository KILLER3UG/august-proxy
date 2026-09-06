"""session_context tool — handoff capsule for a past session.

Locks the contract the model relies on: a missing id tells it HOW to find
ids, a real session renders title + plan + one trimmed line per turn (never
raw dumps), long sessions truncate at the char cap, and unknown ids say so
honestly.
"""
from __future__ import annotations

import pytest
from app.services.tool_registrations.session_tools import (
    _SESSION_CONTEXT_MAX_CHARS,
    _contextCapsule,
    _sessionContext,
)


def test_capsule_renders_turns_trimmed():
    blob = {
        'id': 'wb_1',
        'title': 'Fix the proxy',
        'plan': {'steps': ['diagnose', 'patch', 'test']},
        'messages': [
            {'role': 'user', 'content': 'The proxy 500s on /v1/messages.\nSecond line.'},
            {'role': 'assistant', 'content': 'x' * 400},
            {'role': 'tool', 'content': 'ignored — not dialogue'},
            {'role': 'user', 'content': '  '},
        ],
    }
    text = _contextCapsule(blob, 6000)
    assert 'SESSION wb_1 — "Fix the proxy"' in text
    assert 'Plan: 3 step(s) — diagnose; patch; test' in text
    assert 'USER: The proxy 500s on /v1/messages. Second line.' in text
    # Assistant line trimmed to 260 chars + ellipsis.
    assert f"AUG: {'x' * 257}…" in text
    # Blank user turns are skipped; tool rows never appear.
    assert text.count('USER:') == 1
    assert '(2 turn(s))' in text


def test_capsule_truncates_at_char_cap():
    blob = {
        'id': 'wb_big',
        'title': 'Long',
        'messages': [
            {'role': 'user', 'content': 'x' * 400} for _ in range(200)
        ],
    }
    text = _contextCapsule(blob, _SESSION_CONTEXT_MAX_CHARS)
    assert len(text) <= _SESSION_CONTEXT_MAX_CHARS + 40
    assert '…(truncated)' in text


def test_capsule_empty_session():
    text = _contextCapsule({'id': 'wb_e', 'title': 'Empty', 'messages': []}, 6000)
    assert 'no dialogue turns recorded' in text


@pytest.mark.asyncio
async def test_session_context_requires_id():
    out = await _sessionContext(sessionId='', query='')
    assert out.startswith('Error: sessionId is required')
    assert 'brain_query' in out  # teaches the model the discovery path


@pytest.mark.asyncio
async def test_session_context_missing_session(isolatedData):
    out = await _sessionContext(sessionId='wb_does_not_exist')
    assert 'not found' in out


@pytest.mark.asyncio
async def test_session_context_reads_persisted_session(isolatedData):
    from app.services.memory_store.sessions import save_workbench_session_sot

    save_workbench_session_sot(
        {
            'id': 'wb_capsule1',
            'title': 'Capsule test session',
            'messages': [
                {'role': 'user', 'content': 'What is 2+2?'},
                {'role': 'assistant', 'content': '4.'},
            ],
        }
    )
    out = await _sessionContext(sessionId='wb_capsule1')
    assert 'Capsule test session' in out
    assert 'USER: What is 2+2?' in out
    assert 'AUG: 4.' in out
    assert '(2 turn(s))' in out
