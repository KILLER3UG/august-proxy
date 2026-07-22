"""Tests for reasoning preserve + Anthropic signature capture + Connected! probe."""

from __future__ import annotations

from app.adapters.reasoning_policy import attach_openai_reasoning
from app.adapters.stream_state import OpenaiStreamAccumulator
from app.services.workbench.stream_translate import AnthropicWorkbenchStreamAggregator


def test_attach_openai_reasoning_sets_both_fields():
    msg: dict[str, object] = {'role': 'assistant', 'content': 'hi'}
    attach_openai_reasoning(msg, '  chain of thought  ')
    assert msg['reasoning_content'] == 'chain of thought'
    assert msg['reasoning'] == 'chain of thought'


def test_attach_openai_reasoning_skips_empty():
    msg: dict[str, object] = {'role': 'assistant', 'content': 'hi'}
    attach_openai_reasoning(msg, '   ')
    assert 'reasoning_content' not in msg
    assert 'reasoning' not in msg


def test_proxy_accumulator_build_response_sets_both_reasoning_keys():
    """Proxy nested tool rounds use acc.reasoning; build_response must expose both keys."""
    acc = OpenaiStreamAccumulator()
    acc.accumulate(
        {
            'choices': [
                {
                    'delta': {'reasoning_content': 'nested thought', 'content': 'ok'},
                    'finish_reason': 'stop',
                }
            ]
        }
    )
    msg = acc.build_response()['choices'][0]['message']
    assert msg.get('reasoning') == 'nested thought'
    assert msg.get('reasoning_content') == 'nested thought'

    # Nested-round append path mirrors attach_openai_reasoning(acc.reasoning).
    next_assistant: dict[str, object] = {'role': 'assistant', 'content': acc.content}
    attach_openai_reasoning(next_assistant, acc.reasoning)
    assert next_assistant['reasoning_content'] == 'nested thought'
    assert next_assistant['reasoning'] == 'nested thought'


def test_anthropic_aggregator_captures_signature_delta():
    agg = AnthropicWorkbenchStreamAggregator()
    agg.on_event(
        {
            '_event_type': 'content_block_start',
            'content_block': {'type': 'thinking', 'thinking': ''},
        }
    )
    agg.on_event(
        {
            '_event_type': 'content_block_delta',
            'delta': {'type': 'thinking_delta', 'thinking': 'step one'},
        }
    )
    agg.on_event(
        {
            '_event_type': 'content_block_delta',
            'delta': {'type': 'signature_delta', 'signature': 'sig_xyz'},
        }
    )
    result = agg.result()
    blocks = result['content']
    thinking = next(b for b in blocks if b.get('type') == 'thinking')
    assert thinking.get('signature') == 'sig_xyz'
    assert thinking.get('thinking') == 'step one'
    assert thinking.get('text') == 'step one'


async def test_openai_workbench_preserves_reasoning_on_message_when_thinking_off(monkeypatch):
    """UI stays quiet when Thinking is off, but assistant message still carries
    reasoning_content for DeepSeek/Kimi tool-loop re-sends."""
    import app.providers.clients as clients
    from app.services.workbench.providers import call_openai_workbench

    class _FakeClient:
        def resolveApiKey(self):
            return 'test-key'

        async def chat_completions_stream(self, body):
            yield {
                'choices': [
                    {'index': 0, 'delta': {'reasoning_content': 'must keep'}},
                ]
            }
            yield {
                'choices': [
                    {
                        'index': 0,
                        'delta': {
                            'content': '',
                            'tool_calls': [
                                {
                                    'index': 0,
                                    'id': 'call_1',
                                    'type': 'function',
                                    'function': {'name': 'echo', 'arguments': '{}'},
                                }
                            ],
                        },
                        'finish_reason': 'tool_calls',
                    }
                ]
            }

    monkeypatch.setattr(clients, 'getClient', lambda provider: _FakeClient())
    emitted: list[dict] = []
    result = await call_openai_workbench(
        [{'role': 'user', 'content': 'hi'}],
        'You are helpful.',
        'deepseek-v4',
        [],
        'medium',
        provider={'name': 'deepseek', 'model_profiles': {'*': {}}},
        emit=emitted.append,
        thinking_enabled=False,
    )
    assert result is not None
    assert result['thinking'] == ''
    assert not any(e.get('type') == 'thinking' for e in emitted)
    msg = result['choices'][0]['message']
    assert msg.get('reasoning_content') == 'must keep'
    assert msg.get('reasoning') == 'must keep'
    assert msg.get('tool_calls')


async def test_model_probe_requires_connected(monkeypatch):
    import app.services.workbench.providers as wb_providers
    from app.routers.providers import testModel

    async def fake_openai(*_a, **_k):
        return {'text': 'Connected!', 'choices': [{'message': {'content': 'Connected!'}}]}

    # testModel imports these symbols locally — patch the providers module.
    monkeypatch.setattr(wb_providers, 'resolve_chat_llm', lambda **_k: (
        {'id': 'p1', 'name': 'deepseek', 'apiMode': 'openaiChat'},
        'deepseek-v4',
    ))
    monkeypatch.setattr(wb_providers, 'is_openai_provider', lambda _p: True)
    monkeypatch.setattr(wb_providers, 'is_anthropic_provider', lambda _p: False)
    monkeypatch.setattr(wb_providers, 'call_openai_workbench', fake_openai)

    ok = await testModel('deepseek', 'deepseek-v4')
    assert ok['success'] is True
    assert ok['content'] == 'Connected!'


async def test_model_probe_rejects_wrong_text(monkeypatch):
    import app.services.workbench.providers as wb_providers
    from app.routers.providers import testModel

    async def fake_openai(*_a, **_k):
        return {'text': 'Hello!', 'choices': [{'message': {'content': 'Hello!'}}]}

    monkeypatch.setattr(wb_providers, 'resolve_chat_llm', lambda **_k: (
        {'id': 'p1', 'name': 'deepseek', 'apiMode': 'openaiChat'},
        'deepseek-v4',
    ))
    monkeypatch.setattr(wb_providers, 'is_openai_provider', lambda _p: True)
    monkeypatch.setattr(wb_providers, 'is_anthropic_provider', lambda _p: False)
    monkeypatch.setattr(wb_providers, 'call_openai_workbench', fake_openai)

    bad = await testModel('deepseek', 'deepseek-v4')
    assert bad['success'] is False
    assert 'Connected!' in (bad.get('error') or '')
