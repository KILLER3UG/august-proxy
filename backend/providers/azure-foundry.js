module.exports = {
  
  name: 'azure-foundry',
  aliases: ['azure'],
  displayName: 'Azure AI Foundry',
  description: 'Azure AI Foundry — OpenAI models via Azure',
  baseUrl: '',
  apiMode: 'openai_chat',
  envVars: ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'],
  authType: 'api_key',
  defaultModel: 'gpt-4o',
  defaultMaxTokens: 4096,
  signupUrl: 'https://ai.azure.com',
  supportsHealthCheck: true,
  modelProfiles: {
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 128000, maxOutputTokens: 4096 },
  },

};
