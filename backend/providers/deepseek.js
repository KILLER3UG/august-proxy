module.exports = {
  
  name: 'deepseek',
  aliases: ['ds'],
  displayName: 'DeepSeek',
  description: 'DeepSeek API — deepseek-v4 and deepseek-reasoner models',
  baseUrl: 'https://api.deepseek.com/v1',
  apiMode: 'openai_chat',
  envVars: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'deepseek-v4',
  defaultMaxTokens: 8192,
  signupUrl: 'https://platform.deepseek.com',
  supportsHealthCheck: true,
  modelProfiles: {
    'deepseek-v4': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'deepseek-reasoner': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
