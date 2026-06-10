module.exports = {

  name: 'zai',
  aliases: ['glm', 'zhipu', 'zhi-ai'],
  displayName: 'Zhipu AI (GLM)',
  description: 'Zhipu AI (智谱AI) API — GLM and CodeGeeX models',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiMode: 'openai_chat',
  envVars: ['ZHIPU_API_KEY', 'ZHIPU_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'glm-5',
  fallbackModels: ['glm-5-flash', 'glm-4-plus', 'glm-4v-plus'],
  defaultMaxTokens: 8192,
  signupUrl: 'https://open.bigmodel.cn',
  supportsHealthCheck: true,
  modelProfiles: {
    'glm-5': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'glm-5-flash': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'glm-4-plus': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'glm-4v-plus': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'glm-4-air': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
    'codegeex-4': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
