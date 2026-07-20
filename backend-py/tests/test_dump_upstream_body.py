"""Upstream body dumps must not forward null / August-only routing fields."""

from __future__ import annotations

from app.models.anthropic import AnthropicRequest, dump_anthropic_upstream_body
from app.models.openai import ChatCompletionRequest, dump_openai_upstream_body


def test_openai_dump_excludes_null_session_id():
    body = dump_openai_upstream_body(ChatCompletionRequest(model='deepseek-v4-flash'))
    assert body == {'model': 'deepseek-v4-flash', 'stream': False}
    assert 'session_id' not in body
    assert 'user' not in body
    assert 'metadata' not in body
    assert None not in body.values()


def test_openai_dump_strips_august_keys_from_dict():
    body = dump_openai_upstream_body(
        {
            'model': 'x',
            'messages': [{'role': 'user', 'content': 'hi'}],
            'session_id': None,
            'sessionId': 'keep-me-out',
            'user': None,
            'metadata': {'a': 1},
            'temperature': None,
        }
    )
    assert body == {'model': 'x', 'messages': [{'role': 'user', 'content': 'hi'}]}


def test_anthropic_dump_excludes_null_session_id():
    body = dump_anthropic_upstream_body(AnthropicRequest(model='claude-sonnet-4-6', max_tokens=100))
    assert body['model'] == 'claude-sonnet-4-6'
    assert body['max_tokens'] == 100
    assert 'session_id' not in body
    assert None not in body.values()
