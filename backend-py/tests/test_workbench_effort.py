"""Unit tests for workbench effort / thinking-budget helpers."""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from app.services.model_service import _deriveModelsUrl, get_max_output_tokens
from app.services.workbench.effort import (
    resolve_effective_effort,
    effort_to_thinking_budget,
    effort_to_prompt_instruction,
    effort_to_openai_reasoning_effort,
    provider_accepts_reasoning_effort,
    resolve_completion_limits,
    model_max_output_tokens,
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


class TestModelMaxOutputTokens:
    def test_profile_max_output_wins(self):
        provider = {
            'modelProfiles': {
                'claude-sonnet-4': {'maxOutputTokens': 64000, 'contextWindow': 200000},
            }
        }
        assert get_max_output_tokens('claude-sonnet-4', provider) == 64000
        assert model_max_output_tokens(provider, 'claude-sonnet-4') == 64000

    def test_prefix_profile(self):
        provider = {
            'modelProfiles': {
                'claude-': {'maxOutputTokens': 32000},
            }
        }
        assert get_max_output_tokens('claude-opus-4', provider) == 32000

    def test_claude_family_default_without_profile(self):
        # Family default lives in model_service, not workbench.
        assert get_max_output_tokens('claude-sonnet-4-7', None) == 64000

    def test_generic_default(self):
        assert get_max_output_tokens('some-chat-model', None) == 16384


class TestResolveCompletionLimits:
    def test_max_tokens_is_model_ceiling_unchanged(self):
        budget, max_tokens = resolve_completion_limits('medium', max_output_tokens=64000)
        assert max_tokens == 64000
        assert budget == int(64000 * 0.15)
        assert max_tokens > budget

    def test_low_is_fraction_not_workbench_constant(self):
        budget, max_tokens = resolve_completion_limits('low', max_output_tokens=64000)
        assert max_tokens == 64000
        assert budget == int(64000 * 0.05)

    def test_max_leaves_answer_headroom(self):
        budget, max_tokens = resolve_completion_limits('max', max_output_tokens=64000)
        assert max_tokens == 64000
        # 75% think, but headroom reserves 25% → thinking_cap = 75%
        assert budget == int(64000 * 0.75)
        assert max_tokens - budget >= int(64000 * 0.25)

    def test_no_absolute_8192_ceiling(self):
        budget, max_tokens = resolve_completion_limits('high', max_output_tokens=100_000)
        assert max_tokens == 100_000
        assert budget == int(100_000 * 0.35)


class TestEffortToThinkingBudget:
    def test_scales_with_model_max(self):
        assert effort_to_thinking_budget('low', model_max=64000) == int(64000 * 0.05)
        assert effort_to_thinking_budget('medium', model_max=64000) == int(64000 * 0.15)
        assert effort_to_thinking_budget('high', model_max=32000) == int(32000 * 0.35)

    def test_legacy_extra_cap(self):
        # Optional max_tokens arg only further clamps the model-derived budget.
        assert effort_to_thinking_budget('high', model_max=64000, max_tokens=1000) == 1000


class TestEffortToPromptInstruction:
    @pytest.mark.parametrize('effort', ['low', 'medium', 'high', 'max'])
    def test_instruction_table(self, effort: str):
        text = effort_to_prompt_instruction(effort)
        assert isinstance(text, str) and len(text) > 20
        if effort == 'low':
            assert 'short' in text.lower() or 'extremely' in text.lower()
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

    def test_opencode_never_gets_reasoning_effort(self):
        # Even deepseek-* ids — OpenCode Console rejects unknown extras.
        assert not provider_accepts_reasoning_effort({'name': 'OpenCode Zen'}, 'some-chat')
        assert not provider_accepts_reasoning_effort(
            {'name': 'OpenCode Zen'}, 'deepseek-reasoner'
        )
        assert not provider_accepts_reasoning_effort(
            {'name': 'opencode-go'}, 'deepseek-v4-flash'
        )

    def test_unknown_gateway_uses_model_hints(self):
        assert provider_accepts_reasoning_effort({'name': 'Custom Proxy'}, 'deepseek-reasoner')
        assert provider_accepts_reasoning_effort({'name': 'Custom Proxy'}, 'nemotron-3-ultra')
        assert not provider_accepts_reasoning_effort({'name': 'Custom Proxy'}, 'some-chat')


class TestEffortToOpenaiReasoningEffort:
    @pytest.mark.parametrize(
        'effort,expected',
        [
            ('low', 'low'),
            ('medium', 'medium'),
            ('high', 'high'),
            ('max', 'high'),
            ('unknown', 'medium'),
            ('', 'medium'),
        ],
    )
    def test_openai_mapping_table(self, effort: str, expected: str):
        assert effort_to_openai_reasoning_effort(effort) == expected


class TestReexports:
    def test_camel_case_wrappers_on_workbench(self):
        session = _FakeSession(metadata={'effort': 'high'})
        assert wb.resolveEffectiveEffort('low', session) == resolve_effective_effort('low', session)
        assert wb.effortToThinkingBudget('high', modelMax=32000) == effort_to_thinking_budget(
            'high', model_max=32000
        )
        assert wb.effortToPromptInstruction('max') == effort_to_prompt_instruction('max')
        assert wb.effortToOpenaiReasoningEffort('max') == effort_to_openai_reasoning_effort('max')


class TestDeriveModelsUrl:
    def test_keeps_v1_prefix(self):
        assert (
            _deriveModelsUrl('https://opencode.ai/zen/v1') == 'https://opencode.ai/zen/v1/models'
        )
        assert (
            _deriveModelsUrl('https://api.openai.com/v1') == 'https://api.openai.com/v1/models'
        )

    def test_strips_chat_completions_only(self):
        assert (
            _deriveModelsUrl('https://opencode.ai/zen/v1/chat/completions')
            == 'https://opencode.ai/zen/v1/models'
        )
