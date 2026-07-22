"""Batch provider config generator."""

import os

PROVIDERS = [
    ('anthropic', 'Anthropic', 'claude-sonnet-4-7', 8192, 'anthropicMessages', 'https://api.anthropic.com'),
    ('openai_api', 'OpenAI API', 'gpt-4o', 16384, 'codexResponses', 'https://api.openai.com/v1'),
    ('deepseek', 'DeepSeek', 'deepseek-chat', 8192, 'openaiChat', 'https://api.deepseek.com/v1'),
    ('openrouter', 'OpenRouter', 'gpt-4o', 16384, 'openaiChat', 'https://openrouter.ai/api/v1'),
    ('azure', 'Azure AI Foundry', 'gpt-4o', 16384, 'openaiChat', None),
    ('opencode_go', 'OpenCode Go', 'deepseek-v4', 64000, 'openaiChat', 'https://opencode.ai/zen/go/v1'),
    ('opencode_zen', 'OpenCode Zen', 'deepseek-v4-flash', 64000, 'openaiChat', 'https://opencode.ai/zen/go/v1'),
    ('kilo', 'KiloCode', 'deepseek-v4-flash', 64000, 'openaiChat', 'https://api.kilocode.ai/v1'),
    ('copilot', 'GitHub Copilot', 'gpt-4o', 8192, 'openaiChat', None),
    ('cline', 'Cline AI', 'gpt-4o', 8192, 'openaiChat', None),
    ('xai', 'xAI', 'grok-2', 8192, 'codexResponses', 'https://api.x.ai/v1'),
    ('gmi', 'GMI Cloud', 'gpt-4o', 8192, 'openaiChat', None),
    ('zai', 'Zhipu AI (GLM)', 'glm-5', 8192, 'openaiChat', 'https://open.bigmodel.cn/api/paas/v4'),
    ('xiaomi', 'Xiaomi MiMo', 'gpt-4o', 8192, 'openaiChat', None),
    ('stepfun', 'StepFun', 'step-3.7-flash', 8192, 'openaiChat', 'https://api.stepfun.com/v1'),
    (
        'alibaba',
        'Alibaba Cloud (Qwen)',
        'qwen-max',
        8192,
        'openaiChat',
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
    ),
    ('kimi', 'Kimi (Moonshot)', 'kimi-k2.5', 128000, 'openaiChat', 'https://api.moonshot.cn/v1'),
    ('nvidia', 'NVIDIA NIM', 'meta-llama-3.1-405b', 8192, 'openaiChat', 'https://integrate.api.nvidia.com/v1'),
    ('nous', 'Nous Research (Portal)', 'hermes-4', 32768, 'openaiChat', None),
    ('novita', 'Novita AI', 'gpt-4o', 8192, 'openaiChat', 'https://api.novita.ai/v1'),
    ('huggingface', 'Hugging Face', 'gpt-4o', 8192, 'openaiChat', None),
    ('arcee', 'Arcee AI', 'gpt-4o', 8192, 'openaiChat', None),
    ('ollama_cloud', 'Ollama Cloud', 'gpt-4o', 8192, 'openaiChat', None),
    ('tokenrouter', 'Token Router', 'gpt-4o', 8192, 'openaiChat', None),
    ('custom', 'Custom (OpenAI-compatible)', 'gpt-4o', 8192, 'openaiChat', None),
    ('ai_gateway', 'AI Gateway', 'gpt-4o', 8192, 'openaiChat', None),
]
TEMPLATE = '"""\nProvider config for {name}.\n"""\n\nfrom __future__ import annotations\n\nfrom typing import Optional\n\nINFO = {{\n    "name": "{name}",\n    "default_model": "{model}",\n    "default_max_tokens": {tokens},\n    "api_mode": "{mode}",\n}}\n\n\ndef resolve_base_url() -> Optional[str]:\n    {base_url_return}\n\n\ndef resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:\n    return env_key\n'
BASE_DIR = 'C:\\Dev\\august-proxy\\backend-py\\app\\providers'
for fileName, displayName, model, tokens, mode, base_url in PROVIDERS:
    if base_url:
        baseUrlReturn = f'return "{base_url}"'
    else:
        baseUrlReturn = 'return None'
    content = TEMPLATE.format(name=displayName, model=model, tokens=tokens, mode=mode, base_url_return=baseUrlReturn)
    path = os.path.join(BASE_DIR, f'{fileName}.py')
    with open(path, 'w') as f:
        f.write(content)
    print(f'Created: {fileName}.py')
with open(os.path.join(BASE_DIR, 'aliases.py'), 'w') as f:
    f.write(
        '"""\nProvider alias map — short names to provider module names.\n"""\n\nPROVIDER_ALIASES: dict[str, str] = {\n    "claude": "anthropic",\n    "gpt": "openai_api",\n    "deepseek": "deepseek",\n    "openrouter": "openrouter",\n    "kimi": "kimi",\n    "qwen": "alibaba",\n    "glm": "zai",\n}\n\n\ndef normalize(name: str) -> str:\n    """Resolve a short alias to the canonical provider module name."""\n    return PROVIDER_ALIASES.get(name.lower(), name)\n'
    )
print('Created: aliases.py')
with open(os.path.join(BASE_DIR, 'builtin.py'), 'w') as f:
    f.write(
        '"""\nRegister all built-in providers into the registry.\n"""\n\nfrom app.providers import registry\n\n\ndef register_all() -> None:\n    """Import and register every built-in provider."""\n    from app.providers import (\n        anthropic, openai_api, deepseek, openrouter,\n        azure,\n        opencode_go, opencode_zen, kilo,\n        copilot, cline, xai, gmi, zai, xiaomi, stepfun,\n        alibaba, kimi, nvidia, nous, novita,\n        huggingface, arcee, ollama_cloud,\n        tokenrouter, ai_gateway,\n    )\n\n    modules = [\n        anthropic, openai_api, deepseek, openrouter,\n        azure,\n        opencode_go, opencode_zen, kilo,\n        copilot, cline, xai, gmi, zai, xiaomi, stepfun,\n        alibaba, kimi, nvidia, nous, novita,\n        huggingface, arcee, ollama_cloud,\n        tokenrouter, ai_gateway,\n    ]\n\n    for mod in modules:\n        registry.register(mod.INFO)\n'
    )
print('Created: builtin.py')
print(f'\\nDone: {len(PROVIDERS) + 2} files created')
