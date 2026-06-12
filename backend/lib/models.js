const { getConfig, saveConfig } = require('./config');
const { resolveModelProfile } = require('./model-profiles');

// ── Known model registry: model ID -> { inputTokens, outputTokens } ──
// Free-tier models commonly used with this proxy
const KNOWN_MODELS = {
  // OpenRouter
  'minimax/minimax-m2.5:free': { inputTokens: 256000, outputTokens: 8192 },
  'inclusionai/ling-2.6-1t:free': { inputTokens: 256000, outputTokens: 4096 },
  'google/gemini-2.0-flash-exp:free': { inputTokens: 1048576, outputTokens: 8192 },
  'tencent/hy3-preview:free': { inputTokens: 256000, outputTokens: 4096 },
  'meta-llama/llama-3.3-70b-instruct:free': { inputTokens: 131072, outputTokens: 8192 },
  'meta-llama/llama-3.1-8b-instruct:free': { inputTokens: 131072, outputTokens: 8192 },
  'nousresearch/hermes-3-llama-3.1-405b:free': { inputTokens: 131072, outputTokens: 8192 },
  'mistralai/mistral-7b-instruct:free': { inputTokens: 32768, outputTokens: 4096 },
  'mistralai/mixtral-8x7b-instruct:free': { inputTokens: 32768, outputTokens: 4096 },
  'google/gemini-flash-1.5:free': { inputTokens: 1048576, outputTokens: 8192 },
  'google/gemini-pro-1.5:free': { inputTokens: 2097152, outputTokens: 8192 },
  'deepseek/deepseek-chat:free': { inputTokens: 64000, outputTokens: 8192 },
  'qwen/qwen-2.5-72b-instruct:free': { inputTokens: 131072, outputTokens: 8192 },

  // Opencode / Kilocode shorthand IDs (without namespace)
  'minimax-m2.5-free': { inputTokens: 256000, outputTokens: 8192 },
  'ling-2.6-flash-free': { inputTokens: 256000, outputTokens: 4096 },
  'ling-2.6-1t-free': { inputTokens: 256000, outputTokens: 4096 },
  'hy3-preview-free': { inputTokens: 256000, outputTokens: 4096 },
  'gemini-2.0-flash-exp-free': { inputTokens: 1048576, outputTokens: 8192 },

  // MiniMax M2.7 — combined 204,800 token budget (input + output shared)
  'MiniMax-M2.7':           { inputTokens: 204800, outputTokens: 64000 },
  'minimax-m2.7':           { inputTokens: 204800, outputTokens: 64000 },
  'MiniMax-M2.7-highspeed': { inputTokens: 204800, outputTokens: 64000 },
  'minimax-m2.7-highspeed': { inputTokens: 204800, outputTokens: 64000 },

  // Generic fallbacks by family
  'gpt-4o': { inputTokens: 128000, outputTokens: 16384 },
  'gpt-4o-mini': { inputTokens: 128000, outputTokens: 16384 },
  'gpt-4-turbo': { inputTokens: 128000, outputTokens: 4096 },
  'claude-3-5-sonnet': { inputTokens: 200000, outputTokens: 8192 },
  'claude-3-5-haiku': { inputTokens: 200000, outputTokens: 4096 },
  'claude-3-opus': { inputTokens: 200000, outputTokens: 4096 },
};

// In-memory cache for model info fetched from APIs
const apiModelCache = new Map();
let apiFetchPromise = null;

function getDefaultContextWindow() {
  return { inputTokens: 32768, outputTokens: 4096 };
}

