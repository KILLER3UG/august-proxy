module.exports = {
  
  name: 'nvidia',
  aliases: ['nvidia-nim', 'nim'],
  displayName: 'NVIDIA NIM',
  description: 'NVIDIA NIM — GPU-accelerated model inference',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  apiMode: 'openai_chat',
  envVars: ['NVIDIA_API_KEY', 'NVIDIA_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'meta/llama-3.1-405b-instruct',
  defaultMaxTokens: 4096,
  signupUrl: 'https://build.nvidia.com',
  supportsHealthCheck: true,
  modelProfiles: {
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096 },
  },

};
