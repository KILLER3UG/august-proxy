"""Batch provider config generator."""
import os

PROVIDERS = [
    ("anthropic", "Anthropic", "claude-sonnet-4-7", 8192, "anthropicMessages", "https://api.anthropic.com"),
    ("openai_api", "OpenAI API", "gpt-4o", 16384, "codexResponses", "https://api.openai.com/v1"),
    ("gemini", "Google AI Studio", "gemini-2.0-flash", 8192, "openaiChat", "https://generativelanguage.googleapis.com/v1beta/openai"),
    ("deepseek", "DeepSeek", "deepseek-chat", 8192, "openaiChat", "https://api.deepseek.com/v1"),
    ("openrouter", "OpenRouter", "gpt-4o", 16384, "openaiChat", "https://openrouter.ai/api/v1"),
    ("bedrock", "AWS Bedrock", "anthropic.claude-v2", 8192, "bedrockConverse", None),
    ("azure", "Azure AI Foundry", "gpt-4o", 16384, "openaiChat", None),
    ("minimax", "MiniMax (Global)", "minimax-m3", 64000, "anthropicMessages", "https://api.minimax.chat/v1"),
    ("minimax_cn", "MiniMax (China)", "minimax-m3", 64000, "anthropicMessages", "https://api.minimax.chat/v1"),
    ("opencode_go", "OpenCode Go", "deepseek-v4", 64000, "openaiChat", "https://opencode.ai/zen/go/v1"),
    ("opencode_zen", "OpenCode Zen", "deepseek-v4-flash", 64000, "openaiChat", "https://opencode.ai/zen/go/v1"),
    ("kilo", "KiloCode", "deepseek-v4-flash", 64000, "openaiChat", "https://api.kilocode.ai/v1"),
    ("copilot", "GitHub Copilot", "gpt-4o", 8192, "openaiChat", None),
    ("cline", "Cline AI", "gpt-4o", 8192, "openaiChat", None),
    ("xai", "xAI", "grok-2", 8192, "codexResponses", "https://api.x.ai/v1"),
    ("gmi", "GMI Cloud", "gpt-4o", 8192, "openaiChat", None),
    ("zai", "Zhipu AI (GLM)", "glm-5", 8192, "openaiChat", "https://open.bigmodel.cn/api/paas/v4"),
    ("xiaomi", "Xiaomi MiMo", "gpt-4o", 8192, "openaiChat", None),
    ("stepfun", "StepFun", "step-3.7-flash", 8192, "openaiChat", "https://api.stepfun.com/v1"),
    ("alibaba", "Alibaba Cloud (Qwen)", "qwen-max", 8192, "openaiChat", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
    ("kimi", "Kimi (Moonshot)", "kimi-k2.5", 128000, "openaiChat", "https://api.moonshot.cn/v1"),
    ("nvidia", "NVIDIA NIM", "meta-llama-3.1-405b", 8192, "openaiChat", "https://integrate.api.nvidia.com/v1"),
    ("nous", "Nous Research (Portal)", "hermes-4", 32768, "openaiChat", None),
    ("novita", "Novita AI", "gpt-4o", 8192, "openaiChat", "https://api.novita.ai/v1"),
    ("huggingface", "Hugging Face", "gpt-4o", 8192, "openaiChat", None),
    ("arcee", "Arcee AI", "gpt-4o", 8192, "openaiChat", None),
    ("ollama_cloud", "Ollama Cloud", "gpt-4o", 8192, "openaiChat", None),
    ("tokenrouter", "Token Router", "gpt-4o", 8192, "openaiChat", None),
    ("custom", "Custom (OpenAI-compatible)", "gpt-4o", 8192, "openaiChat", None),
    ("ai_gateway", "AI Gateway", "gpt-4o", 8192, "openaiChat", None),
]

TEMPLATE = '''"""
Provider config for {name}.
"""

from __future__ import annotations

from typing import Optional

INFO = {{
    "name": "{name}",
    "default_model": "{model}",
    "default_max_tokens": {tokens},
    "api_mode": "{mode}",
}}


def resolve_base_url() -> Optional[str]:
    {base_url_return}


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
'''

BASE_DIR = r"C:\Dev\august-proxy\backend-py\app\providers"

for file_name, display_name, model, tokens, mode, base_url in PROVIDERS:
    if base_url:
        base_url_return = f'return "{base_url}"'
    else:
        base_url_return = "return None"
    
    content = TEMPLATE.format(
        name=display_name,
        model=model,
        tokens=tokens,
        mode=mode,
        base_url_return=base_url_return,
    )
    
    path = os.path.join(BASE_DIR, f"{file_name}.py")
    with open(path, "w") as f:
        f.write(content)
    print(f"Created: {file_name}.py")

# Create aliases.py
with open(os.path.join(BASE_DIR, "aliases.py"), "w") as f:
    f.write('''"""
Provider alias map — short names to provider module names.
"""

PROVIDER_ALIASES: dict[str, str] = {
    "claude": "anthropic",
    "gpt": "openai_api",
    "gemini": "gemini",
    "deepseek": "deepseek",
    "openrouter": "openrouter",
    "kimi": "kimi",
    "qwen": "alibaba",
    "glm": "zai",
}


def normalize(name: str) -> str:
    """Resolve a short alias to the canonical provider module name."""
    return PROVIDER_ALIASES.get(name.lower(), name)
''')
print("Created: aliases.py")

# Create builtin.py
with open(os.path.join(BASE_DIR, "builtin.py"), "w") as f:
    f.write('''"""
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
''')
print("Created: builtin.py")

print(f"\\nDone: {len(PROVIDERS) + 2} files created")