// ── Pattern-based inference from model ID ──
function inferFromModelId(modelId) {
  if (!modelId) return null;
  const id = modelId.toLowerCase();

  // Direct lookup (exact match)
  if (KNOWN_MODELS[modelId]) return { ...KNOWN_MODELS[modelId] };
  if (KNOWN_MODELS[id]) return { ...KNOWN_MODELS[id] };

  // Check for known family patterns
  if (id.includes('gemini-2.5-pro')) return { inputTokens: 2000000, outputTokens: 8192 };
  if (id.includes('gemini-2.5-flash')) return { inputTokens: 1000000, outputTokens: 8192 };
  if (id.includes('gemini-2.0')) return { inputTokens: 1048576, outputTokens: 8192 };
  if (id.includes('gemini-1.5-pro')) return { inputTokens: 2097152, outputTokens: 8192 };
  if (id.includes('gemini-1.5-flash')) return { inputTokens: 1048576, outputTokens: 8192 };
  if (id.includes('gemini')) return { inputTokens: 1048576, outputTokens: 8192 };
  if (id.includes('llama-3.3')) return { inputTokens: 131072, outputTokens: 8192 };
  if (id.includes('llama-3.2')) return { inputTokens: 131072, outputTokens: 8192 };
  if (id.includes('llama-3.1')) return { inputTokens: 131072, outputTokens: 8192 };
  if (id.includes('llama-3')) return { inputTokens: 8192, outputTokens: 4096 }; // llama-3 (not 3.1+)
  if (id.includes('llama3')) return { inputTokens: 8192, outputTokens: 4096 };
  if (id.includes('deepseek-reasoner')) return { inputTokens: 64000, outputTokens: 8192 };
  if (id.includes('deepseek-chat')) return { inputTokens: 128000, outputTokens: 8192 };
  if (id.includes('deepseek-r1')) return { inputTokens: 128000, outputTokens: 8192 };
  if (id.includes('deepseek')) return { inputTokens: 128000, outputTokens: 8192 };
  if (id.includes('qwen-2.5')) return { inputTokens: 131072, outputTokens: 8192 };
  if (id.includes('qwen')) return { inputTokens: 32768, outputTokens: 4096 };
  if (id.includes('mixtral')) return { inputTokens: 32768, outputTokens: 4096 };
  if (id.includes('mistral')) return { inputTokens: 32768, outputTokens: 4096 };
  if (id.includes('minimax')) {
    // M2.7 has a combined 204,800 token budget — distinct from M2.5's 256k input budget
    if (id.includes('m2.7') || id.includes('m2-7')) {
      return { inputTokens: 204800, outputTokens: 64000 };
    }
    return { inputTokens: 245760, outputTokens: 8192 }; // M2.5 and earlier
  }
  if (id.includes('ling-')) return { inputTokens: 256000, outputTokens: 4096 };
  if (id.includes('hy3')) return { inputTokens: 256000, outputTokens: 4096 };
  if (id.includes('gpt-4o')) return { inputTokens: 128000, outputTokens: 16384 };
  if (id.includes('gpt-4')) return { inputTokens: 128000, outputTokens: 8192 };
  if (id.includes('o1')) return { inputTokens: 200000, outputTokens: 8192 };
  if (id.includes('o3')) return { inputTokens: 200000, outputTokens: 8192 };
  if (id.includes('claude')) return { inputTokens: 200000, outputTokens: 8192 };

  // Pattern inference: look for explicit context size in name
  const contextMatch = id.match(/[-/](\d+)(k|m)\b/);
  if (contextMatch) {
    const num = parseInt(contextMatch[1], 10);
    const unit = contextMatch[2];
    const inputTokens = unit === 'm' ? num * 1048576 : num * 1024;
    return { inputTokens, outputTokens: Math.min(inputTokens / 4, 8192) };
  }

  return null;
}

// ── Fetch model list from OpenRouter API (cached) ──
async function fetchOpenRouterModels() {
  if (apiFetchPromise) return apiFetchPromise;

  apiFetchPromise = (async () => {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = data.data || [];
      models.forEach(m => {
        if (m.id && m.context_length) {
          apiModelCache.set(m.id.toLowerCase(), {
            inputTokens: m.context_length,
            outputTokens: m.top_provider?.max_completion_tokens || Math.min(m.context_length / 4, 8192)
          });
        }
      });
      console.log(`[Proxy Models]: Cached ${apiModelCache.size} models from OpenRouter`);
    } catch (e) {
      console.log(`[Proxy Models]: OpenRouter fetch failed: ${e.message}`);
    }
  })();

  return apiFetchPromise;
}

