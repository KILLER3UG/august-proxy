"""Canonical provider API format ids + UI/legacy aliases.

The desktop provider form historically sent kebab-case values
(``openai-chat``, ``anthropic``, …) while workbench checks only camelCase
(``openaiChat``, ``anthropicMessages``). Normalize at the boundary so users
never hit "Unsupported API format" after picking a dropdown option.
"""

from __future__ import annotations

# Formats understood by workbench / proxy clients (incl. specialized clients).
VALID_API_FORMATS = frozenset({
    'openaiChat',
    'anthropicMessages',
    'openaiResponses',
    'codexResponses',
    'geminiOpenai',
    'minimax',
    'bedrockConverse',
})

_FORMAT_ALIASES: dict[str, str] = {
    'openai': 'openaiChat',
    'openai-chat': 'openaiChat',
    'openai_chat': 'openaiChat',
    'openaichat': 'openaiChat',
    'chat': 'openaiChat',
    'anthropic': 'anthropicMessages',
    'anthropic-messages': 'anthropicMessages',
    'anthropic_messages': 'anthropicMessages',
    'anthropicmessages': 'anthropicMessages',
    'messages': 'anthropicMessages',
    'openai-responses': 'openaiResponses',
    'openai_responses': 'openaiResponses',
    'openairesponses': 'openaiResponses',
    'responses': 'openaiResponses',
    'codex': 'codexResponses',
    'codex-responses': 'codexResponses',
    'codex_responses': 'codexResponses',
    'codexresponses': 'codexResponses',
    'gemini': 'geminiOpenai',
    'gemini-openai': 'geminiOpenai',
    'gemini_openai': 'geminiOpenai',
    'geminiopenai': 'geminiOpenai',
    'bedrock': 'bedrockConverse',
    'bedrock-converse': 'bedrockConverse',
    'bedrock_converse': 'bedrockConverse',
    'bedrockconverse': 'bedrockConverse',
    'minimax-cn': 'minimax',
    'minimax_cn': 'minimax',
}


def normalize_api_format(api_format: object | None, *, default: str = 'openaiChat') -> str:
    """Map UI/legacy format strings to a canonical apiFormat/apiMode value."""
    raw = str(api_format or '').strip()
    if not raw:
        return default
    if raw in VALID_API_FORMATS:
        return raw
    mapped = _FORMAT_ALIASES.get(raw.lower())
    if mapped:
        return mapped
    # Unknown values: keep default rather than failing closed as "unsupported".
    return default


def is_openai_api_format(api_format: object | None) -> bool:
    return normalize_api_format(api_format) in ('openaiChat', 'openaiResponses', 'codexResponses')


def is_anthropic_api_format(api_format: object | None) -> bool:
    return normalize_api_format(api_format) == 'anthropicMessages'
