/**
 * Model Profiles — Per-model configuration for generation defaults,
 * token budgets, reasoning/thinking support, etc.
 */
const { getConfig } = require('./config');

const BUILTIN_PROFILES = {
  'minimax-m2.7': { supportsReasoning: true, supportsThinking: true, combinedBudget: true, contextWindow: 204800, maxOutputTokens: 64000, temperature: 1, topP: 0.95, topK: 40, thinkingReserve: 4096, safetyBuffer: 2000 },
  'minimax-m2.5': { supportsReasoning: true, supportsThinking: true, combinedBudget: false, contextWindow: 245760, maxOutputTokens: 8192, temperature: 1, topP: 0.95, topK: 40, thinkingReserve: 0, safetyBuffer: 2000 },
  'deepseek-v4': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192, temperature: undefined, topP: undefined, topK: undefined, thinkingReserve: 0, safetyBuffer: 2000 },
  'deepseek-reasoner': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192, temperature: undefined, topP: undefined, topK: undefined, thinkingReserve: 0, safetyBuffer: 2000 },
  'kimi-k2': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192, temperature: undefined, topP: undefined, topK: undefined, thinkingReserve: 0, safetyBuffer: 2000 },
  'glm-5': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192, temperature: undefined, topP: undefined, topK: undefined, thinkingReserve: 0, safetyBuffer: 2000 },
  'qwen3': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192, temperature: undefined, topP: undefined, topK: undefined, thinkingReserve: 0, safetyBuffer: 2000 },
  'mimo-v2': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 8192, temperature: undefined, topP: undefined, topK: undefined, thinkingReserve: 0, safetyBuffer: 2000 },
  'claude-3-7': { supportsReasoning: true, supportsThinking: true, combinedBudget: false, contextWindow: 200000, maxOutputTokens: 8192, temperature: 1, thinkingReserve: 1024, safetyBuffer: 2000 },
  'claude-sonnet-4': { supportsReasoning: true, supportsThinking: true, combinedBudget: false, contextWindow: 200000, maxOutputTokens: 8192, temperature: 1, thinkingReserve: 1024, safetyBuffer: 2000 },
  'claude-3-5': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 200000, maxOutputTokens: 8192, temperature: 1, thinkingReserve: 0, safetyBuffer: 2000 },
  'o1': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 200000, maxOutputTokens: 100000, temperature: 1, thinkingReserve: 0, safetyBuffer: 2000 },
  'o3': { supportsReasoning: true, supportsThinking: false, combinedBudget: false, contextWindow: 200000, maxOutputTokens: 100000, temperature: 1, thinkingReserve: 0, safetyBuffer: 2000 },
  '*': { supportsReasoning: false, supportsThinking: false, combinedBudget: false, contextWindow: 131072, maxOutputTokens: 4096, temperature: undefined, topP: undefined, topK: undefined, thinkingReserve: 0, safetyBuffer: 2000 },
};

function detectCapabilitiesFromModelId(modelId) {
  if (!modelId || typeof modelId !== 'string') return { supportsReasoning: false, supportsThinking: false };
  const lower = modelId.toLowerCase().trim();
  const slashIdx = lower.indexOf('/');
  const colonIdx = lower.indexOf(':');
  const sep = slashIdx >= 0 ? slashIdx : colonIdx >= 0 ? colonIdx : -1;
  const baseModel = sep >= 0 ? lower.slice(sep + 1) : lower;

  // 1. Detect Thinking Support (Claude 3.7+, Claude 4+, Minimax M2.5/M2.7/M3+, etc.)
  const isClaudeThinking = baseModel.startsWith('claude-3-7') || 
                           baseModel.startsWith('claude-sonnet-4') || 
                           baseModel.startsWith('claude-opus-4') || 
                           baseModel.startsWith('claude-fable');
  
  const isMinimaxThinking = baseModel.startsWith('minimax-m2.5') || 
                            baseModel.startsWith('minimax-m2.7') || 
                            baseModel.startsWith('minimax-m3');

  const hasThinkingWord = baseModel.includes('thinking');

  const supportsThinking = !!(isClaudeThinking || isMinimaxThinking || hasThinkingWord);

  // 2. Detect Reasoning Support (OpenAI o1/o3/o4/gpt-5, DeepSeek r1/reasoner, etc.)
  const isOpenAiReasoning = baseModel.startsWith('o1') || 
                            baseModel.startsWith('o3') || 
                            baseModel.startsWith('o4') || 
                            baseModel.startsWith('gpt-5'); // e.g. gpt-5.5, gpt-5.5-pro, gpt-5.4-pro
  
  const isDeepseekReasoning = baseModel.startsWith('deepseek-r1') || 
                              baseModel.startsWith('deepseek-reasoner') || 
                              baseModel.includes('reasoner') || 
                              baseModel.includes('reasoning');

  const supportsReasoning = !!(supportsThinking || isOpenAiReasoning || isDeepseekReasoning);

  return { supportsReasoning, supportsThinking };
}

