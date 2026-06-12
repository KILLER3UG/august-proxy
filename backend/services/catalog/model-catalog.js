/**
 * model-catalog.js — Structured model metadata registry
 * Inspired by OpenCode's ModelV2.Info and Hermes models.dev.
 * 
 * Each model entry has: id, provider, contextWindow, maxOutput, capabilities,
 * cost (per 1M tokens), limits, aliases, reasoning.
 */

const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, '..', '..', 'data', 'model-catalog.json');

// ── Internal State ──
let _models = new Map();
let _initialized = false;

// ── Model Entry ──

class ModelEntry {
  constructor(opts) {
    this.id = opts.id;
    this.provider = opts.provider || '';
    this.aliases = opts.aliases || [];
    this.displayName = opts.displayName || opts.id;
    this.contextWindow = opts.contextWindow || 8192;
    this.maxOutput = opts.maxOutput || 4096;
    this.maxInput = opts.maxInput || this.contextWindow;
    this.inputCostPer1M = opts.inputCostPer1M || 0;
    this.outputCostPer1M = opts.outputCostPer1M || 0;
    this.cacheReadCostPer1M = opts.cacheReadCostPer1M || 0;
    this.cacheWriteCostPer1M = opts.cacheWriteCostPer1M || 0;
    this.supportsStreaming = opts.supportsStreaming !== false;
    this.supportsVision = !!opts.supportsVision;
    this.supportsTools = opts.supportsTools !== false;
    this.supportsThinking = !!opts.supportsThinking;
    this.supportsReasoning = !!opts.supportsReasoning;
    this.supportsStructuredOutput = !!opts.supportsStructuredOutput;
    this.supportsFunctionCalling = opts.supportsFunctionCalling !== false;
    this.supportsMedia = !!opts.supportsMedia;  // audio/video input
    this.reasoningEffort = opts.reasoningEffort || null; // 'low' | 'medium' | 'high' | null
    this.capabilities = opts.capabilities || [];
    this.apiMode = opts.apiMode || 'openai_chat'; // openai_chat, anthropic_messages, bedrock_converse, codex_responses
    this.rateLimitTier = opts.rateLimitTier || 'standard'; // free | standard | premium | enterprise
    this.supportsThinkingBudget = !!opts.supportsThinkingBudget;
    this.thinkingBudgetMax = opts.thinkingBudgetMax || 0;
    this.labels = opts.labels || [];
    this.deprecated = !!opts.deprecated;
    this.released = opts.released || '';
    this.safetyBuffer = opts.safetyBuffer || 0;
    this.contextCompression = opts.contextCompression || false;
  }

  get isAvailable() {
    return !this.deprecated;
  }

  estimateCost(inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
    return {
      input: (inputTokens / 1_000_000) * this.inputCostPer1M,
      output: (outputTokens / 1_000_000) * this.outputCostPer1M,
      cacheRead: (cacheReadTokens / 1_000_000) * this.cacheReadCostPer1M,
      cacheWrite: (cacheWriteTokens / 1_000_000) * this.cacheWriteCostPer1M,
      total: 0
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.displayName,
      provider: this.provider,
      displayName: this.displayName,
      contextWindow: this.contextWindow,
      maxOutput: this.maxOutput,
      inputCostPer1M: this.inputCostPer1M,
      outputCostPer1M: this.outputCostPer1M,
      isFree: this.inputCostPer1M === 0 && this.outputCostPer1M === 0,
      supportsVision: this.supportsVision,
      supportsThinking: this.supportsThinking,
      supportsReasoning: this.supportsReasoning,
      capabilities: this.capabilities,
      apiMode: this.apiMode,
      deprecated: this.deprecated
    };
  }
}

// ── Canonical Model Definitions ──

