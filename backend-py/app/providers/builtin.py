"""
Register all built-in providers into the registry.
"""

from app.providers import registry


def register_all() -> None:
    """Import and register every built-in provider."""
    from app.providers import (
        anthropic, openai_api, gemini, deepseek, openrouter,
        bedrock, azure, minimax, minimax_cn,
        opencode_go, opencode_zen, kilo,
        copilot, cline, xai, gmi, zai, xiaomi, stepfun,
        alibaba, kimi, nvidia, nous, novita,
        huggingface, arcee, ollama_cloud,
        tokenrouter, ai_gateway,
    )

    modules = [
        anthropic, openai_api, gemini, deepseek, openrouter,
        bedrock, azure, minimax, minimax_cn,
        opencode_go, opencode_zen, kilo,
        copilot, cline, xai, gmi, zai, xiaomi, stepfun,
        alibaba, kimi, nvidia, nous, novita,
        huggingface, arcee, ollama_cloud,
        tokenrouter, ai_gateway,
    ]

    for mod in modules:
        registry.register(mod.INFO)
