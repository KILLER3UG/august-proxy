"""Per-model apiFormat override — multi-format gateways (OpenCode Zen).

A model entry in providers.json may carry its own ``apiFormat``. When it does,
the wire path for that model follows the model format instead of the
provider-level format (Claude → /v1/messages, GPT/DeepSeek → /chat/completions).
"""

from __future__ import annotations

import pytest
from app.providers.resolver import apply_model_format_override


def _provider(**overrides) -> dict:
    p = {
        'name': 'Opencode Zen',
        'id': 'zen-1',
        'baseUrl': 'https://opencode.ai/zen/v1',
        'apiMode': 'openaiChat',
        'api_key': 'sk-test',
        'models': [
            {'id': 'gpt-4o', 'name': 'gpt-4o'},
            {'id': 'claude-sonnet-4', 'name': 'claude-sonnet-4', 'apiFormat': 'anthropicMessages'},
        ],
    }
    p.update(overrides)
    return p


# --- apply_model_format_override ------------------------------------------


def test_override_none_provider_or_model_unchanged():
    assert apply_model_format_override(None, 'gpt-4o') is None
    p = _provider()
    assert apply_model_format_override(p, '') is p


def test_override_model_without_format_keeps_provider_mode():
    p = _provider()
    out = apply_model_format_override(p, 'gpt-4o')
    assert out is p
    assert out['apiMode'] == 'openaiChat'


def test_override_model_with_format_wins():
    out = apply_model_format_override(_provider(), 'claude-sonnet-4')
    assert out is not None
    assert out['apiMode'] == 'anthropicMessages'
    # Original dict untouched (immutability)
    assert _provider()['apiMode'] == 'openaiChat'


def test_override_model_id_case_insensitive():
    out = apply_model_format_override(_provider(), 'CLAUDE-SONNET-4')
    assert out is not None
    assert out['apiMode'] == 'anthropicMessages'


def test_override_unknown_format_falls_back_to_provider_mode():
    p = _provider()
    p['models'] = [
        {'id': 'claude-sonnet-4', 'apiFormat': 'not-a-format'},
    ]
    out = apply_model_format_override(p, 'claude-sonnet-4')
    assert out is not None
    assert out['apiMode'] == 'openaiChat'


def test_override_unknown_model_keeps_provider_mode():
    out = apply_model_format_override(_provider(), 'deepseek-v3')
    assert out is not None
    assert out['apiMode'] == 'openaiChat'


# --- resolve_chat_llm honors the override ---------------------------------


def test_resolve_chat_llm_applies_per_model_override(monkeypatch):
    import app.services.workbench.providers as wbp

    def fake_resolve(provider_name, model_hint=''):
        return _provider()

    monkeypatch.setattr(wbp, 'resolve_workbench_provider', fake_resolve)
    provider, model = wbp.resolve_chat_llm(
        model='claude-sonnet-4', model_provider='zen-1'
    )
    assert model == 'claude-sonnet-4'
    assert provider is not None
    assert provider['apiMode'] == 'anthropicMessages'
    assert wbp.is_anthropic_provider(provider) is True
    assert wbp.is_openai_provider(provider) is False


def test_resolve_chat_llm_no_override_keeps_provider_format(monkeypatch):
    import app.services.workbench.providers as wbp

    def fake_resolve(provider_name, model_hint=''):
        return _provider()

    monkeypatch.setattr(wbp, 'resolve_workbench_provider', fake_resolve)
    provider, model = wbp.resolve_chat_llm(model='gpt-4o', model_provider='zen-1')
    assert model == 'gpt-4o'
    assert provider is not None
    assert provider['apiMode'] == 'openaiChat'


# --- OpenAI body → Anthropic body translation ------------------------------


def test_openai_to_anthropic_body_system_and_messages():
    from app.adapters.openai import _openaiToAnthropicBody

    body = _openaiToAnthropicBody(
        {
            'model': 'claude-sonnet-4',
            'messages': [
                {'role': 'system', 'content': 'Be brief.'},
                {'role': 'user', 'content': 'Hi'},
                {'role': 'assistant', 'content': 'Hello'},
            ],
            'max_tokens': 512,
            'stream': True,
        }
    )
    assert body['model'] == 'claude-sonnet-4'
    assert body['system'] == 'Be brief.'
    assert body['max_tokens'] == 512
    assert body['messages'] == [
        {'role': 'user', 'content': 'Hi'},
        {'role': 'assistant', 'content': 'Hello'},
    ]


