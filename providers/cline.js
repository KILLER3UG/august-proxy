module.exports = {
  
  name: 'cline',
  aliases: ['cline-ai'],
  displayName: 'Cline AI',
  description: 'Cline AI — OpenRouter-based model access',
  baseUrl: 'https://api.cline.bot/api/v1',
  apiMode: 'openai_chat',
  envVars: ['CLINE_API_KEY', 'CLINE_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'minimax-m2.5',
  defaultMaxTokens: 8192,
  signupUrl: 'https://cline.bot',
  supportsHealthCheck: true,
  modelProfiles: {
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
