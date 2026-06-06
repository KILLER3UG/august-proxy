module.exports = {
  
  name: 'kilo',
  aliases: ['kilocode'],
  displayName: 'KiloCode',
  description: 'KiloCode aggregator — multi-model API gateway',
  baseUrl: 'https://api.kilo.ai/api/gateway',
  apiMode: 'openai_chat',
  envVars: ['KILOCODE_API_KEY', 'KILOCODE_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'deepseek-v4-flash',
  defaultMaxTokens: 8192,
  signupUrl: 'https://kilo.ai',
  supportsHealthCheck: true,
  modelProfiles: {
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
