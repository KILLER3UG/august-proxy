"""Regression: an upstream 400 that rejects ``reasoning_effort`` must not break
the chat turn. ``call_openai_workbench`` attaches ``reasoning_effort`` as an
optional hint when the provider/model heuristic says yes, but some
OpenAI-compatible gateways configure a per-model pattern that rejects the value
we map (e.g. "high"). When that happens before any content is emitted, the
streamer must drop the hint and retry once instead of surfacing the error.
"""

from __future__ import annotations

import asyncio

import pytest
from app.services.workbench import providers as P


def test_reasoning_effort_rejected_detection():
    gw = "[400] parameter 'reasoning_effort' validation failed: value \"high\" does not match pattern configured for reasoning_effort"
    assert P._reasoning_effort_rejected(400, gw) is True
    assert P._reasoning_effort_rejected('400', gw) is True
    # Exception path carries no status — message text alone must trigger it.
    assert P._reasoning_effort_rejected(None, "bad reasoning_effort value") is True
    # Unrelated 400s must NOT trigger a retry (no behaviour change for them).
    assert P._reasoning_effort_rejected(400, "Invalid model id 'foo'") is False
    # A 500 that happens to mention the field is a server fault, not a pattern
    # rejection — do not retry on it.
    assert P._reasoning_effort_rejected(500, "reasoning_effort internal error") is False


class _FakeStreamClient:
    """Yields a reasoning_effort 400 on the first call, normal chunks after."""

    def __init__(self) -> None:
        self.bodies: list[dict[str, object]] = []

    def resolveApiKey(self) -> str:
        return 'test-key'

    async def chat_completions_stream(self, body: dict[str, object]):
        self.bodies.append(dict(body))
        if len(self.bodies) == 1:
            yield {
                'type': 'error',
                'error': {
                    'message': (
                        "parameter 'reasoning_effort' validation failed: "
                        'value "high" does not match pattern configured for reasoning_effort'
                    )
                },
                'status': 400,
            }
            return
        yield {
            '_event_type': 'chat.completion.chunk',
            'choices': [{'index': 0, 'delta': {'content': 'hello'}, 'finish_reason': None}],
        }
        yield {
            '_event_type': 'chat.completion.chunk',
            'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
        }


def test_call_openai_workbench_retries_without_reasoning_effort(monkeypatch):
    fake = _FakeStreamClient()
    monkeypatch.setattr('app.providers.clients.getClient', lambda provider: fake)
    # Keep the call self-contained: don't touch the real model profile store.
    monkeypatch.setattr(P, 'model_max_output_tokens', lambda provider, model: 4096)

    provider = {'id': 'openai', 'name': 'OpenAI', 'apiFormat': 'openaiChat'}

    result = asyncio.run(
        P.call_openai_workbench(
            messages=[{'role': 'user', 'content': 'hi'}],
            system_text='sys',
            model='gpt-5',
            tools=[],
            effort='high',
            provider=provider,
            emit=None,
            thinking_enabled=True,
        )
    )

    # The turn succeeds with the streamed content — no 400 surfaced to the user.
    assert 'error' not in result, result
    assert result.get('text') == 'hello'
    # First attempt carried the hint; the retry did not.
    assert len(fake.bodies) == 2
    assert fake.bodies[0].get('reasoning_effort') == 'high'
    assert 'reasoning_effort' not in fake.bodies[1]


def test_call_openai_workbench_no_retry_when_hint_absent(monkeypatch):
    """A 400 unrelated to reasoning_effort is returned as-is (single attempt)."""

    class _Client:
        def __init__(self) -> None:
            self.calls = 0

        def resolveApiKey(self) -> str:
            return 'test-key'

        async def chat_completions_stream(self, body: dict[str, object]):
            self.calls += 1
            yield {'type': 'error', 'error': {'message': 'Invalid model id'}, 'status': 400}

    client = _Client()
    monkeypatch.setattr('app.providers.clients.getClient', lambda provider: client)
    monkeypatch.setattr(P, 'model_max_output_tokens', lambda provider, model: 4096)
    # Provider whose heuristic returns False → no reasoning_effort attached at all.
    provider = {'id': 'custom-gw', 'name': 'Custom Gateway', 'apiFormat': 'openaiChat'}

    result = asyncio.run(
        P.call_openai_workbench(
            messages=[{'role': 'user', 'content': 'hi'}],
            system_text='sys',
            model='some-plain-model',
            tools=[],
            effort='high',
            provider=provider,
            emit=None,
            thinking_enabled=True,
        )
    )

    assert 'error' in result
    assert client.calls == 1  # no retry for an unrelated 400
