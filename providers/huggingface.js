module.exports = {
  
  name: 'huggingface',
  aliases: ['hf'],
  displayName: 'Hugging Face',
  description: 'Hugging Face Inference Endpoints — open models',
  baseUrl: 'https://api-inference.huggingface.co/v1',
  apiMode: 'openai_chat',
  envVars: ['HUGGINGFACE_API_KEY', 'HUGGINGFACE_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'meta-llama/Llama-3.1-70B-Instruct',
  defaultMaxTokens: 4096,
  signupUrl: 'https://huggingface.co',
  supportsHealthCheck: true,
  modelProfiles: {
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
