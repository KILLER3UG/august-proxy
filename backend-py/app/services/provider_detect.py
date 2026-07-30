"""Provider detection — scan environment for configured API keys.

Part of Better Harness Plan Phase 5.2.
"""

from __future__ import annotations

import os

# Known provider environment variables and their default base URLs
_PROVIDER_ENV_MAP = [
    {'envVar': 'OPENAI_API_KEY', 'name': 'OpenAI', 'baseUrl': 'https://api.openai.com/v1', 'format': 'chat/completions'},
    {'envVar': 'ANTHROPIC_API_KEY', 'name': 'Anthropic', 'baseUrl': 'https://api.anthropic.com/v1', 'format': 'messages'},
    {'envVar': 'GEMINI_API_KEY', 'name': 'Google Gemini', 'baseUrl': 'https://generativelanguage.googleapis.com/v1beta', 'format': 'chat/completions'},
    {'envVar': 'GOOGLE_API_KEY', 'name': 'Google AI', 'baseUrl': 'https://generativelanguage.googleapis.com/v1beta', 'format': 'chat/completions'},
    {'envVar': 'GROQ_API_KEY', 'name': 'Groq', 'baseUrl': 'https://api.groq.com/openai/v1', 'format': 'chat/completions'},
    {'envVar': 'MISTRAL_API_KEY', 'name': 'Mistral', 'baseUrl': 'https://api.mistral.ai/v1', 'format': 'chat/completions'},
    {'envVar': 'DEEPSEEK_API_KEY', 'name': 'DeepSeek', 'baseUrl': 'https://api.deepseek.com/v1', 'format': 'chat/completions'},
    {'envVar': 'TOGETHER_API_KEY', 'name': 'Together AI', 'baseUrl': 'https://api.together.xyz/v1', 'format': 'chat/completions'},
    {'envVar': 'OPENROUTER_API_KEY', 'name': 'OpenRouter', 'baseUrl': 'https://openrouter.ai/api/v1', 'format': 'chat/completions'},
    {'envVar': 'XAI_API_KEY', 'name': 'xAI', 'baseUrl': 'https://api.x.ai/v1', 'format': 'chat/completions'},
]


def detect_providers() -> list[dict]:
    """Scan environment variables for configured API providers.

    Returns list of detected providers with pre-filled configuration.
    Never exposes the actual key value — only confirms presence.
    """
    detected = []
    for provider in _PROVIDER_ENV_MAP:
        key_value = os.environ.get(provider['envVar'], '').strip()
        if key_value:
            detected.append({
                'name': provider['name'],
                'envVar': provider['envVar'],
                'baseUrl': provider['baseUrl'],
                'format': provider['format'],
                'keyPrefix': key_value[:4] + '****',  # Safe preview only (4 chars max)
                'keyLength': len(key_value),
            })
    return detected
