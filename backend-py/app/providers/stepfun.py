"""
Provider config for StepFun (阶跃星辰).
"""
from __future__ import annotations
from typing import Any
INFO: dict[str, Any] = {'name': 'StepFun (阶跃星辰)', 'aliases': ['step', 'step-ai'], 'display_name': 'StepFun (阶跃星辰)', 'description': 'StepFun API — Step-1 and Step-2 models', 'base_url': 'https://api.stepfun.com/v1', 'api_mode': 'openai_chat', 'env_vars': ['STEPFUN_API_KEY', 'STEPFUN_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'step-2-16k', 'fallback_models': ['step-1-128k', 'step-1-32k'], 'default_max_tokens': 4096, 'signup_url': 'https://platform.stepfun.com', 'supports_health_check': True, 'model_profiles': {'step-2-16k': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 16384, 'maxOutputTokens': 4096}, 'step-1-8k': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 8192, 'maxOutputTokens': 4096}, 'step-1-32k': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 32768, 'maxOutputTokens': 4096}, 'step-1-128k': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}, 'step-1v-32k': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 32768, 'maxOutputTokens': 4096}, '*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://api.stepfun.com/v1'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey