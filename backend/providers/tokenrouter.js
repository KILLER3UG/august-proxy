module.exports = {

  name: 'tokenrouter',
  aliases: ['tr'],
  displayName: 'Token Router',
  description: 'Token Router API — AI routing gateway with auto:balance, auto:cost, auto:quality and auto:latency modes',
  baseUrl: 'https://api.tokenrouter.com/v1',
  apiMode: 'openai_chat',
  envVars: ['TOKENROUTER_API_KEY', 'TOKENROUTER_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'auto:balance',
  defaultMaxTokens: 8192,
  signupUrl: 'https://tokenrouter.me',
  supportsHealthCheck: true,
  modelProfiles: {
    'auto:balance': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 128000, maxOutputTokens: 8192 },
    'auto:cost': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 128000, maxOutputTokens: 8192 },
    'auto:quality': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 128000, maxOutputTokens: 8192 },
    'auto:latency': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 128000, maxOutputTokens: 8192 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 128000, maxOutputTokens: 4096 },
  },

};