def test_openai_to_anthropic_body_tool_result_and_tool_calls():
    from app.adapters.openai import _openaiToAnthropicBody

    body = _openaiToAnthropicBody(
        {
            'model': 'claude-sonnet-4',
            'messages': [
                {
                    'role': 'assistant',
                    'content': None,
                    'tool_calls': [
                        {
                            'id': 'call_1',
                            'function': {'name': 'read_file', 'arguments': '{"path": "a.py"}'},
                        }
                    ],
                },
                {'role': 'tool', 'tool_call_id': 'call_1', 'content': 'ok'},
            ],
        }
    )
    assistant = body['messages'][0]
    assert assistant['content'] == [
        {
            'type': 'tool_use',
            'id': 'call_1',
            'name': 'read_file',
            'input': {'path': 'a.py'},
        }
    ]
    tool_result = body['messages'][1]
    assert tool_result['role'] == 'user'
    assert tool_result['content'][0]['type'] == 'tool_result'
    assert tool_result['content'][0]['tool_use_id'] == 'call_1'
    assert tool_result['content'][0]['content'] == 'ok'


def test_openai_to_anthropic_body_tools_and_default_max_tokens():
    from app.adapters.openai import _openaiToAnthropicBody

    body = _openaiToAnthropicBody(
        {
            'model': 'claude-sonnet-4',
            'messages': [{'role': 'user', 'content': 'hi'}],
            'tools': [
                {
                    'type': 'function',
                    'function': {
                        'name': 'search',
                        'description': 'Search',
                        'parameters': {'type': 'object', 'properties': {}},
                    },
                }
            ],
        }
    )
    assert body['max_tokens'] == 4096  # Anthropic requires it
    assert body['tools'] == [
        {
            'name': 'search',
            'description': 'Search',
            'input_schema': {'type': 'object', 'properties': {}},
        }
    ]


def test_openai_to_anthropic_body_content_parts():
    from app.adapters.openai import _openaiToAnthropicBody

    body = _openaiToAnthropicBody(
        {
            'model': 'claude-sonnet-4',
            'messages': [
                {
                    'role': 'user',
                    'content': [
                        {'type': 'text', 'text': 'Look at this'},
                        {'type': 'image_url', 'image_url': {'url': 'https://x/y.png'}},
                    ],
                }
            ],
        }
    )
    content = body['messages'][0]['content']
    assert content == [
        {'type': 'text', 'text': 'Look at this'},
        {'type': 'image', 'source': {'type': 'url', 'url': 'https://x/y.png'}},
    ]


# --- Anthropic response → OpenAI response translation ----------------------


def test_anthropic_stop_mapping():
    from app.adapters.openai import _anthropicStopToOpenaiFinish

    assert _anthropicStopToOpenaiFinish('end_turn') == 'stop'
    assert _anthropicStopToOpenaiFinish('stop_sequence') == 'stop'
    assert _anthropicStopToOpenaiFinish('max_tokens') == 'length'
    assert _anthropicStopToOpenaiFinish('tool_use') == 'tool_calls'
    assert _anthropicStopToOpenaiFinish('weird') is None


def test_anthropic_json_to_openai_response():
    from app.adapters.openai import _anthropicJsonToOpenaiResponse

    out = _anthropicJsonToOpenaiResponse(
        {
            'id': 'msg_123',
            'stop_reason': 'end_turn',
            'content': [
                {'type': 'text', 'text': 'Hello '},
                {'type': 'text', 'text': 'world'},
            ],
            'usage': {'input_tokens': 10, 'output_tokens': 5},
        },
        'claude-sonnet-4',
    )
    assert out['object'] == 'chat.completion'
    assert out['choices'][0]['message']['content'] == 'Hello world'
    assert out['choices'][0]['finish_reason'] == 'stop'
    assert out['usage'] == {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}


def _json_chunk(line: str) -> dict:
    import json as _json

    return _json.loads(line[len('data: ') :])


# --- Streaming translation (fake anthropic client) -------------------------