function matchModelProfile(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  const lower = modelId.toLowerCase().trim();
  // Strip provider prefix if present
  const slashIdx = lower.indexOf('/');
  const colonIdx = lower.indexOf(':');
  const sep = slashIdx >= 0 ? slashIdx : colonIdx >= 0 ? colonIdx : -1;
  const baseModel = sep >= 0 ? lower.slice(sep + 1) : lower;

  if (BUILTIN_PROFILES[baseModel]) return BUILTIN_PROFILES[baseModel];
  if (BUILTIN_PROFILES[lower]) return BUILTIN_PROFILES[lower];

  const keys = Object.keys(BUILTIN_PROFILES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (key === '*') continue;
    if (baseModel.startsWith(key) || lower.startsWith(key)) return BUILTIN_PROFILES[key];
  }

  const detected = detectCapabilitiesFromModelId(modelId);
  return {
    ...BUILTIN_PROFILES['*'],
    supportsReasoning: detected.supportsReasoning,
    supportsThinking: detected.supportsThinking
  };
}

function resolveModelProfile(modelId) {
  const builtin = matchModelProfile(modelId);
  if (!builtin) return { ...BUILTIN_PROFILES['*'] };
  const profile = { ...builtin };
  const config = getConfig();
  const userProfiles = config.modelProfiles || {};
  if (userProfiles && typeof userProfiles === 'object') {
    const lower = (modelId || '').toLowerCase().trim();
    let override = userProfiles[lower];
    if (!override) {
      const keys = Object.keys(userProfiles).sort((a, b) => b.length - a.length);
      for (const key of keys) {
        if (lower.startsWith(key.toLowerCase())) { override = userProfiles[key]; break; }
      }
    }
    if (override && typeof override === 'object') Object.assign(profile, override);
  }
  return profile;
}

function modelSupportsReasoning(modelId) { return !!resolveModelProfile(modelId).supportsReasoning; }
function modelSupportsThinking(modelId) { return !!resolveModelProfile(modelId).supportsThinking; }
function modelHasCombinedBudget(modelId) { return !!resolveModelProfile(modelId).combinedBudget; }

function getCompactionThreshold(contextWindow, { model, requestedMaxTokens } = {}) {
  const profile = resolveModelProfile(model);
  if (profile.combinedBudget) {
    const totalWindow = Math.max(contextWindow || 0, profile.contextWindow || 204800);
    const outputReserve = requestedMaxTokens || profile.maxOutputTokens || 64000;
    return totalWindow - outputReserve - (profile.thinkingReserve || 0) - (profile.safetyBuffer || 2000);
  }
  return Math.floor((contextWindow || profile.contextWindow || 131072) * 0.88);
}

function getGenerationDefaults(modelId, source = {}) {
  const profile = resolveModelProfile(modelId);
  const result = {};
  if (source.temperature === undefined && profile.temperature !== undefined) result.temperature = profile.temperature;
  if (source.top_p === undefined && profile.topP !== undefined) result.top_p = profile.topP;
  if (source.top_k === undefined && profile.topK !== undefined) result.top_k = profile.topK;
  if ((source.max_tokens === undefined && source.max_output_tokens === undefined) && profile.maxOutputTokens !== undefined) result.max_tokens = profile.maxOutputTokens;
  return result;
}

function listKnownProfiles() {
  const entries = [];
  for (const [key, profile] of Object.entries(BUILTIN_PROFILES)) {
    if (key === '*') continue;
    entries.push({ model: key, ...profile });
  }
  return entries;
}

module.exports = { BUILTIN_PROFILES, resolveModelProfile, modelSupportsReasoning, modelSupportsThinking, modelHasCombinedBudget, getCompactionThreshold, getGenerationDefaults, listKnownProfiles };
