/**
 * Provider hints for ambiguous model names.
 * Used by backend/index.js when multiple providers have overlapping model-profile prefixes.
 *
 * These are real model IDs from Hermes Agent and OpenCode that were not
 * previously available in August Proxy.
 */

const providerHints = {
  // Groq models
  'llama-3.1-70b-versatile': 'groq',
  'llama-3.1-8b-instant': 'groq',
  'llama-3.3-70b-versatile': 'groq',
  'mixtral-8x7b-32768': 'groq',
  'gemma2-9b-it': 'groq',

  // Mistral models
  'mistral-large-latest': 'mistral',
  'mistral-small-latest': 'mistral',
  'codestral-latest': 'mistral',
  'pixtral-large-latest': 'mistral',

  // Cohere models
  'command-r-plus': 'cohere',
  'command-r': 'cohere',
  'command-light': 'cohere',

  // Perplexity models
  'sonar-pro': 'perplexity',
  'sonar-plus': 'perplexity',
  'sonar': 'perplexity',

  // Together models
  'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo': 'together',
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo': 'together',
  'mistralai/Mixtral-8x7B-Instruct-v0.1': 'together',

  // Fireworks models
  'accounts/fireworks/models/llama-v3p1-70b-instruct': 'fireworks',
  'accounts/fireworks/models/mixtral-8x7b-instruct': 'fireworks',

  // Replicate models
  'meta/meta-llama-3.1-405b-instruct': 'replicate',
  'meta/meta-llama-3-70b-instruct': 'replicate',

  // Cerebras models
  'llama3.1-8b': 'cerebras',
  'llama3.1-70b': 'cerebras',

  // Fal models
  'fal-ai/flux/schnell': 'fal',
  'fal-ai/flux-pro': 'fal',
  'fal-ai/aurora': 'fal',

  // xAI Grok models
  'grok-2-latest': 'grok',
  'grok-2': 'grok',
  'grok-beta': 'grok',

  // Qwen models
  'qwen-plus': 'qwen',
  'qwen-max': 'qwen',
  'qwen-turbo': 'qwen',
  'qwq-32b': 'qwen',

  // Tencent models
  'hunyuan-lite': 'tencent',
  'hunyuan-standard': 'tencent',
  'hunyuan-large': 'tencent',

  // Microsoft / Azure models
  'gpt-4o': 'microsoft',
  'gpt-4o-mini': 'microsoft',
  'o1-preview': 'microsoft',
  'o1-mini': 'microsoft',

  // Local models
  'local-model': 'lmstudio',
};

function getProviderHint(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  const normalized = modelId.trim();
  return providerHints[normalized] || providerHints[normalized.toLowerCase()] || null;
}

module.exports = { providerHints, getProviderHint };
