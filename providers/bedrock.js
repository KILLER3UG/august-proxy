module.exports = {
  
  name: 'bedrock',
  aliases: ['aws'],
  displayName: 'AWS Bedrock',
  description: 'AWS Bedrock Converse API — Claude and other models via AWS',
  baseUrl: '',
  apiMode: 'bedrock_converse',
  envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_BEDROCK_BASE_URL'],
  authType: 'aws_sdk',
  defaultModel: 'anthropic.claude-sonnet-4-20250514',
  defaultMaxTokens: 8192,
  signupUrl: 'https://aws.amazon.com/bedrock',
  supportsHealthCheck: false,
  modelProfiles: {
    'claude': { supportsReasoning: true, supportsThinking: true, combinedBudget: false, contextWindow: 200000, maxOutputTokens: 8192 },
    '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 200000, maxOutputTokens: 4096 },
  },

};
