"""Extract provider INFO dicts into provider_templates.json."""
import json
import os
import sys

# Add backend-py to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

PROVIDER_MODULES = [
    'anthropic', 'openaiApi', 'gemini', 'deepseek', 'openrouter',
    'bedrock', 'azure', 'minimax', 'minimaxCn', 'opencodeGo', 'opencodeZen',
    'kilo', 'copilot', 'cline', 'xai', 'gmi', 'zai', 'xiaomi', 'stepfun',
    'alibaba', 'kimi', 'nvidia', 'nous', 'novita', 'huggingface', 'arcee',
    'ollamaCloud', 'tokenrouter', 'aiGateway',
]

def kebab_case(name: str, fallback: str = '') -> str:
    """Convert a provider name to a kebab-case id."""
    import re
    # Check module-based overrides for ambiguous names
    overrides = {
        'minimax': 'minimax-global',
        'minimaxCn': 'minimax-china',
        'huggingface': 'huggingface',
        'aiGateway': 'ai-gateway',
        'openaiApi': 'openai-api',
        'ollamaCloud': 'ollama-cloud',
        'opencodeGo': 'opencode-go',
        'opencodeZen': 'opencode-zen',
        'tokenrouter': 'token-router',
        'minimaxCn': 'minimax-china',
    }
    mod_key = fallback
    if mod_key in overrides:
        return overrides[mod_key]
    # Remove parenthesized content (e.g., "(阶跃星辰)", "(Moonshot)")
    s = re.sub(r'\s*\(.*?\)', '', name)
    s = s.lower().replace('_', '-').replace(' ', '-')
    # Remove any non-ASCII / non-alphanumeric-dash chars
    s = re.sub(r'[^a-z0-9-]', '', s)
    s = re.sub(r'-+', '-', s).strip('-')
    return s

def convert(info: dict, mod_name: str = '') -> dict:
    """Convert an INFO dict to the template format."""
    return {
        'id': kebab_case(info.get('name', ''), fallback=mod_name),
        'name': info.get('name', ''),
        'displayName': info.get('display_name', info.get('name', '')),
        'description': info.get('description', ''),
        'baseUrl': info.get('base_url', ''),
        'apiFormat': info.get('api_mode', ''),
        'authType': info.get('auth_type', 'api_key'),
        'envVars': info.get('env_vars', []),
        'defaultModel': info.get('default_model', ''),
        'defaultMaxTokens': info.get('default_max_tokens', 4096),
        'signupUrl': info.get('signup_url', ''),
        'supportsHealthCheck': info.get('supports_health_check', False),
        'aliases': info.get('aliases', []),
        'fallbackModels': info.get('fallback_models', []),
        'defaultHeaders': info.get('default_headers', {}),
        'modelProfiles': info.get('model_profiles', {}),
    }

def main():
    templates = []
    errors = []
    
    for mod_name in PROVIDER_MODULES:
        try:
            mod = __import__(f'app.providers.{mod_name}', fromlist=['INFO'])
            info = mod.INFO
            template = convert(dict(info), mod_name=mod_name)
            templates.append(template)
        except Exception as e:
            errors.append(f'{mod_name}: {e}')
    
    if errors:
        print("Errors:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
    
    output_path = os.path.join(os.path.dirname(__file__), '..', 'app', 'providers', 'provider_templates.json')
    with open(output_path, 'w') as f:
        json.dump(templates, f, indent=2, ensure_ascii=False)
    
    print(f"Extracted {len(templates)} templates to {output_path}")
    if errors:
        print(f"({len(errors)} errors occurred)")

if __name__ == '__main__':
    main()