class _FakeAnthropicClient:
    apiFormat = 'anthropicMessages'

    def __init__(self, events):
        self._events = events

    def resolveApiKey(self):
        return 'sk-test'

    def buildAuthHeaders(self, apiKey):
        return {'x-api-key': apiKey}

    async def messages_stream(self, body, apiKey=None):
        for evt in self._events:
            yield evt

    async def messages(self, body, apiKey=None):
        from types import SimpleNamespace

        return SimpleNamespace(
            is_error=False,
            status=200,
            body={
                'id': 'msg_1',
                'stop_reason': 'end_turn',
                'content': [{'type': 'text', 'text': 'Connected!'}],
                'usage': {'input_tokens': 3, 'output_tokens': 2},
            },
        )


@pytest.mark.asyncio
async def test_stream_anthropic_as_openai_chunks():
    from app.adapters.openai import _streamAnthropicAsOpenai

    client = _FakeAnthropicClient(
        [
            {'type': 'message_start', 'message': {'id': 'msg_1', 'model': 'claude-sonnet-4'}},
            {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'Hi'}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': ' there'}},
            {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'input_tokens': 4, 'output_tokens': 2}},
            {'type': 'message_stop'},
        ]
    )
    lines = [line async for line in _streamAnthropicAsOpenai(client, 'claude-sonnet-4', {}, 'sk-test')]
    chunks = [_json_chunk(ln) for ln in lines if ln.startswith('data: ') and not ln.startswith('data: [DONE]')]
    deltas = [c['choices'][0]['delta'] for c in chunks if c.get('choices')]
    assert {'role': 'assistant'} in deltas
    assert {'content': 'Hi'} in deltas
    assert {'content': ' there'} in deltas
    finish = [c['choices'][0]['finish_reason'] for c in chunks if c.get('choices') and c['choices'][0].get('finish_reason')]
    assert 'stop' in finish
    assert any(c.get('usage', {}).get('completion_tokens') == 2 for c in chunks)
    assert lines[-1].startswith('data: [DONE]')


@pytest.mark.asyncio
async def test_stream_anthropic_as_openai_error_event():
    from app.adapters.openai import _streamAnthropicAsOpenai

    client = _FakeAnthropicClient([{'type': 'error', 'error': 'boom'}])
    lines = [line async for line in _streamAnthropicAsOpenai(client, 'm', {}, 'sk-test')]
    assert any('boom' in ln for ln in lines)
    assert any('data: [DONE]' in ln for ln in lines)


@pytest.mark.asyncio
async def test_handle_openai_body_to_anthropic_upstream_non_streaming():
    from app.adapters.openai import _handleOpenaiBodyToAnthropicUpstream

    client = _FakeAnthropicClient([])
    resp, headers = await _handleOpenaiBodyToAnthropicUpstream(
        client,
        'claude-sonnet-4',
        {'model': 'claude-sonnet-4', 'messages': [{'role': 'user', 'content': 'hi'}]},
    )
    assert headers is None
    assert resp is not None
    assert resp['object'] == 'chat.completion'
    assert resp['choices'][0]['message']['content'] == 'Connected!'
    assert resp['choices'][0]['finish_reason'] == 'stop'


@pytest.mark.asyncio
async def test_handle_openai_body_to_anthropic_upstream_streaming():
    from app.adapters.openai import _handleOpenaiBodyToAnthropicUpstream

    client = _FakeAnthropicClient([{'type': 'message_start', 'message': {'id': 'm'}}])
    stream, headers = await _handleOpenaiBodyToAnthropicUpstream(
        client,
        'claude-sonnet-4',
        {'model': 'claude-sonnet-4', 'messages': [{'role': 'user', 'content': 'hi'}], 'stream': True},
    )
    assert headers is not None
    assert 'text/event-stream' in headers.get('content-type', headers.get('Content-Type', ''))
    lines = [ln async for ln in stream]
    assert any(ln.startswith('data: ') for ln in lines)
    assert lines[-1].startswith('data: [DONE]')


