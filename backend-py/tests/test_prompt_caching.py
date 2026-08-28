"""Anthropic prompt-cache breakpoints + prompt cache stats."""

from __future__ import annotations

import pytest
from app.adapters.anthropic import apply_prompt_caching, buildAnthropicUpstreamRequest
from app.services.workbench.prompt_cache import PromptCache


def test_system_string_becomes_cached_block():
    body = apply_prompt_caching({'system': 'you are august', 'messages': [], 'tools': []})
    system = body['system']
    assert isinstance(system, list)
    assert system[0]['cache_control'] == {'type': 'ephemeral'}
    assert system[0]['text'] == 'you are august'


def test_system_list_marks_last_block():
    body = apply_prompt_caching(
        {'system': [{'type': 'text', 'text': 'a'}, {'type': 'text', 'text': 'b'}], 'messages': []}
    )
    assert 'cache_control' not in body['system'][0]
    assert body['system'][-1]['cache_control'] == {'type': 'ephemeral'}


def test_tools_last_definition_marked():
    body = apply_prompt_caching(
        {
            'system': 's',
            'tools': [{'name': 'a'}, {'name': 'b'}],
            'messages': [],
        }
    )
    assert 'cache_control' not in body['tools'][0]
    assert body['tools'][-1]['cache_control'] == {'type': 'ephemeral'}


def test_last_user_message_marked():
    body = apply_prompt_caching(
        {
            'system': 's',
            'messages': [
                {'role': 'user', 'content': 'first'},
                {'role': 'assistant', 'content': 'reply'},
                {'role': 'user', 'content': 'final question'},
            ],
        }
    )
    # Only the final user message gets the breakpoint; earlier ones untouched.
    assert body['messages'][0]['content'] == 'first'
    assert body['messages'][1]['content'] == 'reply'
    final = body['messages'][-1]
    assert final['content'] == [
        {'type': 'text', 'text': 'final question', 'cache_control': {'type': 'ephemeral'}}
    ]


def test_last_user_block_list_marked():
    body = apply_prompt_caching(
        {
            'system': 's',
            'messages': [
                {
                    'role': 'user',
                    'content': [
                        {'type': 'text', 'text': 'a'},
                        {'type': 'text', 'text': 'b'},
                    ],
                }
            ],
        }
    )
    blocks = body['messages'][0]['content']
    assert 'cache_control' not in blocks[0]
    assert blocks[-1]['cache_control'] == {'type': 'ephemeral'}


def test_idempotent():
    body = apply_prompt_caching({'system': 's', 'messages': [{'role': 'user', 'content': 'hi'}]})
    again = apply_prompt_caching(body)
    assert again['system'][0]['cache_control'] == {'type': 'ephemeral'}


def test_builder_applies_caching(monkeypatch):
    from app.adapters import anthropic as mod

    monkeypatch.setenv('AUGUST_ANTHROPIC_CACHE', '1')
    body = buildAnthropicUpstreamRequest(
        {'model': 'claude-x', 'messages': [{'role': 'user', 'content': 'hello'}]},
        'claude-x',
        system=[{'type': 'text', 'text': 'sys'}],
    )
    # The builder no longer caches inline: breakpoints must be applied AFTER
    # tools are attached (the audit fix), so callers apply_prompt_caching the
    # finished body. The breakpoint logic itself is unchanged.
    body = mod.apply_prompt_caching(body)
    assert body['system'][-1].get('cache_control') == {'type': 'ephemeral'}
    assert body['messages'][-1]['content'][0].get('cache_control') == {'type': 'ephemeral'}


def test_disabled_via_env(monkeypatch):
    monkeypatch.setenv('AUGUST_ANTHROPIC_CACHE', '0')
    body = apply_prompt_caching({'system': 's', 'messages': [{'role': 'user', 'content': 'hi'}]})
    assert 'cache_control' not in body['system']
    assert body['messages'][0]['content'] == 'hi'


def test_persistent_ttl_opt_in_default_off(monkeypatch):
    """Bug 9b: default breakpoints stay plain ephemeral (5-min, refreshed on hit)."""
    monkeypatch.delenv('AUGUST_ANTHROPIC_PERSISTENT_CACHE', raising=False)
    body = apply_prompt_caching({'system': 's', 'messages': [{'role': 'user', 'content': 'hi'}]})
    assert body['system'][0]['cache_control'] == {'type': 'ephemeral'}


def test_persistent_ttl_opt_in_uses_1h_shape(monkeypatch):
    """Bug 9b: AUGUST_ANTHROPIC_PERSISTENT_CACHE=1 → ``{'type':'ephemeral','ttl':'1h'}``.

    That is the real Anthropic extended-cache wire shape — there is no
    ``type: 'persistent'`` and no request-side key for OpenAI-compatible
    hosts (their prefix caching is automatic), so nothing else is injected.
    """
    monkeypatch.setenv('AUGUST_ANTHROPIC_PERSISTENT_CACHE', '1')
    body = apply_prompt_caching(
        {
            'system': 's',
            'tools': [{'name': 'a'}],
            'messages': [{'role': 'user', 'content': 'hi'}],
        }
    )
    marker = {'type': 'ephemeral', 'ttl': '1h'}
    assert body['system'][0]['cache_control'] == marker
    assert body['tools'][-1]['cache_control'] == marker
    assert body['messages'][-1]['content'][0]['cache_control'] == marker


def test_prompt_cache_stats():
    cache = PromptCache(maxSessions=4, ttlSeconds=60)
    cache.set('k1', 'v1')
    assert cache.get('k1') == 'v1'
    assert cache.get('k1') == 'v1'
    assert cache.get('missing') is None
    stats = cache.stats()
    assert stats['hits'] == 2
    assert stats['misses'] == 1
    assert stats['hit_rate'] == pytest.approx(2 / 3, abs=0.001)
