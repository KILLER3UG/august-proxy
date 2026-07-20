"""Regression: do not enable Anthropic extended thinking on non-Claude models."""

from app.services.workbench.providers import supports_thinking


def test_claude_prefix_profile_enables_thinking():
    provider = {
        'name': 'Anthropic',
        'modelProfiles': {
            'claude-': {'supportsReasoning': True},
            '*': {'supportsReasoning': False},
        },
    }
    assert supports_thinking(provider, 'claude-sonnet-4-7') is True


def test_wildcard_only_enables_for_claude_ids():
    provider = {'name': 'Anthropic', 'modelProfiles': {'*': {'supportsReasoning': True}}}
    assert supports_thinking(provider, 'claude-sonnet-4-7') is True
    assert supports_thinking(provider, 'minimax-m3') is False


def test_minimax_does_not_get_thinking_from_star():
    provider = {
        'name': 'MiniMax',
        'apiMode': 'anthropicMessages',
        'modelProfiles': {'*': {'supportsReasoning': True}},
    }
    assert supports_thinking(provider, 'minimax-m3') is False


def test_modern_claude_defaults_on_without_profiles():
    provider = {'name': 'Anthropic', 'apiMode': 'anthropicMessages'}
    assert supports_thinking(provider, 'claude-sonnet-4-6') is True
    assert supports_thinking(provider, 'claude-opus-4') is True


def test_legacy_claude_defaults_off_without_profiles():
    provider = {'name': 'Anthropic', 'apiMode': 'anthropicMessages'}
    assert supports_thinking(provider, 'claude-3-5-sonnet-20241022') is False
    assert supports_thinking(provider, 'claude-3-haiku-20240307') is False
