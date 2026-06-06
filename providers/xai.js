module.exports = {
  
  name: 'xai',
  aliases: ['grok'],
  displayName: 'xAI',
  description: 'xAI API — Grok models',
  baseUrl: 'https://api.x.ai/v1',
  apiMode: 'codex_responses',
  envVars: ['XAI_API_KEY', 'XAI_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'grok-3',
  defaultMaxTokens: 8192,
  signupUrl: 'https://console.x.ai',
  supportsHealthCheck: true,
  modelProfiles: {
    'grok-3': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'grok-2': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