const CANONICAL_MODELS = [
  // ── Anthropic ──
  { id: 'claude-opus-4-7', provider: 'anthropic', displayName: 'Claude Opus 4.7', contextWindow: 200000, maxOutput: 64000, inputCostPer1M: 15, outputCostPer1M: 75, supportsThinking: true, supportsReasoning: true, reasoningEffort: 'high', supportsVision: true, apiMode: 'anthropic_messages', capabilities: ['reasoning', 'thinking', 'vision', 'tools', 'extended-thinking'], thinkingBudgetMax: 128000 },
  { id: 'claude-opus-4-6', provider: 'anthropic', displayName: 'Claude Opus 4.6', contextWindow: 200000, maxOutput: 64000, inputCostPer1M: 15, outputCostPer1M: 75, supportsThinking: true, supportsReasoning: true, reasoningEffort: 'high', supportsVision: true, apiMode: 'anthropic_messages', capabilities: ['reasoning', 'thinking', 'vision', 'tools'], thinkingBudgetMax: 128000 },
  { id: 'claude-sonnet-4-6', provider: 'anthropic', displayName: 'Claude Sonnet 4.6', contextWindow: 200000, maxOutput: 64000, inputCostPer1M: 3, outputCostPer1M: 15, supportsThinking: true, supportsReasoning: true, reasoningEffort: 'medium', supportsVision: true, apiMode: 'anthropic_messages', capabilities: ['reasoning', 'thinking', 'vision', 'tools'], thinkingBudgetMax: 64000 },
  { id: 'claude-haiku-4-5', provider: 'anthropic', displayName: 'Claude Haiku 4.5', contextWindow: 200000, maxOutput: 8192, inputCostPer1M: 1, outputCostPer1M: 5, supportsVision: true, apiMode: 'anthropic_messages', capabilities: ['vision', 'tools'] },
  { id: 'claude-3-5-sonnet', provider: 'anthropic', displayName: 'Claude 3.5 Sonnet', contextWindow: 200000, maxOutput: 8192, inputCostPer1M: 3, outputCostPer1M: 15, supportsVision: true, apiMode: 'anthropic_messages', capabilities: ['vision', 'tools'] },

  // ── OpenAI ──
  { id: 'gpt-5.4', provider: 'openai-api', displayName: 'GPT 5.4', contextWindow: 256000, maxOutput: 100000, inputCostPer1M: 10, outputCostPer1M: 40, supportsReasoning: true, reasoningEffort: 'high', supportsVision: true, supportsStructuredOutput: true, apiMode: 'codex_responses', capabilities: ['reasoning', 'vision', 'structured-outputs', 'tools'] },
  { id: 'gpt-5.4-high', provider: 'openai-api', displayName: 'GPT 5.4 High Reasoning', contextWindow: 256000, maxOutput: 100000, inputCostPer1M: 10, outputCostPer1M: 40, supportsReasoning: true, reasoningEffort: 'high', supportsVision: true, supportsStructuredOutput: true, apiMode: 'codex_responses', capabilities: ['reasoning', 'vision', 'structured-outputs', 'tools'] },
  { id: 'gpt-4o', provider: 'openai-api', displayName: 'GPT 4o', contextWindow: 128000, maxOutput: 16384, inputCostPer1M: 2.5, outputCostPer1M: 10, supportsVision: true, supportsStructuredOutput: true, apiMode: 'openai_chat', capabilities: ['vision', 'structured-outputs', 'tools'] },
  { id: 'gpt-4o-mini', provider: 'openai-api', displayName: 'GPT 4o Mini', contextWindow: 128000, maxOutput: 16384, inputCostPer1M: 0.15, outputCostPer1M: 0.6, supportsVision: true, supportsStructuredOutput: true, apiMode: 'openai_chat', capabilities: ['vision', 'structured-outputs', 'tools'] },
  { id: 'o1', provider: 'openai-api', displayName: 'o1', contextWindow: 200000, maxOutput: 100000, inputCostPer1M: 15, outputCostPer1M: 60, supportsReasoning: true, reasoningEffort: 'high', apiMode: 'codex_responses', capabilities: ['reasoning', 'tools'] },
  { id: 'o3', provider: 'openai-api', displayName: 'o3', contextWindow: 200000, maxOutput: 100000, inputCostPer1M: 10, outputCostPer1M: 40, supportsReasoning: true, reasoningEffort: 'high', supportsVision: true, apiMode: 'codex_responses', capabilities: ['reasoning', 'vision', 'tools'] },

  // ── DeepSeek ──
  { id: 'deepseek-v4', provider: 'deepseek', displayName: 'DeepSeek V4', contextWindow: 131072, maxOutput: 8192, inputCostPer1M: 0.5, outputCostPer1M: 2, supportsReasoning: true, apiMode: 'openai_chat', capabilities: ['reasoning', 'tools'] },
  { id: 'deepseek-v4-flash', provider: 'deepseek', displayName: 'DeepSeek V4 Flash', contextWindow: 131072, maxOutput: 8192, inputCostPer1M: 0.3, outputCostPer1M: 1.2, apiMode: 'openai_chat', capabilities: ['tools'] },
  { id: 'deepseek-r1', provider: 'deepseek', displayName: 'DeepSeek R1', contextWindow: 131072, maxOutput: 8192, inputCostPer1M: 0.55, outputCostPer1M: 2.2, supportsReasoning: true, reasoningEffort: 'high', apiMode: 'openai_chat', capabilities: ['reasoning'] },

  // ── Google Gemini ──
  { id: 'gemini-2.5-pro', provider: 'gemini', displayName: 'Gemini 2.5 Pro', contextWindow: 1048576, maxOutput: 65536, inputCostPer1M: 1.25, outputCostPer1M: 10, supportsReasoning: true, supportsVision: true, supportsMedia: true, apiMode: 'openai_chat', capabilities: ['reasoning', 'vision', 'audio', 'long-context', 'tools'] },
  { id: 'gemini-2.0-flash', provider: 'gemini', displayName: 'Gemini 2.0 Flash', contextWindow: 1048576, maxOutput: 8192, inputCostPer1M: 0.1, outputCostPer1M: 0.4, supportsVision: true, apiMode: 'openai_chat', capabilities: ['vision', 'long-context', 'tools'] },

  // ── OpenRouter / OpenCode aggregator ──
  { id: 'deepseek-v4-flash', provider: 'opencode-go', displayName: 'DeepSeek V4 Flash (OpenCode)', contextWindow: 131072, maxOutput: 8192, aliases: ['flash'], apiMode: 'openai_chat', capabilities: ['tools'], inputCostPer1M: 0, outputCostPer1M: 0, rateLimitTier: 'free' },
  { id: 'deepseek-v4', provider: 'opencode-go', displayName: 'DeepSeek V4 (OpenCode)', contextWindow: 131072, maxOutput: 8192, apiMode: 'openai_chat', capabilities: ['reasoning', 'tools'], inputCostPer1M: 0, outputCostPer1M: 0, rateLimitTier: 'free' },
  { id: 'kimi-k2', provider: 'kimi-coding', displayName: 'Kimi K2', contextWindow: 131072, maxOutput: 8192, supportsReasoning: true, apiMode: 'openai_chat', capabilities: ['reasoning', 'tools'] },
  { id: 'qwen3', provider: 'alibaba', displayName: 'Qwen3', contextWindow: 131072, maxOutput: 8192, supportsReasoning: true, apiMode: 'openai_chat', capabilities: ['reasoning', 'tools'] },
  { id: 'glm-5', provider: 'zai', displayName: 'GLM 5', contextWindow: 131072, maxOutput: 8192, supportsReasoning: true, apiMode: 'openai_chat', capabilities: ['reasoning', 'tools'] },

  // ── xAI ──
  { id: 'grok-3', provider: 'xai', displayName: 'Grok 3', contextWindow: 131072, maxOutput: 8192, inputCostPer1M: 2, outputCostPer1M: 10, supportsReasoning: true, supportsVision: true, apiMode: 'codex_responses', capabilities: ['reasoning', 'vision', 'tools'] },

  // ── Meta ──
  { id: 'meta-llama-3.1-405b', provider: 'nvidia', displayName: 'Llama 3.1 405B', contextWindow: 131072, maxOutput: 4096, apiMode: 'openai_chat', capabilities: ['tools'] },
  { id: 'meta-llama-3.1-70b', provider: 'nvidia', displayName: 'Llama 3.1 70B', contextWindow: 131072, maxOutput: 4096, apiMode: 'openai_chat', capabilities: ['tools'] },

  // ── MiniMax ──
  { id: 'minimax-m2.7', provider: 'minimax', displayName: 'MiniMax M2.7', contextWindow: 204800, maxOutput: 64000, inputCostPer1M: 2, outputCostPer1M: 8, supportsThinking: true, supportsReasoning: true, apiMode: 'anthropic_messages', capabilities: ['thinking', 'reasoning', 'combined-budget'], thinkingBudgetMax: 64000, safetyBuffer: 4000 },

  // ── Nous Research ──
  { id: 'hermes-4', provider: 'nous', displayName: 'Hermes 4', contextWindow: 32768, maxOutput: 8192, apiMode: 'openai_chat', capabilities: ['tools'] },
  { id: 'hermes-4-flash', provider: 'nous', displayName: 'Hermes 4 Flash', contextWindow: 32768, maxOutput: 8192, apiMode: 'openai_chat', capabilities: ['tools'] },
];

