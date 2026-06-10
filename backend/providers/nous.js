module.exports = {

  name: 'nous',
  aliases: ['nous-research', 'nous-portal'],
  displayName: 'Nous Research (Portal)',
  description: 'Nous Portal API — hermes-4 and hermes-3 models',
  baseUrl: 'https://api.nousresearch.com/v1',
  apiMode: 'openai_chat',
  envVars: ['NOUS_API_KEY', 'NOUS_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'hermes-4',
  fallbackModels: ['hermes-4-flash', 'hermes-3', 'hermes-3-flash'],
  defaultMaxTokens: 8192,
  signupUrl: 'https://nousresearch.com',
  supportsHealthCheck: true,
  modelProfiles: {
    'hermes-4': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'hermes-4-flash': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'hermes-3': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'hermes-3-flash': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
