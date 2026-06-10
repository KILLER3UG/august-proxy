module.exports = {

  name: 'kimi-coding',
  aliases: ['kimi', 'moonshot', 'kimi-coding'],
  displayName: 'Kimi (Moonshot)',
  description: 'Kimi/Moonshot API — kimi-k2 reasoning and moonshot-v1 models',
  baseUrl: 'https://api.moonshot.cn/v1',
  apiMode: 'openai_chat',
  envVars: ['MOONSHOT_API_KEY', 'MOONSHOT_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'kimi-k2',
  fallbackModels: ['kimi-k2-turbo', 'moonshot-v1-128k'],
  defaultMaxTokens: 8192,
  signupUrl: 'https://platform.moonshot.cn',
  supportsHealthCheck: true,
  modelProfiles: {
    'kimi-k2': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'kimi-k2-turbo': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'moonshot-v1-8k': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 8192, maxOutputTokens: 4096 },
    'moonshot-v1-32k': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 32768, maxOutputTokens: 4096 },
    'moonshot-v1-128k': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
