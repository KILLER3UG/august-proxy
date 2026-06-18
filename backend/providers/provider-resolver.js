const { getProvider, listProviders } = require('./provider-registry');
const { getConfig } = require('../lib/config');

class ResolvedProvider {
  constructor({
    profile, baseUrl, apiKey, model, apiMode,
    defaultModel, fallbackModels, defaultHeaders,
    defaultMaxTokens, supportsStreaming, authType,
    defaultAuxModel, supportsHealthCheck,
    modelProfiles,
    aliasTargets = {},
    maxTokens, contextWindow, contextModelId,
    thinkingEffort, inputCostPer1M, outputCostPer1M,
  } = {}) {
    this.profile = profile;
    this.name = profile?.name || 'unknown';
    this.displayName = profile?.displayName || this.name;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.apiMode = apiMode || profile?.apiMode || 'openai_chat';
    this.defaultModel = defaultModel || profile?.defaultModel || '';
    this.fallbackModels = fallbackModels || profile?.fallbackModels || [];
    this.defaultHeaders = defaultHeaders || profile?.defaultHeaders || {};
    this.defaultMaxTokens = defaultMaxTokens ?? profile?.defaultMaxTokens ?? 4096;
    this.supportsStreaming = supportsStreaming ?? profile?.supportsStreaming ?? true;
    this.authType = authType || profile?.authType || 'api_key';
    this.defaultAuxModel = defaultAuxModel || profile?.defaultAuxModel || '';
    this.supportsHealthCheck = supportsHealthCheck ?? profile?.supportsHealthCheck ?? false;
    this._modelProfiles = modelProfiles || {};
    this.aliasTargets = aliasTargets;
    this.maxTokens = maxTokens;
    this.contextWindow = contextWindow;
    this.contextModelId = contextModelId;
    this.thinkingEffort = thinkingEffort;
    this.inputCostPer1M = inputCostPer1M;
    this.outputCostPer1M = outputCostPer1M;
  }

  getModelProfile(modelId) {
    if (!modelId || typeof modelId !== 'string') return null;
    const lower = modelId.toLowerCase().trim();
    if (this._modelProfiles[lower]) return { ...this._modelProfiles[lower] };
    const keys = Object.keys(this._modelProfiles).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (key === '*') continue;
      if (lower.startsWith(key)) return { ...this._modelProfiles[key] };
    }
    return this._modelProfiles['*'] ? { ...this._modelProfiles['*'] } : null;
  }

  resolveAliasTarget(publicAlias) {
    if (!publicAlias || !this.aliasTargets || typeof this.aliasTargets !== 'object') return null;
    return this.aliasTargets[publicAlias] || null;
  }

  fetchModels() {
    if (this.profile && typeof this.profile.fetchModels === 'function') {
      return this.profile.fetchModels(this.apiKey);
    }
    return [];
  }

  isAvailable() {
    return !!(this.baseUrl && this.apiKey);
  }

  getMaxTokens(model) {
    const mp = this.getModelProfile(model);
    if (mp && mp.maxOutputTokens !== undefined) return mp.maxOutputTokens;
    if (this.profile && typeof this.profile.getMaxTokens === 'function') return this.profile.getMaxTokens(model);
    return this.defaultMaxTokens;
  }

  getCompactionThreshold(contextWindow, { model, requestedMaxTokens } = {}) {
    if (this.profile && typeof this.profile.getCompactionThreshold === 'function') {
      return this.profile.getCompactionThreshold(contextWindow, { model, requestedMaxTokens });
    }
    const mp = this.getModelProfile(model);
    if (mp && mp.combinedBudget) {
      const totalWindow = Math.max(contextWindow || 0, mp.contextWindow || 204800);
      const outputReserve = requestedMaxTokens || mp.maxOutputTokens || 64000;
      return totalWindow - outputReserve - (mp.thinkingReserve || 0) - (mp.safetyBuffer || 2000);
    }
    return Math.floor((contextWindow || (mp?.contextWindow) || 131072) * 0.88);
  }

  getGenerationDefaults(modelId, source = {}) {
    if (this.profile && typeof this.profile.getGenerationDefaults === 'function') {
      return this.profile.getGenerationDefaults(modelId, source);
    }
    const mp = this.getModelProfile(modelId);
    const result = {};
    if (source.temperature === undefined && mp?.temperature !== undefined) result.temperature = mp.temperature;
    if (source.top_p === undefined && mp?.topP !== undefined) result.top_p = mp.topP;
    if (source.top_k === undefined && mp?.topK !== undefined) result.top_k = mp.topK;
    if ((source.max_tokens === undefined && source.max_output_tokens === undefined) && mp?.maxOutputTokens !== undefined) {
      result.max_tokens = mp.maxOutputTokens;
    }
    return result;
  }

  modelSupportsReasoning(modelId) {
    return !!this.getModelProfile(modelId)?.supportsReasoning;
  }

  modelSupportsThinking(modelId) {
    return !!this.getModelProfile(modelId)?.supportsThinking;
  }

  modelHasCombinedBudget(modelId) {
    return !!this.getModelProfile(modelId)?.combinedBudget;
  }
}

