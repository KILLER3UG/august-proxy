"""
Provider alias map — short names to provider module names.
"""

PROVIDER_ALIASES: dict[str, str] = {
    'claude': 'anthropic',
    'gpt': 'openai_api',
    'gemini': 'gemini',
    'deepseek': 'deepseek',
    'openrouter': 'openrouter',
    'kimi': 'kimi',
    'qwen': 'alibaba',
    'glm': 'zai',
}


def normalize(name: str) -> str:
    """Resolve a short alias to the canonical provider module name."""
    return PROVIDER_ALIASES.get(name.lower(), name)
