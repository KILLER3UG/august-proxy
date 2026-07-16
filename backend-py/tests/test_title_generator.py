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
