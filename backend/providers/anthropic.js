module.exports = {
  
  name: 'anthropic',
  aliases: ['claude'],
  displayName: 'Anthropic',
  description: 'Anthropic Messages API — Claude models',
  baseUrl: 'https://api.anthropic.com/v1/messages',
  apiMode: 'anthropic_messages',
  envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'claude-sonnet-4-6',
  defaultMaxTokens: 8192,
  signupUrl: 'https://console.anthropic.com',
  supportsHealthCheck: true,
  defaultHeaders: { 'anthropic-version': '2023-06-01' },
  modelProfiles: {
    'claude-opus-4': { supportsReasoning: true, supportsThinking: true, combinedBudget: false, contextWindow: 200000, maxOutputTokens: 8192 },
    'claude-sonnet-4': { supportsReasoning: true, supportsThinking: true, combinedBudget: false, contextWindow: 200000, maxOutputTokens: 8192 },
    'claude-3': { supportsReasoning: false, supportsThinking: true, combinedBudget: false, contextWindow: 200000, maxOutputTokens: 4096 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 200000, maxOutputTokens: 4096 },
  },

};
