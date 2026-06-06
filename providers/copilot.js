module.exports = {
  
  name: 'copilot',
  aliases: ['github-copilot'],
  displayName: 'GitHub Copilot',
  description: 'GitHub Copilot — OpenAI-compatible endpoint',
  baseUrl: 'https://api.githubcopilot.com',
  apiMode: 'openai_chat',
  envVars: ['COPILOT_API_KEY', 'COPILOT_BASE_URL'],
  authType: 'api_key',
  defaultModel: 'gpt-4o-copilot',
  defaultMaxTokens: 4096,
  signupUrl: 'https://github.com/features/copilot',
  supportsHealthCheck: true,
  modelProfiles: {
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 128000, maxOutputTokens: 4096 },
  },

};
