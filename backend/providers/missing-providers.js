/**
 * Missing provider profiles from Hermes Agent and OpenCode.
 * These providers are available in Hermes/OpenCode but were not yet
 * registered in August Proxy's builtin provider list.
 *
 * Source projects:
 * - Hermes Agent: microsoft, qwen, tencent, lmstudio
 * - OpenCode: cohere, mistral, groq, cerebras, fal, fireworks, replicate, together, perplexity, grok, llama.cpp
 *
 * Note: These are profile registrations only. The provider adapter layer
 * handles actual API calls using the apiMode field.
 */

const { ProviderProfile } = require('./provider-profile');

const providers = [
  // ── Hermes Agent providers ──
  new ProviderProfile({
    name: 'microsoft',
    aliases: ['ms', 'azure', 'azure-ai'],
    displayName: 'Microsoft Azure AI',
    description: 'Microsoft Azure AI Foundry / Azure OpenAI compatible endpoint.',
    baseUrl: 'https://api.openai.com/v1',
    apiMode: 'openai_chat',
    envVars: ['MICROSOFT_API_KEY', 'AZURE_OPENAI_API_KEY'],
    authType: 'api_key',
    defaultModel: 'gpt-4o',
    supportsStreaming: true,
    signupUrl: 'https://azure.microsoft.com/',
    modelProfiles: {
      '*': { contextWindow: 128000, maxOutputTokens: 16384, supportsReasoning: false }
    }
  }),
  new ProviderProfile({
    name: 'qwen',
    aliases: ['alibaba-qwen', 'tongyi'],
    displayName: 'Alibaba Qwen',
    description: 'Alibaba Cloud Qwen / Tongyi Qianwen models.',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiMode: 'openai_chat',
    envVars: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
    authType: 'api_key',
    defaultModel: 'qwen-plus',
    supportsStreaming: true,
    signupUrl: 'https://www.aliyun.com/product/dashscope',
    modelProfiles: {
      'qwen': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: false },
      'qwq': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: true },
      '*': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: false }
    }
  }),
  new ProviderProfile({
    name: 'tencent',
    aliases: ['yunbao', 'yuanbao', 'tencent-cloud'],
    displayName: 'Tencent Cloud',
    description: 'Tencent Cloud / Yuanbao provider compatibility.',
    baseUrl: 'https://api.lkeap.cloud.tencent.com/v1',
    apiMode: 'openai_chat',
    envVars: ['TENCENT_API_KEY', 'YUANBAO_API_KEY'],
    authType: 'api_key',
    defaultModel: 'hunyuan-lite',
    supportsStreaming: true,
    signupUrl: 'https://cloud.tencent.com/',
    modelProfiles: {
      'hunyuan': { contextWindow: 128000, maxOutputTokens: 16384, supportsReasoning: false },
      '*': { contextWindow: 128000, maxOutputTokens: 16384, supportsReasoning: false }
    }
  }),
  new ProviderProfile({
    name: 'lmstudio',
    aliases: ['lm-studio', 'local-llm'],
    displayName: 'LM Studio Local',
    description: 'Local LM Studio OpenAI-compatible server.',
    baseUrl: 'http://localhost:1234/v1',
    apiMode: 'openai_chat',
    envVars: [],
    authType: 'none',
    defaultModel: 'local-model',
    supportsStreaming: true,
    supportsHealthCheck: true,
    signupUrl: 'https://lmstudio.ai/',
    modelProfiles: {
      '*': { contextWindow: 32768, maxOutputTokens: 4096, supportsReasoning: false }
    }
  }),

  // ── OpenCode providers ──
  new ProviderProfile({
    name: 'cohere',
    aliases: ['co'],
    displayName: 'Cohere',
    description: 'Cohere Command and Embed models.',
    baseUrl: 'https://api.cohere.com/v1',
    apiMode: 'openai_chat',
    envVars: ['COHERE_API_KEY'],
    authType: 'api_key',
    defaultModel: 'command-r-plus',
    supportsStreaming: true,
    signupUrl: 'https://cohere.com/',
    modelProfiles: {
      'command': { contextWindow: 128000, maxOutputTokens: 4096, supportsReasoning: false },
      'embed': { contextWindow: 512, maxOutputTokens: 0, supportsReasoning: false },
      '*': { contextWindow: 128000, maxOutputTokens: 4096, supportsReasoning: false }
    }
  }),
  new ProviderProfile({
    name: 'mistral',
    aliases: ['mistral-ai'],
    displayName: 'Mistral AI',
    description: 'Mistral AI La Plateforme.',
    baseUrl: 'https://api.mistral.ai/v1',
    apiMode: 'openai_chat',
    envVars: ['MISTRAL_API_KEY'],
    authType: 'api_key',
    defaultModel: 'mistral-large-latest',
    supportsStreaming: true,
    signupUrl: 'https://mistral.ai/',
    modelProfiles: {
      'mistral-large': { contextWindow: 131072, maxOutputTokens: 32768, supportsReasoning: false },
      'mistral-small': { contextWindow: 32768, maxOutputTokens: 16384, supportsReasoning: false },
      'codestral': { contextWindow: 256000, maxOutputTokens: 16384, supportsReasoning: false },
      '*': { contextWindow: 32768, maxOutputTokens: 16384, supportsReasoning: false }
    }
  }),
  new ProviderProfile({
    name: 'groq',
    aliases: ['groq-cloud'],
    displayName: 'Groq',
    description: 'Groq Cloud ultra-fast inference.',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiMode: 'openai_chat',
    envVars: ['GROQ_API_KEY'],
    authType: 'api_key',
    defaultModel: 'llama-3.1-70b-versatile',
    supportsStreaming: true,
    signupUrl: 'https://groq.com/',
    modelProfiles: {
      'llama': { contextWindow: 131072, maxOutputTokens: 8192, supportsReasoning: false },
      'mixtral': { contextWindow: 32768, maxOutputTokens: 8192, supportsReasoning: false },
      'gemma': { contextWindow: 8192, maxOutputTokens: 8192, supportsReasoning: false },
      '*': { contextWindow: 131072, maxOutputTokens: 8192, supportsReasoning: false }
    }
  }),
  new ProviderProfile({
    name: 'cerebras',
    aliases: ['cerebras-cloud'],
    displayName: 'Cerebras',
    description: 'Cerebras Cloud inference.',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiMode: 'openai_chat',
    envVars: ['CEREBRAS_API_KEY'],
    authType: 'api_key',
    defaultModel: 'llama3.1-8b',
    supportsStreaming: true,
    signupUrl: 'https://cloud.cerebras.ai/',
    modelProfiles: {
      'llama': { contextWindow: 131072, maxOutputTokens: 8192, supportsReasoning: false },
      '*': { contextWindow: 131072, maxOutputTokens: 8192, supportsReasoning: false }
    }
  }),
  new ProviderProfile({
    name: 'fal',
    aliases: ['fal-ai'],
    displayName: 'Fal AI',
    description: 'Fal AI media generation and inference.',
    baseUrl: 'https://openai.fal.ai/v1',
    apiMode: 'openai_chat',
    envVars: ['FAL_KEY'],
    authType: 'api_key',
    defaultModel: 'fal-ai/flux/schnell',
    supportsStreaming: false,
    signupUrl: 'https://fal.ai/',
    modelProfiles: {
      'flux': { contextWindow: 77, maxOutputTokens: 512, supportsReasoning: false },
      '*': { contextWindow: 77, maxOutputTokens: 512, supportsReasoning: false }
    }
  }),
  new ProviderProfile({
    name: 'fireworks',
    aliases: ['fireworks-ai'],
    displayName: 'Fireworks AI',
    description: 'Fireworks AI open model inference.',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiMode: 'openai_chat',
    envVars: ['FIREWORKS_API_KEY'],
    authType: 'api_key',
    defaultModel: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    supportsStreaming: true,
    signupUrl: 'https://fireworks.ai/',
    modelProfiles: {
      'llama': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: false },
      'mixtral': { contextWindow: 32768, maxOutputTokens: 16384, supportsReasoning: false },
      'qwen': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: false },
      '*': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: false }
    }
  }),
  new ProviderProfile({
    name: 'replicate',
    aliases: ['replicate-ai'],
    displayName: 'Replicate',
    description: 'Replicate hosted open-source models.',
    baseUrl: 'https://openai-proxy.replicate.com/v1',
    apiMode: 'openai_chat',
    envVars: ['REPLICATE_API_TOKEN'],
    authType: 'api_key',
    defaultModel: 'meta/meta-llama-3.1-405b-instruct',
    supportsStreaming: true,
    signupUrl: 'https://replicate.com/',
    modelProfiles: {
      'llama': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: false },
      'mistral': { contextWindow: 32768, maxOutputTokens: 16384, supportsReasoning: false },
      'qwen': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: false },
      '*': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: false }
    }
  }),
  new ProviderProfile({
    name: 'together',
    aliases: ['together-ai'],
    displayName: 'Together AI',
    description: 'Together AI open model inference.',
    baseUrl: 'https://api.together.xyz/v1',
    apiMode: 'openai_chat',
    envVars: ['TOGETHER_API_KEY'],
    authType: 'api_key',
    defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
    supportsStreaming: true,
    signupUrl: 'https://together.ai/',
    modelProfiles: {
      'llama': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: false },
      'mixtral': { contextWindow: 32768, maxOutputTokens: 16384, supportsReasoning: false },
      'qwen': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: false },
      '*': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: false }
    }
  }),
  new ProviderProfile({
    name: 'perplexity',
    aliases: ['pplx', 'perplexity-ai'],
    displayName: 'Perplexity',
    description: 'Perplexity Sonar and RAG models.',
    baseUrl: 'https://api.perplexity.ai',
    apiMode: 'openai_chat',
    envVars: ['PERPLEXITY_API_KEY'],
    authType: 'api_key',
    defaultModel: 'sonar-pro',
    supportsStreaming: true,
    signupUrl: 'https://www.perplexity.ai/',
    modelProfiles: {
      'sonar': { contextWindow: 200000, maxOutputTokens: 8192, supportsReasoning: false },
      '*': { contextWindow: 200000, maxOutputTokens: 8192, supportsReasoning: false }
    }
  }),
  new ProviderProfile({
    name: 'grok',
    aliases: ['xai-grok', 'x-grok'],
    displayName: 'xAI Grok',
    description: 'xAI Grok models via dedicated Grok endpoint.',
    baseUrl: 'https://api.x.ai/v1',
    apiMode: 'openai_chat',
    envVars: ['XAI_API_KEY'],
    authType: 'api_key',
    defaultModel: 'grok-2-latest',
    supportsStreaming: true,
    signupUrl: 'https://x.ai/',
    modelProfiles: {
      'grok': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: false },
      '*': { contextWindow: 131072, maxOutputTokens: 16384, supportsReasoning: false }
    }
  }),
  new ProviderProfile({
    name: 'llama-cpp',
    aliases: ['llama.cpp', 'llamacpp', 'local-llama-cpp'],
    displayName: 'llama.cpp Local',
    description: 'Local llama.cpp server (OpenAI-compatible).',
    baseUrl: 'http://localhost:8080/v1',
    apiMode: 'openai_chat',
    envVars: [],
    authType: 'none',
    defaultModel: 'local-model',
    supportsStreaming: true,
    supportsHealthCheck: true,
    signupUrl: 'https://github.com/ggml-org/llama.cpp',
    modelProfiles: {
      '*': { contextWindow: 32768, maxOutputTokens: 4096, supportsReasoning: false }
    }
  })
];

module.exports = providers;