function mergeProfileWithConfig(profile, configOverrides = {}) {
  return {
    profile,
    baseUrl: configOverrides.baseUrl || configOverrides.targetUrl || profile.resolveBaseUrl(),
    apiKey: configOverrides.apiKey || profile.resolveApiKey(),
    model: configOverrides.model || configOverrides._upstreamModel || configOverrides.currentModel || profile.defaultModel,
    apiMode: configOverrides.apiMode || profile.apiMode,
    defaultModel: profile.defaultModel,
    fallbackModels: profile.fallbackModels,
    defaultHeaders: { ...profile.defaultHeaders, ...configOverrides.headers },
    defaultMaxTokens: configOverrides.defaultMaxTokens ?? profile.defaultMaxTokens,
    supportsStreaming: configOverrides.supportsStreaming ?? profile.supportsStreaming,
    authType: configOverrides.authType || profile.authType,
    defaultAuxModel: configOverrides.defaultAuxModel || profile.defaultAuxModel,
    supportsHealthCheck: configOverrides.supportsHealthCheck ?? profile.supportsHealthCheck,
    modelProfiles: { ...profile._modelProfiles, ...configOverrides.modelProfiles },
    aliasTargets: configOverrides.aliasTargets || {},
    maxTokens: configOverrides.max_tokens || configOverrides.maxTokens,
    contextWindow: configOverrides.contextWindow,
    contextModelId: configOverrides.contextModelId,
    thinkingEffort: configOverrides.thinkingEffort,
    inputCostPer1M: configOverrides.inputCostPer1M,
    outputCostPer1M: configOverrides.outputCostPer1M,
  };
}

function resolveProvider(providerNameOrAlias, configOverrides = {}) {
  const profile = getProvider(providerNameOrAlias);
  if (!profile) return null;
  const merged = mergeProfileWithConfig(profile, configOverrides);
  return new ResolvedProvider(merged);
}

function resolveActiveProvider(configOverrides = {}) {
  const cfg = getConfig();
  const active = cfg.activeProvider || 'opencode-go';

  // Check specialist endpoints - they take priority if configured and match
  const specialistEndpoints = cfg.specialistEndpoints || {};
  for (const [role, ep] of Object.entries(specialistEndpoints)) {
    if (ep && ep.url && ep.model && active === `specialist-${role}`) {
      return new ResolvedProvider({
        profile: null,
        name: `specialist-${role}`,
        displayName: `Specialist ${role.charAt(0).toUpperCase() + role.slice(1)}`,
        baseUrl: ep.url,
        apiKey: ep.apiKey,
        model: ep.model,
        apiMode: 'openai_chat',
        defaultMaxTokens: ep.maxTokens || 4096,
        supportsHealthCheck: false,
      });
    }
  }

  // 1. Try the explicitly set active provider (or default).
  const activeResult = resolveProvider(active, { ...cfg[active], ...configOverrides });
  if (activeResult && activeResult.baseUrl && activeResult.apiKey) {
    return activeResult;
  }

  // 2. Fallback: try any provider with an apiKey in config.
  for (const [name, providerCfg] of Object.entries(cfg)) {
    if (name === 'activeProvider' || name === 'claude' || name === 'codex' ||
        name === 'bookmarks' || name === 'serviceConnections' || name === 'specialistEndpoints') continue;
    if (providerCfg && typeof providerCfg === 'object' && providerCfg.apiKey) {
      const result = resolveProvider(name, { ...providerCfg, ...configOverrides });
      if (result && result.baseUrl && result.apiKey) return result;
    }
  }

  // 3. Fallback: try any registered provider with env vars set.
  for (const p of listProviders()) {
    const config = cfg[p.name] || {};
    const apiKey = config.apiKey || p.resolveApiKey();
    if (apiKey) {
      const result = resolveProvider(p.name, { ...config, ...configOverrides });
      if (result && result.baseUrl && result.apiKey) return result;
    }
  }

  // 4. Last resort: return the original attempt (likely has no key).
  return activeResult;
}

function resolveSpecialistEndpoint(role, configOverrides = {}) {
  const cfg = getConfig();
  const endpoints = cfg.specialistEndpoints || {};
  const ep = endpoints[role];
  if (!ep || !ep.url || !ep.model) return null;
  return new ResolvedProvider({
    profile: null,
    name: `specialist-${role}`,
    displayName: `Specialist ${role.charAt(0).toUpperCase() + role.slice(1)}`,
    baseUrl: ep.url,
    apiKey: ep.apiKey || process.env[`${role.toUpperCase()}_API_KEY`] || '',
    model: ep.model,
    apiMode: 'openai_chat',
    defaultMaxTokens: ep.maxTokens || 4096,
    supportsHealthCheck: false,
    ...configOverrides,
  });
}

function resolveProviderForClient(clientType, configOverrides = {}) {
  const cfg = getConfig();
  const legacyProfiles = { claude: cfg.claude, codex: cfg.codex };
  if (cfg.activeProvider) {
    const resolved = resolveActiveProvider(configOverrides);
    if (resolved) return resolved;
  }
  return null;
}

module.exports = {
  ResolvedProvider,
  resolveProvider,
  resolveActiveProvider,
  resolveProviderForClient,
  resolveSpecialistEndpoint,
  mergeProfileWithConfig,
};
