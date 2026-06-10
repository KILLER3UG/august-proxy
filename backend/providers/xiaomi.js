module.exports = {

  name: 'xiaomi',
  aliases: ['mimo', 'xiaomi-mimo'],
  displayName: 'Xiaomi MiMo',
  description: 'Xiaomi MiMo API — reasoning and flash models',
  baseUrl: 'https://api.mimo.xyz/v1',
  apiMode: 'openai_chat',
  envVars: ['XIAOMI_API_KEY', 'XIAOMI_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'mimo-v2',
  fallbackModels: ['mimo-v2-flash', 'mimo-v1'],
  defaultMaxTokens: 8192,
  signupUrl: 'https://mimo.xyz',
  supportsHealthCheck: true,
  modelProfiles: {
    'mimo-v2': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'mimo-v2-flash': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'mimo-v1': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 32768, maxOutputTokens: 4096 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
