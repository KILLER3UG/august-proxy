module.exports = {

  name: 'ai-gateway',
  aliases: ['gateway', 'llm-gateway'],
  displayName: 'AI Gateway',
  description: 'Generic AI Gateway proxy — pass-through to upstream providers',
  baseUrl: 'https://gateway.ai.cloudflare.com/v1',
  apiMode: 'openai_chat',
  envVars: ['AI_GATEWAY_API_KEY', 'AI_GATEWAY_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'generic',
  fallbackModels: [],
  defaultMaxTokens: 4096,
  signupUrl: '',
  supportsHealthCheck: false,
  modelProfiles: {
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
