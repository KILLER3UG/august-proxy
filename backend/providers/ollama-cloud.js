module.exports = {

  name: 'ollama-cloud',
  aliases: ['ollama-cloud-hosted'],
  displayName: 'Ollama Cloud',
  description: 'Ollama Cloud hosted API — open models on demand',
  baseUrl: 'https://cloud.ollama.ai/api/chat',
  apiMode: 'openai_chat',
  envVars: ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_CLOUD_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'llama-3.1-70b',
  fallbackModels: ['llama-3.1-8b', 'qwen2.5-72b', 'mistral-large'],
  defaultMaxTokens: 8192,
  signupUrl: 'https://ollama.ai',
  supportsHealthCheck: true,
  modelProfiles: {
    'llama-3.1-70b': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'llama-3.1-8b': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'qwen2.5-72b': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'qwen2.5-coder-32b': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'mistral-large': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'deepseek-v4': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
