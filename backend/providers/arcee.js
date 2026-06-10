module.exports = {

  name: 'arcee',
  aliases: ['arcee-ai'],
  displayName: 'Arcee AI',
  description: 'Arcee AI API — supernova models',
  baseUrl: 'https://api.arcee.ai/v1',
  apiMode: 'openai_chat',
  envVars: ['ARCEE_API_KEY', 'ARCEE_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'supernova-70b',
  fallbackModels: ['supernova-8b', 'supernova-7b'],
  defaultMaxTokens: 4096,
  signupUrl: 'https://arcee.ai',
  supportsStreaming: true,
  supportsHealthCheck: false,
  modelProfiles: {
    'supernova-7b': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 32768, maxOutputTokens: 4096 },
    'supernova-8b': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 32768, maxOutputTokens: 4096 },
    'supernova-70b': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 65536, maxOutputTokens: 4096 },
    'arcee-v2': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 65536, maxOutputTokens: 4096 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 32768, maxOutputTokens: 4096 },
  },

};
