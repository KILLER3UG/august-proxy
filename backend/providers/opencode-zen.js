module.exports = {
  
  name: 'opencode-zen',
  aliases: ['zen'],
  displayName: 'OpenCode Zen',
  description: 'OpenCode Zen API — single-model direct access',
  baseUrl: 'https://opencode.ai/zen/v1',
  apiMode: 'openai_chat',
  envVars: ['OPENCODE_ZEN_API_KEY', 'OPENCODE_ZEN_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'deepseek-v4-flash',
  fallbackModels: ['deepseek-v4', 'deepseek-v4-flash', 'deepseek-r1'],
  defaultMaxTokens: 8192,
  signupUrl: 'https://opencode.ai',
  supportsHealthCheck: true,
  modelProfiles: {
    'deepseek-v4': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'kimi-k2': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'glm-5': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'qwen3': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'mimo-v2': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
