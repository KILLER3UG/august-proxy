module.exports = {

  name: 'alibaba',
  aliases: ['qwen', 'alibaba-cloud'],
  displayName: 'Alibaba Cloud (Qwen)',
  description: 'Alibaba Cloud DashScope API — Qwen and QwQ models',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiMode: 'openai_chat',
  envVars: ['ALIBABA_API_KEY', 'ALIBABA_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'qwen3',
  fallbackModels: ['qwen-plus', 'qwen-max', 'qwq-32b'],
  defaultMaxTokens: 8192,
  signupUrl: 'https://dashscope.aliyun.com',
  supportsHealthCheck: true,
  modelProfiles: {
    'qwen3': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'qwen-turbo': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'qwen-plus': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'qwen-max': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    'qwq-32b': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
