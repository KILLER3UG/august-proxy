module.exports = {
  
  name: 'custom',
  aliases: ['ollama', 'vllm', 'local'],
  displayName: 'Custom (OpenAI-compatible)',
  description: 'Generic OpenAI-compatible endpoint — Ollama, vLLM, llama.cpp, etc.',
  baseUrl: 'http://localhost:11434/v1',
  apiMode: 'openai_chat',
  envVars: ['CUSTOM_API_KEY', 'CUSTOM_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'llama3',
  defaultMaxTokens: 4096,
  supportsHealthCheck: false,
  modelProfiles: {
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 32768, maxOutputTokens: 4096 },
  },

};
