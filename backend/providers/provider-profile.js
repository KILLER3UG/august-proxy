const profileDefaults = new Map();

class ProviderProfile {
  constructor({
    name, aliases = [], displayName = '', description = '',
    baseUrl = '', apiMode = 'openai_chat',
    envVars = [], authType = 'api_key',
    defaultModel = '', fallbackModels = [],
    defaultHeaders = {}, defaultMaxTokens = 4096,
    supportsStreaming = true,
    defaultAuxModel = '',
    signupUrl = '',
    supportsHealthCheck = false,
    modelProfiles = {},
  }) {
    this.name = name;
    this.aliases = aliases;
    this.displayName = displayName || name;
    this.description = description;
    this.baseUrl = baseUrl;
    this.apiMode = apiMode;
    this.envVars = envVars;
    this.authType = authType;
    this.defaultModel = defaultModel;
    this.fallbackModels = fallbackModels;
    this.defaultHeaders = defaultHeaders;
    this.defaultMaxTokens = defaultMaxTokens;
    this.supportsStreaming = supportsStreaming;
    this.defaultAuxModel = defaultAuxModel;
    this.signupUrl = signupUrl;
    this.supportsHealthCheck = supportsHealthCheck;
    this._modelProfiles = modelProfiles;
  }

  fetchModels(apiKey) {
    return [];
  }

  /**
   * Optional native-quota probe. Returns `{ used, limit, resetsAt }` or
   * null if the provider doesn't expose a daily-quota API (or it isn't
   * implemented yet). The quota-store merges this with locally recorded
   * usage, preferring the native number when present.
   */
  async getNativeQuota(/* model */) {
    return null;
  }

  buildExtraBody(opts = {}) {
    return {};
  }

  getMaxTokens(model) {
    return this.defaultMaxTokens;
  }

  resolveBaseUrl() {
    const urlEnvVar = this.envVars.find(v => v.endsWith('_BASE_URL'));
    return (urlEnvVar && process.env[urlEnvVar]) || this.baseUrl;
  }

  resolveApiKey() {
    const keyEnvVar = this.envVars.find(v => !v.endsWith('_BASE_URL'));
    return (keyEnvVar && process.env[keyEnvVar]) || '';
  }

  isAvailable() {
    if (this.envVars.length === 0) return false;
    return this.envVars.some(v => {
      if (v.endsWith('_BASE_URL')) return false;
      return !!process.env[v];
    });
  }

  getModelProfile(modelId) {
    if (!modelId || typeof modelId !== 'string') return null;
    let lower = modelId.toLowerCase().trim();
    // Strip provider prefix if present (e.g., opencode-go/claudekit -> claudekit)
    const slashIdx = lower.indexOf('/');
    const colonIdx = lower.indexOf(':');
    const sep = slashIdx >= 0 ? slashIdx : colonIdx >= 0 ? colonIdx : -1;
    const baseModel = sep >= 0 ? lower.slice(sep + 1) : lower;

    if (this._modelProfiles[baseModel]) return { ...this._modelProfiles[baseModel] };
    if (this._modelProfiles[lower]) return { ...this._modelProfiles[lower] };

    const keys = Object.keys(this._modelProfiles).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (key === '*') continue;
      const lowerKey = key.toLowerCase();
      if (baseModel.startsWith(lowerKey) || lower.startsWith(lowerKey)) {
        return { ...this._modelProfiles[key] };
      }
    }
    return this._modelProfiles['*'] ? { ...this._modelProfiles['*'] } : null;
  }

  getCompactionThreshold(contextWindow, { model, requestedMaxTokens } = {}) {
    const mp = this.getModelProfile(model);
    if (mp && mp.combinedBudget) {
      const totalWindow = Math.max(contextWindow || 0, mp.contextWindow || 204800);
      const outputReserve = requestedMaxTokens || mp.maxOutputTokens || 64000;
      return totalWindow - outputReserve - (mp.thinkingReserve || 0) - (mp.safetyBuffer || 2000);
    }
    return Math.floor((contextWindow || (mp?.contextWindow) || 131072) * 0.88);
  }

  getGenerationDefaults(modelId, source = {}) {
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

  getModelContextWindow(modelId) {
    const mp = this.getModelProfile(modelId);
    return mp?.contextWindow || null;
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

module.exports = { ProviderProfile };
