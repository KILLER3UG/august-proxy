"""
Register all built-in providers into the registry.
"""
from app.providers import registry

def registerAll() -> None:
    """Import and register every built-in provider."""
    from app.providers import anthropic, openaiApi, gemini, deepseek, openrouter, bedrock, azure, minimax, minimaxCn, opencodeGo, opencodeZen, kilo, copilot, cline, xai, gmi, zai, xiaomi, stepfun, alibaba, kimi, nvidia, nous, novita, huggingface, arcee, ollamaCloud, tokenrouter, aiGateway
    modules = [anthropic, openaiApi, gemini, deepseek, openrouter, bedrock, azure, minimax, minimaxCn, opencodeGo, opencodeZen, kilo, copilot, cline, xai, gmi, zai, xiaomi, stepfun, alibaba, kimi, nvidia, nous, novita, huggingface, arcee, ollamaCloud, tokenrouter, aiGateway]
    for mod in modules:
        registry.register(mod.INFO)