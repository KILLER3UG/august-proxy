"""Unit tests for workbench effort / thinking-budget helpers."""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from app.services.workbench.effort import (
    resolve_effective_effort,
    effort_to_thinking_budget,
    effort_to_prompt_instruction,
    effort_to_openai_reasoning_effort,
    provider_accepts_reasoning_effort,
)
from app.services.workbench import workbench as wb


@dataclass
class _FakeSession:
    metadata: dict[str, object] = field(default_factory=dict)


class TestResolveEffectiveEffort:
    def test_incoming_wins(self):
        session = _FakeSession(metadata={'effort': 'low'})
        assert resolve_effective_effort('high', session) == 'high'
        assert resolve_effective_effort('max', session) == 'max'

    def test_session_metadata_fallback(self):
        session = _FakeSession(metadata={'effort': 'high'})
        assert resolve_effective_effort(None, session) == 'high'
        assert resolve_effective_effort('', session) == 'high'
        assert resolve_effective_effort('invalid', session) == 'high'

    def test_default_medium(self):
        session = _FakeSession()
        assert resolve_effective_effort(None, session) == 'medium'
        assert resolve_effective_effort('', session) == 'medium'
        assert resolve_effective_effort('bogus', session) == 'medium'

    def test_invalid_session_effort_falls_through(self):
        session = _FakeSession(metadata={'effort': 'turbo'})
        assert resolve_effective_effort(None, session) == 'medium'


class TestEffortToThinkingBudget:
    """Mapping tables: effort → Anthropic thinking budget tokens."""

    @pytest.mark.parametrize(
        'effort,model_max,max_tokens,expected',
        [
            ('low', 32000, 8192, 4096),
            ('medium', 32000, 8192, 8192),
            ('high', 32000, 8192, 8192),  # min(16000, 8192)
            ('high', 32000, 32000, 16000),
            ('max', 32000, 8192, 16384),  # min(32000, 8192*2)
            ('max', 64000, 32000, 64000),  # min(64000, 64000)
            ('max', 64000, 16000, 32000),  # min(64000, 32000)
            ('unknown', 32000, 8192, 8192),  # default
        ],
    )
    def test_budget_table(self, effort: str, model_max: int, max_tokens: int, expected: int):
        assert effort_to_thinking_budget(effort, model_max=model_max, max_tokens=max_tokens) == expected

    def test_defaults(self):
        assert effort_to_thinking_budget('low') == 4096
        assert effort_to_thinking_budget('medium') == 8192
        assert effort_to_thinking_budget('high') == 8192  # capped by default max_tokens=8192
        assert effort_to_thinking_budget('max') == 16384


class TestEffortToPromptInstruction:
    """Mapping tables: effort → system-prompt instruction."""

    @pytest.mark.parametrize('effort', ['low', 'medium', 'high', 'max'])
    def test_instruction_table(self, effort: str):
        text = effort_to_prompt_instruction(effort)
        assert isinstance(text, str) and len(text) > 20
        if effort == 'low':
            assert 'minimal' in text.lower()
        if effort == 'max':
            assert 'maximum' in text.lower() or 'exhaustive' in text.lower()

    def test_unknown_defaults_to_medium(self):
        assert effort_to_prompt_instruction('unknown') == effort_to_prompt_instruction('medium')
        assert effort_to_prompt_instruction('') == effort_to_prompt_instruction('medium')


class TestProviderAcceptsReasoningEffort:
    def test_deepseek_and_openai(self):
        assert provider_accepts_reasoning_effort({'name': 'DeepSeek'}, 'deepseek-v4-flash')
        assert provider_accepts_reasoning_effort({'name': 'OpenAI API'}, 'gpt-4o')
        assert provider_accepts_reasoning_effort({'name': 'xAI'}, 'grok-4')

    def test_unknown_gateway_skipped_unless_model_hints(self):
        assert not provider_accepts_reasoning_effort({'name': 'OpenCode Zen'}, 'some-chat')
        assert provider_accepts_reasoning_effort({'name': 'OpenCode Zen'}, 'deepseek-reasoner')


class TestEffortToOpenaiReasoningEffort:
    """Mapping tables: August 4-level → OpenAI 3-level reasoning_effort."""

    @pytest.mark.parametrize(
        'effort,expected',
        [
            ('low', 'low'),
            ('medium', 'medium'),
            ('high', 'high'),
            ('max', 'high'),  # OpenAI has no "max"; collapse to high
            ('unknown', 'medium'),
            ('', 'medium'),
        ],
    )
    def test_openai_mapping_table(self, effort: str, expected: str):
        assert effort_to_openai_reasoning_effort(effort) == expected


class TestReexports:
    def test_camel_case_wrappers_on_workbench(self):
        """Back-compat: camelCase names remain importable from workbench."""
        session = _FakeSession(metadata={'effort': 'high'})
        assert wb.resolveEffectiveEffort('low', session) == resolve_effective_effort('low', session)
        assert wb.effortToThinkingBudget('high', maxTokens=32000) == effort_to_thinking_budget(
            'high', max_tokens=32000
        )
        assert wb.effortToPromptInstruction('max') == effort_to_prompt_instruction('max')
        assert wb.effortToOpenaiReasoningEffort('max') == effort_to_openai_reasoning_effort('max')
