"""API format normalization — UI kebab-case vs workbench camelCase."""

from __future__ import annotations

from app.adapters.openai import toOpenaiCompatibleTargetUrl
from app.providers.api_format import (
    anthropic_v1_base,
    is_anthropic_api_format,
    is_openai_api_format,
    join_provider_url,
    normalize_api_format,
    normalize_provider_base_url,
    provider_endpoint_url,
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


def test_normalize_strips_leaf_endpoints():
    assert (
        normalize_provider_base_url('https://opencode.ai/zen/v1/chat/completions')
        == 'https://opencode.ai/zen/v1'
    )
    assert (
        normalize_provider_base_url('https://api.kilo.ai/api/gateway/chat/completions/')
        == 'https://api.kilo.ai/api/gateway'
    )
    assert normalize_provider_base_url('https://api.openai.com/v1') == 'https://api.openai.com/v1'


def test_base_plus_format_opencode_and_kilo():
    assert (
        join_provider_url('https://opencode.ai/zen/v1', 'chat', 'completions')
        == 'https://opencode.ai/zen/v1/chat/completions'
    )
    assert (
        provider_endpoint_url('https://api.kilo.ai/api/gateway', 'openaiChat', kind='chat')
        == 'https://api.kilo.ai/api/gateway/chat/completions'
    )
    assert (
        toOpenaiCompatibleTargetUrl('https://api.kilo.ai/api/gateway')
        == 'https://api.kilo.ai/api/gateway/chat/completions'
    )


def test_anthropic_format_owns_v1_leaf():
    # Format appends v1/messages — base is host only; trailing /v1 is not doubled.
    assert anthropic_v1_base('https://api.anthropic.com') == 'https://api.anthropic.com'
    assert anthropic_v1_base('https://api.anthropic.com/v1') == 'https://api.anthropic.com'
    assert anthropic_v1_base('') == 'https://api.anthropic.com'
    assert (
        provider_endpoint_url('https://api.anthropic.com', 'anthropicMessages', kind='messages')
        == 'https://api.anthropic.com/v1/messages'
    )
    assert (
        provider_endpoint_url('https://api.anthropic.com/v1', 'anthropicMessages', kind='messages')
        == 'https://api.anthropic.com/v1/messages'
    )
    assert (
        provider_endpoint_url('https://api.minimax.chat', 'anthropicMessages', kind='messages')
        == 'https://api.minimax.chat/v1/messages'
    )
    assert (
        provider_endpoint_url('https://api.minimax.chat/v1', 'anthropicMessages', kind='chat')
        == 'https://api.minimax.chat/v1/messages'
    )
    assert (
        provider_endpoint_url('https://custom.gateway.example', 'anthropicMessages', kind='chat')
        == 'https://custom.gateway.example/v1/messages'
    )
    assert (
        provider_endpoint_url('https://api.anthropic.com', 'anthropicMessages', kind='models')
        == 'https://api.anthropic.com/v1/models'
    )


def test_models_url_exact_base_no_v1_invent():
    assert (
        provider_endpoint_url('https://api.kilo.ai/api/gateway', 'openaiChat', kind='models')
        == 'https://api.kilo.ai/api/gateway/models'
    )
    assert (
        provider_endpoint_url('https://opencode.ai/zen/v1', 'openaiChat', kind='models')
        == 'https://opencode.ai/zen/v1/models'
    )
