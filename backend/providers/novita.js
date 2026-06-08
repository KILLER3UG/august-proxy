module.exports = {
  
  name: 'novita',
  aliases: [],
  displayName: 'Novita AI',
  description: 'Novita AI — multi-model API gateway',
  baseUrl: 'https://api.novita.ai/v3/openai',
  apiMode: 'openai_chat',
  envVars: ['NOVITA_API_KEY', 'NOVITA_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'deepseek-v4',
  fallbackModels: ['deepseek-v4', 'deepseek-r1', 'llama-3.1-70b'],
  defaultMaxTokens: 8192,
  signupUrl: 'https://novita.ai',
  supportsHealthCheck: true,
  modelProfiles: {
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
