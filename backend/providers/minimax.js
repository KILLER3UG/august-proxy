module.exports = {
  
  name: 'minimax',
  aliases: ['minimax-global'],
  displayName: 'MiniMax (Global)',
  description: 'MiniMax global API — M2.5 and M2.7 models via Anthropic-compatible endpoint',
  baseUrl: 'https://api.minimax.io/anthropic',
  apiMode: 'anthropic_messages',
  envVars: ['MINIMAX_API_KEY', 'MINIMAX_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'minimax-m2.7',
  fallbackModels: ['minimax-m2.7', 'minimax-m2.5', 'minimax-t2.5'],
  defaultMaxTokens: 64000,
  signupUrl: 'https://platform.minimaxi.com',
  supportsHealthCheck: true,
  modelProfiles: {
    'minimax-m2.7': { supportsReasoning: true, supportsThinking: true, combinedBudget: true, contextWindow: 204800, maxOutputTokens: 64000, temperature: 1, topP: 0.95, topK: 40, thinkingReserve: 4096, safetyBuffer: 2000 },
    'minimax-m2.5': { supportsReasoning: true, supportsThinking: true, combinedBudget: false, contextWindow: 245760, maxOutputTokens: 8192, temperature: 1, topP: 0.95, topK: 40, thinkingReserve: 0, safetyBuffer: 2000 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096, temperature: undefined, topP: undefined, topK: undefined },
  },

};