// ── Derive /models URL from any provider endpoint ──
function deriveModelsUrl(providerUrl) {
  if (!providerUrl) return '';
  let normalized = providerUrl.trim()
    .replace(/\/v1\/messages$/i, '')
    .replace(/\/messages$/i, '')
    .replace(/\/v1\/chat\/completions$/i, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/v1\/responses$/i, '')
    .replace(/\/responses$/i, '')
    .replace(/\/v1\/models$/i, '')
    .replace(/\/models$/i, '')
    .replace(/\/v1\/text\/chatcompletion_v2$/i, '')
    .replace(/\/text\/chatcompletion_v2$/i, '')
    .replace(/\/anthropic$/i, '');
  if (!normalized) return '';
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  // Special case: Google AI Studio's OpenAI-compat path already ends in /openai
  // which is the correct base — do NOT append /v1 or it becomes …/openai/v1/models
  if (/generativelanguage\.googleapis\.com/i.test(normalized) && /\/openai$/i.test(normalized)) {
    return `${normalized}/models`;
  }
  if (!/\/v\d+$/i.test(normalized) && !/\/api\/v\d+$/i.test(normalized)) normalized += '/v1';
  return `${normalized}/models`;
}

// ── Main entry point: get context window for a model ──
async function getModelContextWindow(modelId, providerUrl, apiKey) {
  if (!modelId) return getDefaultContextWindow();

  // 1. Try API cache first (fast, no network)
  const cached = apiModelCache.get(modelId.toLowerCase());
  if (cached) return { ...cached };

  // 2. Try fetching from the provider's own /models endpoint.
  //    This gives the most accurate value for the specific provider/base URL,
  //    so it takes priority over static pattern inference.
  if (providerUrl && apiKey) {
    try {
      const modelsUrl = deriveModelsUrl(providerUrl);
      const res = await fetch(modelsUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        const data = await res.json();
        const models = data.data || data.models || data || [];
        const found = models.find(m => m.id === modelId || m.id?.toLowerCase() === modelId.toLowerCase());
        if (found && found.context_length) {
          const result = {
            inputTokens: found.context_length,
            outputTokens: found.top_provider?.max_completion_tokens || Math.min(found.context_length / 4, 8192)
          };
          apiModelCache.set(modelId.toLowerCase(), result);
          console.log(`[Proxy Models]: Found ${modelId} from provider API: ${result.inputTokens} input / ${result.outputTokens} output`);
          return result;
        }
      }
    } catch (e) {
      // Provider API fetch failed, continue to fallback
    }
  }

  // 3. Try pattern inference (fast fallback for known model families)
  const inferred = inferFromModelId(modelId);
  if (inferred) {
    console.log(`[Proxy Models]: Inferred context window for ${modelId}: ${inferred.inputTokens} input / ${inferred.outputTokens} output`);
    return inferred;
  }

  // 4. Try OpenRouter API as last resort (with caching)
  await fetchOpenRouterModels();
  const orCached = apiModelCache.get(modelId.toLowerCase());
  if (orCached) return { ...orCached };

  // 5. Safe default
  console.log(`[Proxy Models]: Unknown model ${modelId}, using default context window`);
  return getDefaultContextWindow();
}

// ── Store detected context window in profile config ──
function saveModelContextWindow(profileName, modelId, contextWindow) {
  try {
    const config = getConfig();
    if (!config[profileName]) return;
    config[profileName].contextWindow = contextWindow;
    config[profileName].contextModelId = modelId;
    saveConfig(config);
  } catch (e) {
    // Ignore save errors
  }
}

// ── Load cached context window from profile ──
function loadModelContextWindow(profileName, modelId) {
  try {
    const config = getConfig();
    const profile = config[profileName];
    if (profile && profile.contextModelId === modelId && profile.contextWindow) {
      const inferred = inferFromModelId(modelId);
      if (inferred && Number(profile.contextWindow) !== inferred.inputTokens) {
        console.log(`[Proxy Models]: Ignoring stale cached context window for ${modelId}: ${profile.contextWindow} -> ${inferred.inputTokens}`);
        return null;
      }
      return profile.contextWindow;
    }
  } catch (e) {
    // Ignore load errors
  }
  return null;
}

module.exports = {
  getModelContextWindow,
  getDefaultContextWindow,
  saveModelContextWindow,
  loadModelContextWindow,
  inferFromModelId,
  deriveModelsUrl
};
