module.exports = {
  
  name: 'openai-api',
  aliases: ['openai', 'gpt'],
  displayName: 'OpenAI API',
  description: 'OpenAI Chat Completions API — GPT models',
  baseUrl: 'https://api.openai.com/v1',
  apiMode: 'codex_responses',
  envVars: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'gpt-4o',
  defaultMaxTokens: 4096,
  signupUrl: 'https://platform.openai.com',
  supportsHealthCheck: true,
  modelProfiles: {
    'gpt-4': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 128000, maxOutputTokens: 16384 },
    'gpt-3': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 16385, maxOutputTokens: 4096 },
    'o1': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 200000, maxOutputTokens: 100000 },
    'o3': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 200000, maxOutputTokens: 100000 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 128000, maxOutputTokens: 4096 },
  },

};
