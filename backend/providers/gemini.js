module.exports = {
  
  name: 'gemini',
  aliases: ['google'],
  displayName: 'Google AI Studio',
  description: 'Google AI Studio — Gemini models via OpenAI-compatible endpoint',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  apiMode: 'openai_chat',
  envVars: ['GEMINI_API_KEY', 'GEMINI_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'gemini-2.0-flash',
  defaultMaxTokens: 8192,
  signupUrl: 'https://aistudio.google.com',
  supportsHealthCheck: true,
  modelProfiles: {
    'gemini-2': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 1048576, maxOutputTokens: 8192 },
    'gemini-1': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 1048576, maxOutputTokens: 8192 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 1048576, maxOutputTokens: 4096 },
  },

};
