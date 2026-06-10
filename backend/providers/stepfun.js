module.exports = {

  name: 'stepfun',
  aliases: ['step', 'step-ai'],
  displayName: 'StepFun (阶跃星辰)',
  description: 'StepFun API — Step-1 and Step-2 models',
  baseUrl: 'https://api.stepfun.com/v1',
  apiMode: 'openai_chat',
  envVars: ['STEPFUN_API_KEY', 'STEPFUN_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'step-2-16k',
  fallbackModels: ['step-1-128k', 'step-1-32k'],
  defaultMaxTokens: 4096,
  signupUrl: 'https://platform.stepfun.com',
  supportsHealthCheck: true,
  modelProfiles: {
    'step-2-16k': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 16384, maxOutputTokens: 4096 },
    'step-1-8k': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 8192, maxOutputTokens: 4096 },
    'step-1-32k': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 32768, maxOutputTokens: 4096 },
    'step-1-128k': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
    'step-1v-32k': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 32768, maxOutputTokens: 4096 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
