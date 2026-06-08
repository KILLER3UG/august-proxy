module.exports = {
  
  name: 'openrouter',
  aliases: ['or'],
  displayName: 'OpenRouter',
  description: 'OpenRouter — multi-model API aggregator',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiMode: 'openai_chat',
  envVars: ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'auto',
  defaultMaxTokens: 4096,
  signupUrl: 'https://openrouter.ai',
  supportsHealthCheck: true,
  defaultHeaders: { 'HTTP-Referer': 'https://github.com/robert/august-proxy', 'X-Title': 'August Proxy' },
  modelProfiles: {
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
