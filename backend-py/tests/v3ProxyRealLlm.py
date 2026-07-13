"""v3 — Real-LLM proxy integration tests (exercises the full adapter path).

These tests drive the *actual* proxy adapter code (``app.adapters.openai`` /
``app.adapters.anthropic``) against a live OpenAI-compatible endpoint, so they
validate the full request translation -> provider client -> LLM -> response
translation pipeline — not just mocks.

They are SKIPPED by default. To run them:

    RUN_REAL_LLM=1 pytest tests/v3_proxy_real_llm.py -v -s

The endpoint / api key / model are imported from ``tests.v2RealLlm`` (the same
free-tier harness used by the v2 tests) so there is a single source of truth
for the external credential.

Notes:
- These make real HTTP calls (~10-30s each) and need network access.
- The managed-tool test triggers ``execute_managed_proxy_tool`` (a real web
  search), so it also needs outbound network to the search backend.
- Provider routing is set up via a temporary ``providers.json`` (same pattern
  as ``tests/testProviderCredentials.py``) pointing the external model alias at
  the external endpoint, then invalidating the provider cache.
"""

from __future__ import annotations
import json
import os
import pytest

from tests.v2RealLlm import EXTERNAL_API_URL, EXTERNAL_API_KEY, TEST_MODEL

pytestmark = pytest.mark.skipif(
    not os.environ.get('RUN_REAL_LLM'),
    reason='Real-LLM proxy tests skipped by default. Set RUN_REAL_LLM=1 to enable (requires network access).',
)


def _registerExternalProvider(tmp_path, monkeypatch):
    """Point the proxy's provider resolution at the external test endpoint."""
    from app.services import config_service, provider_credentials

    path = tmp_path / 'providers.json'
    store = {
        'providers': [
            {
                'id': 'external-zen',
                'name': TEST_MODEL,
                'baseUrl': EXTERNAL_API_URL.rsplit('/chat/completions', 1)[0],
                'apiFormat': 'openaiChat',
                'apiKey': EXTERNAL_API_KEY,
                'enabled': True,
                'aliases': [TEST_MODEL],
            }
        ]
    }
    path.write_text(json.dumps(store), encoding='utf-8')
    monkeypatch.setattr(config_service, 'dataPath', lambda name, *a, **kw: path if name == 'providers.json' else path)
    provider_credentials.invalidate()
    yield path
    provider_credentials.invalidate()


@pytest.fixture
def externalProvider(tmp_path, monkeypatch):
    yield from _registerExternalProvider(tmp_path, monkeypatch)


def testNonStreamingChatCompletesThroughAdapter(externalProvider):
    """Full path: /v1/chat/completions (non-streaming) -> external LLM -> Anthropic-translated reply."""
    from app.adapters import openai as openaiAdapter

    body = {
        'model': TEST_MODEL,
        'messages': [{'role': 'user', 'content': 'Reply with exactly the word "pong" and nothing else.'}],
        'stream': False,
    }
    result, _headers = openaiAdapter.handleChatCompletions(body, request=None)
    assert isinstance(result, dict), f'expected dict response, got {type(result)}'
    assert result.get('type') == 'message', f'unexpected response shape: {result}'
    content = result.get('content', [])
    text = ''.join(b.get('text', '') for b in content if isinstance(b, dict))
    assert 'pong' in text.lower(), f'expected pong in reply, got: {text!r}'


def testStreamingChatYieldsContentThroughAdapter(externalProvider):
    """Full path: /v1/chat/completions (streaming) -> external LLM SSE -> Anthropic events."""
    import asyncio
    from app.adapters import openai as openaiAdapter

    body = {
        'model': TEST_MODEL,
        'messages': [{'role': 'user', 'content': 'Say "hello" in exactly one word.'}],
        'stream': True,
    }
    result, _headers = openaiAdapter.handleChatCompletions(body, request=None)
    assert hasattr(result, '__aiter__'), 'expected an async iterator for streaming'
    events: list[str] = []

    async def _collect():
        async for chunk in result:
            events.append(chunk)

    asyncio.run(_collect())
    joined = ''.join(events)
    assert 'hello' in joined.lower(), f'expected hello in stream, got: {joined[:300]!r}'


def testManagedToolLoopRunsThroughAnthropicAdapter(externalProvider):
    """Full path: /v1/messages with a managed WebSearch tool. The proxy should
    intercept the tool call locally and re-stream, returning a final answer
    without crashing (proves the multi-round loop in _streamOpenaiAsAnthropic
    / managed-tool interception works end-to-end against a real model)."""
    import asyncio
    from app.adapters import anthropic as anthropicAdapter
    from app.adapters.proxy_tools import get_managed_anthropic_web_tool_definitions

    body = {
        'model': TEST_MODEL,
        'messages': [
            {
                'role': 'user',
                'content': 'Use the WebSearch tool to look up the current capital of France, then tell me the answer in one sentence.',
            }
        ],
        'stream': True,
        'tools': get_managed_anthropic_web_tool_definitions(),
    }
    result, _headers = anthropicAdapter.handleMessages(body, request=None)
    assert hasattr(result, '__aiter__'), 'expected an async iterator for streaming'
    events: list[str] = []

    async def _collect():
        async for chunk in result:
            events.append(chunk)

    asyncio.run(_collect())
    joined = ''.join(events)
    # The managed tool is executed locally and the loop must return a final
    # assistant turn (not truncate after one round). Assert we got a real,
    # non-error completion mentioning the answer.
    assert 'paris' in joined.lower(), f'expected Paris in final answer, got: {joined[:400]!r}'


if __name__ == '__main__':
    os.environ['RUN_REAL_LLM'] = '1'
    pytest.main([__file__, '-v', '-s', '--tb=short', '-p', 'no:cacheprovider'])
