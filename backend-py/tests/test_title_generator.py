"""Tests for LLM session title generation helpers."""

from __future__ import annotations

import pytest
from app.services.workbench.title_generator import (
    count_user_messages,
    first_exchange_texts,
    message_plain_text,
    sanitize_generated_title,
)


class TestSanitizeGeneratedTitle:
    def test_strips_quotes_and_prefix(self):
        assert sanitize_generated_title('Title: "Fix login bug"') == 'Fix login bug'

    def test_strips_trailing_punctuation(self):
        assert sanitize_generated_title('Refactor auth layer.') == 'Refactor auth layer'

    def test_strips_think_blocks(self):
        raw = '<think>hmm</think>\nDatabase migration plan'
        assert sanitize_generated_title(raw) == 'Database migration plan'

    def test_truncates_long_titles(self):
        long = 'A' * 100
        out = sanitize_generated_title(long, max_len=20)
        assert len(out) <= 20
        assert out.endswith('…')

    def test_empty_returns_empty(self):
        assert sanitize_generated_title('   ') == ''


class TestFirstExchangeTexts:
    def test_extracts_first_user_and_assistant(self):
        messages = [
            {'role': 'user', 'content': 'Help me rename files'},
            {'role': 'assistant', 'content': 'Sure — which directory?'},
            {'role': 'user', 'content': 'src/'},
        ]
        assert first_exchange_texts(messages) == (
            'Help me rename files',
            'Sure — which directory?',
        )

    def test_handles_content_blocks(self):
        messages = [
            {
                'role': 'user',
                'content': [{'type': 'text', 'text': 'Add dark mode'}],
            },
            {
                'role': 'assistant',
                'content': [
                    {'type': 'thinking', 'text': 'plan…'},
                    {'type': 'text', 'text': 'I can wire a theme toggle.'},
                ],
            },
        ]
        assert first_exchange_texts(messages) == (
            'Add dark mode',
            'I can wire a theme toggle.',
        )

    def test_returns_none_without_assistant(self):
        assert first_exchange_texts([{'role': 'user', 'content': 'hi'}]) is None

    def test_count_user_messages(self):
        msgs = [
            {'role': 'user', 'content': 'a'},
            {'role': 'assistant', 'content': 'b'},
            {'role': 'user', 'content': 'c'},
        ]
        assert count_user_messages(msgs) == 2


class TestMessagePlainText:
    def test_string_content(self):
        assert message_plain_text({'role': 'user', 'content': '  hello  '}) == 'hello'

    def test_none_safe(self):
        assert message_plain_text(None) == ''


@pytest.mark.asyncio
async def test_generate_falls_back_without_provider():
    from app.services.workbench.title_generator import generate_session_title

    title = await generate_session_title(
        'Please help me debug the flaky checkout test',
        'I will inspect the failing assertion.',
        provider=None,
        model='',
    )
    # Fallback is truncated first-user-message snippet — not the assistant reply.
    assert 'checkout' in title.lower() or 'debug' in title.lower()
    assert 'flaky' in title.lower() or 'checkout' in title.lower()


@pytest.mark.asyncio
async def test_llm_title_uses_client_generate(monkeypatch):
    """Anthropic (and others) expose generate() — must not require chat_completions."""
    from app.services.workbench import title_generator as tg

    class FakeClient:
        config: dict[str, object] = {}

        def resolveApiKey(self):
            return 'sk-test'

        async def generate(self, prompt: str, system: str | None = None) -> str:
            assert system
            assert 'User:' in prompt
            return 'Fix checkout flake'

    monkeypatch.setattr(
        'app.providers.clients.getClient',
        lambda _p: FakeClient(),
    )
    title = await tg._llm_title(
        'Please help me debug the flaky checkout test',
        'I will inspect the failing assertion.',
        provider={'id': 'anthropic', 'apiMode': 'anthropicMessages'},
        model='claude-sonnet-4',
    )
    assert title == 'Fix checkout flake'


def test_is_fallback_title_matches_derived_snippet():
    from app.services.workbench.sessions import derive_title_from_message
    from app.services.workbench.title_generator import _is_fallback_title

    user = 'Please help me debug the flaky checkout test that fails intermittently'
    derived = derive_title_from_message(user)
    assert _is_fallback_title(derived, user)
    assert not _is_fallback_title('Checkout flake investigation', user)


# ── M7 (plan §3.8) ─────────────────────────────────────────────────────────


def test_default_title_is_new_chat_not_timestamp():
    """Item 4: creation title is a neutral placeholder, not a timestamp."""
    from app.services.workbench.sessions import (
        _default_session_title,
        is_placeholder_title,
    )

    title = _default_session_title()
    assert title == 'New chat'
    assert is_placeholder_title(title)


def test_placeholder_title_recognizes_legacy_and_new_formats():
    from app.services.workbench.sessions import is_placeholder_title

    # Legacy date-stamped defaults still count as placeholders.
    assert is_placeholder_title('Chat 2026-07-15 14:30')
    assert is_placeholder_title('Chat 2026-07-15 14:30 UTC')
    assert is_placeholder_title('New chat')
    assert is_placeholder_title('')
    assert is_placeholder_title(None)
    # Real titles do not.
    assert not is_placeholder_title('Fix checkout flake')
    assert not is_placeholder_title('Chat about the deployment pipeline')


def test_derive_title_skips_slash_commands_and_short():
    from app.services.workbench.sessions import derive_title_from_message

    assert derive_title_from_message('/circuit build a divider') == ''
    assert derive_title_from_message('a') == ''
    assert derive_title_from_message('Refactor the auth middleware please') == (
        'Refactor the auth middleware please'
    )


def test_resolve_title_target_falls_back_without_config():
    """Item 3: empty titleModel → the turn's own provider/model is kept."""
    from app.services.workbench.title_generator import _resolve_title_target

    provider = {'id': 'p', 'defaultModel': 'm'}
    out_provider, out_model = _resolve_title_target(provider, 'turn-model')
    assert out_provider is provider
    assert out_model == 'turn-model'


def test_llm_title_no_api_key_gate(monkeypatch):
    """Item 2: a keyless gateway (resolveApiKey → '') must still title."""
    from app.services.workbench import title_generator

    class _FakeResp:
        is_error = False
        body_json = {
            'choices': [{'message': {'content': 'Keyless Gateway Title'}}]
        }

    class _FakeClient:
        config: dict = {}

        def resolveApiKey(self):
            return ''  # keyless gateway

        async def generate(self, prompt, system=''):
            return 'Keyless Gateway Title'

        async def chat_completions(self, body):
            return _FakeResp()

    monkeypatch.setattr(
        'app.providers.clients.getClient', lambda provider: _FakeClient()
    )
    import asyncio

    title = asyncio.run(
        title_generator._llm_title(
            'How do I reset my password?',
            'Go to settings and click reset.',
            provider={'id': 'local'},
            model='local-model',
        )
    )
    assert title == 'Keyless Gateway Title'
