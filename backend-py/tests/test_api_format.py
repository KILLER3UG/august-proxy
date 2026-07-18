"""API format normalization — UI kebab-case vs workbench camelCase."""

from __future__ import annotations

from app.providers.api_format import (
    is_anthropic_api_format,
    is_openai_api_format,
    normalize_api_format,
)
from app.services.workbench.providers import is_anthropic_provider, is_openai_provider


def test_normalize_ui_dropdown_values():
    assert normalize_api_format('openai-chat') == 'openaiChat'
    assert normalize_api_format('anthropic') == 'anthropicMessages'
    assert normalize_api_format('openai-responses') == 'openaiResponses'


def test_normalize_canonical_passthrough():
    assert normalize_api_format('openaiChat') == 'openaiChat'
    assert normalize_api_format('anthropicMessages') == 'anthropicMessages'


def test_opencode_zen_style_provider_is_openai():
    provider = {
        'name': 'Opencode Zen',
        'apiMode': 'openai-chat',
        'baseUrl': 'https://opencode.ai/zen/v1',
    }
    assert is_openai_provider(provider) is True
    assert is_anthropic_provider(provider) is False
    assert is_openai_api_format('openai-chat') is True
    assert is_anthropic_api_format('openai-chat') is False


def test_resolver_normalizes_api_mode():
    from app.providers.resolver import entry_to_provider_dict

    out = entry_to_provider_dict(
        {
            'id': 'opencode-zen-1',
            'name': 'Opencode Zen',
            'apiFormat': 'openai-chat',
            'baseUrl': 'https://opencode.ai/zen/v1',
            'apiKey': 'sk-test',
        }
    )
    assert out['apiMode'] == 'openaiChat'