@pytest.mark.asyncio
async def test_responses_endpoint_with_anthropic_model_errors():
    from app.adapters.openai import _handleOpenaiBodyToAnthropicUpstream

    client = _FakeAnthropicClient([])
    resp, headers = await _handleOpenaiBodyToAnthropicUpstream(
        client,
        'claude-sonnet-4',
        {'model': 'claude-sonnet-4', 'messages': [], '_endpoint': 'responses'},
    )
    assert 'error' in resp
    assert 'messages' in resp['error']


# --- handleChatCompletions routing ----------------------------------------


@pytest.mark.asyncio
async def test_handle_chat_completions_routes_anthropic_format_model(monkeypatch):
    import app.adapters.openai as mod

    calls = {}

    def fake_resolve(name, default_alias=''):
        return {'provider': 'zen-1', 'model': name}

    def fake_provider_resolve(name):
        return {
            'name': 'Opencode Zen',
            'apiMode': 'openaiChat',
            'baseUrl': 'https://opencode.ai/zen/v1',
            'api_key': 'sk-test',
            'models': [
                {'id': 'claude-sonnet-4', 'apiFormat': 'anthropicMessages'},
            ],
        }

    def fake_get_client(provider):
        return _FakeAnthropicClient([])

    async def fake_handle(client, model, raw_body):
        calls['client'] = client
        calls['model'] = model
        return ({'translated': True, 'model': model}, None)

    monkeypatch.setattr(mod, 'resolve', fake_resolve)
    monkeypatch.setattr(mod.providerResolver, 'resolve', fake_provider_resolve)
    monkeypatch.setattr(mod, 'getClient', fake_get_client)
    monkeypatch.setattr(mod, '_handleOpenaiBodyToAnthropicUpstream', fake_handle)

    resp, _headers = await mod.handleChatCompletions(
        {'model': 'claude-sonnet-4', 'messages': [{'role': 'user', 'content': 'hi'}]}
    )
    assert resp == {'translated': True, 'model': 'claude-sonnet-4'}
    assert calls['model'] == 'claude-sonnet-4'
    assert calls['client'].apiFormat == 'anthropicMessages'


@pytest.mark.asyncio
async def test_handle_chat_completions_openai_model_keeps_normal_path(monkeypatch):
    import app.adapters.openai as mod

    def fake_resolve(name, default_alias=''):
        return {'provider': 'zen-1', 'model': name}

    def fake_provider_resolve(name):
        return {
            'name': 'Opencode Zen',
            'apiMode': 'openaiChat',
            'baseUrl': 'https://opencode.ai/zen/v1',
            'api_key': 'sk-test',
            'models': [
                {'id': 'gpt-4o', 'name': 'gpt-4o'},
            ],
        }

    class _FakeOpenAIClient:
        apiFormat = 'openaiChat'

        def resolveApiKey(self):
            return 'sk-test'

        def buildAuthHeaders(self, apiKey):
            return {'authorization': f'Bearer {apiKey}'}

        def resolveBaseUrl(self):
            return 'https://opencode.ai/zen/v1'

        async def requestJson(self, method, url, headers, body):
            from types import SimpleNamespace

            return SimpleNamespace(
                is_error=False,
                status=200,
                body={
                    'id': 'chatcmpl-1',
                    'object': 'chat.completion',
                    'choices': [
                        {
                            'index': 0,
                            'message': {'role': 'assistant', 'content': 'pong'},
                            'finish_reason': 'stop',
                        }
                    ],
                    'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
                },
            )

    calls = {}

    async def fake_handle(client, model, raw_body):
        calls['hit_translation'] = True
        return ({'translated': True}, None)

    monkeypatch.setattr(mod, 'resolve', fake_resolve)
    monkeypatch.setattr(mod.providerResolver, 'resolve', fake_provider_resolve)
    monkeypatch.setattr(mod, 'getClient', lambda provider: _FakeOpenAIClient())
    monkeypatch.setattr(mod, '_handleOpenaiBodyToAnthropicUpstream', fake_handle)
    monkeypatch.setattr(mod, 'toOpenaiCompatibleTargetUrl', lambda base: base + '/chat/completions')
    monkeypatch.setattr(mod, 'get_proxy_openai_tool_definitions', lambda: [])

    resp, _headers = await mod.handleChatCompletions(
        {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]}
    )
    assert 'translated' not in calls  # normal path did not hit the translation
    assert resp is not None