// ── API ──

function init() {
  if (_initialized) return;
  _models.clear();
  for (const def of CANONICAL_MODELS) {
    _models.set(def.id, new ModelEntry(def));
    if (def.aliases) {
      for (const alias of def.aliases) {
        _models.set(alias, _models.get(def.id));
      }
    }
  }
  _initialized = true;
}

function get(id) {
  init();
  return _models.get(id) || null;
}

function findByProvider(provider) {
  init();
  return Array.from(_models.values()).filter(m => m.provider === provider && !m.deprecated);
}

function list(opts = {}) {
  init();
  let results = Array.from(_models.values());
  if (opts.provider) results = results.filter(m => m.provider === opts.provider);
  if (opts.capability) results = results.filter(m => m.capabilities.includes(opts.capability));
  if (opts.deprecated === false) results = results.filter(m => !m.deprecated);
  if (opts.free) results = results.filter(m => m.inputCostPer1M === 0 && m.outputCostPer1M === 0);
  return [...new Set(results)]; // dedupe by instance
}

function search(query) {
  init();
  const q = query.toLowerCase();
  return Array.from(_models.values())
    .filter(m => !m.deprecated)
    .filter(m => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q))
    .slice(0, 20);
}

function getCapabilities() {
  init();
  const caps = new Set();
  for (const m of _models.values()) {
    for (const c of m.capabilities) caps.add(c);
  }
  return Array.from(caps).sort();
}

function getAll() {
  init();
  return Array.from(_models.values()).map(m => m.toJSON());
}

// ── Load custom model overrides from JSON ──

function loadOverrides(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(data)) {
      for (const def of data) {
        _models.set(def.id, new ModelEntry(def));
        if (def.aliases) {
          for (const alias of def.aliases) _models.set(alias, _models.get(def.id));
        }
      }
    }
  } catch (e) {
    console.warn('[ModelCatalog] Failed to load overrides:', e.message);
  }
}

// ── Save to JSON for dashboard consumption ──

function saveToJson() {
  try {
    const data = getAll();
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(data, null, 2));
    return data.length;
  } catch (e) {
    console.warn('[ModelCatalog] Failed to save:', e.message);
    return 0;
  }
}

module.exports = {
  ModelEntry,
  init,
  get,
  findByProvider,
  list,
  search,
  getCapabilities,
  getAll,
  loadOverrides,
  saveToJson
};
