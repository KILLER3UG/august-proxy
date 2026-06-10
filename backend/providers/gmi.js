module.exports = {

  name: 'gmi',
  aliases: ['gmi-cloud'],
  displayName: 'GMI Cloud',
  description: 'GMI Cloud API — hosted open models',
  baseUrl: 'https://api.gmi.cloud/v1',
  apiMode: 'openai_chat',
  envVars: ['GMI_API_KEY', 'GMI_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'gmi-llama-3.1-70b',
  fallbackModels: ['gmi-llama-3.1-405b', 'gmi-hermes-4'],
  defaultMaxTokens: 8192,
  signupUrl: 'https://gmi.cloud',
  supportsHealthCheck: true,
  modelProfiles: {
    'gmi-llama-3.1-405b': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'gmi-llama-3.1-70b': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'gmi-hermes-4': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
