module.exports = {
  
  name: 'minimax-cn',
  aliases: [],
  displayName: 'MiniMax (China)',
  description: 'MiniMax China endpoint — M2.5 and M2.7 models',
  baseUrl: 'https://minimax.qlangtech.com/anthropic',
  apiMode: 'anthropic_messages',
  envVars: ['MINIMAX_CN_API_KEY', 'MINIMAX_CN_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'minimax-m2.7',
  defaultMaxTokens: 64000,
  signupUrl: 'https://platform.minimaxi.com',
  supportsHealthCheck: false,
  modelProfiles: {
    'minimax-m2.7': { supportsReasoning: true, supportsThinking: true, combinedBudget: true, contextWindow: 204800, maxOutputTokens: 64000, temperature: 1, topP: 0.95, topK: 40, thinkingReserve: 4096, safetyBuffer: 2000 },
    'minimax-m2.5': { supportsReasoning: true, supportsThinking: true, combinedBudget: false, contextWindow: 245760, maxOutputTokens: 8192, temperature: 1, topP: 0.95, topK: 40 },
    '*': { supportsReasoning: false, supportsThinking: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
