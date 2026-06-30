"""
Provider config for AWS Bedrock.
"""
from __future__ import annotations
INFO: dict[str, object] = {'name': 'AWS Bedrock', 'aliases': ['aws'], 'display_name': 'AWS Bedrock', 'description': 'AWS Bedrock Converse API — Claude and other models via AWS', 'api_mode': 'bedrock_converse', 'env_vars': ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_BEDROCK_BASE_URL'], 'auth_type': 'aws_sdk', 'default_model': 'anthropic.claude-sonnet-4-20250514', 'default_max_tokens': 8192, 'signup_url': 'https://aws.amazon.com/bedrock', 'model_profiles': {'claude': {'supportsReasoning': True, 'supportsThinking': True, 'combinedBudget': False, 'contextWindow': 200000, 'maxOutputTokens': 8192}, '*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 200000, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return ''

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey