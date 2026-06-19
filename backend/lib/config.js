const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-paths');

const CONFIG_PATH = dataPath('config.json');
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

let envLoaded = false;

function stripWrappingQuotes(value) {
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
            return value.slice(1, -1);
        }
    }
    return value;
}

function loadLocalEnvFile() {
    if (envLoaded) return;
    envLoaded = true;

    if (!fs.existsSync(ENV_PATH)) return;

    try {
        const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            const separatorIndex = trimmed.indexOf('=');
            if (separatorIndex === -1) continue;

            const key = trimmed.slice(0, separatorIndex).trim();
            if (!key || process.env[key] !== undefined) continue;

            const rawValue = trimmed.slice(separatorIndex + 1).trim();
            process.env[key] = stripWrappingQuotes(rawValue);
        }
    } catch (e) {
        console.warn(`[Config] Warning: failed to load .env file: ${e.message}`);
    }
}

loadLocalEnvFile();

// ── Env-var expansion: ${env:VAR_NAME} → process.env.VAR_NAME ──
// Runs recursively over the config object after loading from disk.
// The original placeholder strings are preserved on disk — only the
// in-memory copy has real values, so secrets are never written back.
function expandEnvVars(value) {
    if (typeof value === 'string') {
        return value.replace(/\$\{env:([^}]+)\}/g, (match, varName) => {
            const resolved = process.env[varName.trim()];
            if (resolved === undefined) {
                console.warn(`[Config] Warning: env var '${varName}' referenced in config.json is not set.`);
                return match; // keep the placeholder so it's obvious something is missing
            }
            return resolved;
        });
    }
    if (Array.isArray(value)) return value.map(expandEnvVars);
    if (value && typeof value === 'object') {
        const expanded = {};
        for (const [k, v] of Object.entries(value)) expanded[k] = expandEnvVars(v);
        return expanded;
    }
    return value;
}

// Strip resolved env values back to placeholders before writing to disk.
// Matches any value that looks like a real secret (long alphanum strings)
// against what the env vars hold, and substitutes back the placeholder.
function collapseEnvVars(resolvedConfig) {
    // Build a reverse map: resolvedValue -> "${env:VAR_NAME}"
    const reverseMap = new Map();
    function collectPlaceholders(raw, resolved) {
        if (typeof raw === 'string' && typeof resolved === 'string') {
            const match = raw.match(/^\$\{env:([^}]+)\}$/);
            if (match && resolved && resolved !== raw) {
                reverseMap.set(resolved, raw);
            }
        } else if (raw && typeof raw === 'object' && resolved && typeof resolved === 'object') {
            for (const k of Object.keys(raw)) collectPlaceholders(raw[k], resolved[k]);
        }
    }
    try {
        const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        collectPlaceholders(onDisk, resolvedConfig);
    } catch (e) { /* ignore — best effort */ }

    function collapseValue(val) {
        if (typeof val === 'string') return reverseMap.has(val) ? reverseMap.get(val) : val;
        if (Array.isArray(val)) return val.map(collapseValue);
        if (val && typeof val === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(val)) out[k] = collapseValue(v);
            return out;
        }
        return val;
    }
    return collapseValue(resolvedConfig);
}

let cachedConfig = null;
let cachedMtime = 0;
const DEFAULT_CLAUDE_PUBLIC_MODEL = 'claude-opus-4-6';
const DEFAULT_GPT_PUBLIC_MODEL = 'gpt-4o';

function looksLikeClaudePublicModel(model) {
    return typeof model === 'string' && model.trim().toLowerCase().startsWith('claude-');
}

function looksLikeGptPublicModel(model) {
    return typeof model === 'string' && model.trim().toLowerCase().startsWith('gpt-');
}

function normalizeClaudeProfile(profile) {
    const normalized = { ...(profile || {}) };
    const currentModel = typeof normalized.currentModel === 'string' ? normalized.currentModel.trim() : '';
    const preservedAlias = looksLikeClaudePublicModel(currentModel)
        ? currentModel
        : DEFAULT_CLAUDE_PUBLIC_MODEL;

    if (!looksLikeClaudePublicModel(currentModel) && currentModel) {
        if (normalized._upstreamModel === undefined) {
            normalized._upstreamModel = currentModel;
        }
        normalized.currentModel = preservedAlias;
        return normalized;
    }

    if (!currentModel) {
        normalized.currentModel = preservedAlias;
    }

    return normalized;
}

function normalizeGptProfile(profile) {
    const normalized = { ...(profile || {}) };
    const currentModel = typeof normalized.currentModel === 'string' ? normalized.currentModel.trim() : '';
    const preservedAlias = looksLikeGptPublicModel(currentModel)
        ? currentModel
        : DEFAULT_GPT_PUBLIC_MODEL;

    if (!looksLikeGptPublicModel(currentModel) && currentModel) {
        if (normalized._upstreamModel === undefined) {
            normalized._upstreamModel = currentModel;
        }
        normalized.currentModel = preservedAlias;
        return normalized;
    }

    if (!currentModel) {
        normalized.currentModel = preservedAlias;
    }

    return normalized;
}

function applySecurityDefaults(config) {
    const out = config && typeof config === 'object' ? config : {};
    const sec = out.security && typeof out.security === 'object' ? out.security : {};
    if (!Array.isArray(sec.allowedRoots)) sec.allowedRoots = [];
    if (sec.filesystemScope !== 'root') sec.filesystemScope = 'allowlist';
    if (typeof sec.postObservationScreenshot !== 'boolean') sec.postObservationScreenshot = true;
    out.security = sec;
    return out;
}

function getConfig() {
    try {
        const stats = fs.statSync(CONFIG_PATH);
        if (!cachedConfig || stats.mtimeMs > cachedMtime) {
            const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            const expanded = expandEnvVars(raw); // resolve ${env:VAR} placeholders in-memory
            cachedConfig = applySecurityDefaults(expanded);
            cachedMtime = stats.mtimeMs;
            console.log('[Config] Reloaded from disk (mtime changed)');
        }
    } catch (e) {
        if (!cachedConfig) throw e;
        console.error('[Config] Failed to reload config, using cache:', e.message);
    }
    return cachedConfig;
}

function saveConfig(config) {
    // Collapse resolved env-var values back to ${env:VAR} placeholders before writing.
    // This prevents secrets from being persisted to disk when the UI saves settings.
    const safeToWrite = collapseEnvVars(config);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(safeToWrite, null, 2));
    cachedConfig = config; // keep the in-memory resolved copy
    try {
        cachedMtime = fs.statSync(CONFIG_PATH).mtimeMs;
    } catch (e) {
        cachedMtime = Date.now();
    }
}

// Get a profile config (claude or codex).
// Falls back to flat format for backward compatibility.
function getProfile(name) {
    const config = getConfig();
    if (config[name] && typeof config[name] === 'object' && config[name].targetUrl) {
        return name === 'claude' ? normalizeClaudeProfile(config[name]) : normalizeGptProfile(config[name]);
    }
    // Old flat format fallback
    const profile = {
        targetUrl: config.targetUrl,
        currentModel: config.currentModel,
        apiKey: config.apiKey
    };
    return name === 'claude' ? normalizeClaudeProfile(profile) : normalizeGptProfile(profile);
}

// Get a specific field from a profile, with fallback
function getProfileField(name, field, defaultValue) {
    const profile = getProfile(name);
    return profile[field] !== undefined ? profile[field] : defaultValue;
}

// Save a profile config. Migrates from flat format if needed.
function saveProfile(name, profileConfig) {
    const config = getConfig();

    // Migrate from flat format if we see old root-level keys and no profiles
    if (config.targetUrl && !config.claude && !config.codex) {
        const oldConfig = {
            targetUrl: config.targetUrl,
            currentModel: config.currentModel,
            apiKey: config.apiKey
        };
        config.claude = { ...oldConfig };
        config.codex = { ...oldConfig };
        delete config.targetUrl;
        delete config.currentModel;
        delete config.apiKey;
    }

    const previousProfile = config[name] && typeof config[name] === 'object'
        ? (name === 'claude' ? normalizeClaudeProfile(config[name]) : normalizeGptProfile(config[name]))
        : null;
    const normalizedProfileConfig = name === 'claude'
        ? normalizeClaudeProfile(profileConfig)
        : normalizeGptProfile(profileConfig);
    const previousContextModel = name === 'claude'
        ? (previousProfile?._upstreamModel || previousProfile?.currentModel)
        : previousProfile?.currentModel;
    const nextContextModel = name === 'claude'
        ? (normalizedProfileConfig._upstreamModel || normalizedProfileConfig.currentModel)
        : normalizedProfileConfig.currentModel;
    const modelChanged = previousContextModel && previousContextModel !== nextContextModel;

    const preservedInternalFields = {};
    if (previousProfile && typeof previousProfile === 'object') {
        Object.entries(previousProfile).forEach(([key, value]) => {
            if (key.startsWith('_') && normalizedProfileConfig[key] === undefined) {
                preservedInternalFields[key] = value;
            }
        });
    }

    config[name] = { ...normalizedProfileConfig, ...preservedInternalFields };
    if (modelChanged) {
        delete config[name].contextWindow;
        delete config[name].contextModelId;
    } else if (previousProfile?.contextModelId && config[name].contextModelId === undefined) {
        config[name].contextModelId = previousProfile.contextModelId;
    }
    saveConfig(config);
}

function syncClaudePublicAlias(publicAlias) {
    if (!looksLikeClaudePublicModel(publicAlias)) return null;

    const config = getConfig();
    const existingProfile = config.claude && typeof config.claude === 'object'
        ? normalizeClaudeProfile(config.claude)
        : normalizeClaudeProfile({});
    const normalizedAlias = publicAlias.trim();

    if (existingProfile.currentModel === normalizedAlias) {
        return existingProfile;
    }

    config.claude = {
        ...existingProfile,
        currentModel: normalizedAlias
    };
    saveConfig(config);
    return config.claude;
}

function syncGptPublicAlias(publicAlias) {
    if (!looksLikeGptPublicModel(publicAlias)) return null;

    const config = getConfig();
    const existingProfile = config.codex && typeof config.codex === 'object'
        ? normalizeGptProfile(config.codex)
        : normalizeGptProfile({});
    const normalizedAlias = publicAlias.trim();

    if (existingProfile.currentModel === normalizedAlias) {
        return existingProfile;
    }

    config.codex = {
        ...existingProfile,
        currentModel: normalizedAlias
    };
    saveConfig(config);
    return config.codex;
}

// ── Custom Provider Bookmarks ──
function getBookmarks() {
    const config = getConfig();
    return config.bookmarks || [];
}

function saveBookmark(name, baseUrl, apiKey, inputCostPer1M, outputCostPer1M) {
    const config = getConfig();
    if (!config.bookmarks) config.bookmarks = [];
    const existingIndex = config.bookmarks.findIndex(b => b.name === name);
    const bookmark = { name, baseUrl, apiKey, inputCostPer1M: inputCostPer1M || 0, outputCostPer1M: outputCostPer1M || 0 };
    if (existingIndex >= 0) {
        config.bookmarks[existingIndex] = bookmark;
    } else {
        config.bookmarks.push(bookmark);
    }
    saveConfig(config);
    return bookmark;
}

function deleteBookmark(name) {
    const config = getConfig();
    if (!config.bookmarks) return false;
    const before = config.bookmarks.length;
    config.bookmarks = config.bookmarks.filter(b => b.name !== name);
    if (config.bookmarks.length < before) {
        saveConfig(config);
        return true;
    }
    return false;
}



function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return [];
  try { return fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/); }
  catch (e) { return []; }
}

function writeEnvFile(lines) {
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');
  envLoaded = false;
  loadLocalEnvFile();
}

function getEnvVars() {
  const lines = readEnvFile();
  const vars = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf('=');
    if (sep === -1) continue;
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    vars.push({ key, value: stripWrappingQuotes(value), set: !!process.env[key] });
  }
  return vars;
}

function setEnvVar(key, value) {
  const lines = readEnvFile();
  const existingIdx = lines.findIndex(l => {
    const trimmed = l.trim();
    if (trimmed.startsWith('#')) return false;
    const sep = trimmed.indexOf('=');
    if (sep === -1) return false;
    return trimmed.slice(0, sep).trim() === key;
  });
  const newLine = key + '=' + value;
  if (existingIdx >= 0) lines[existingIdx] = newLine;
  else lines.push(newLine);
  writeEnvFile(lines);
  process.env[key] = value;
}

function deleteEnvVar(key) {
  const lines = readEnvFile();
  const filtered = lines.filter(l => {
    const trimmed = l.trim();
    if (trimmed.startsWith('#')) return true;
    const sep = trimmed.indexOf('=');
    if (sep === -1) return true;
    return trimmed.slice(0, sep).trim() !== key;
  });
  writeEnvFile(filtered);
  delete process.env[key];
}

function getProviderRequiredEnvVars() {
  try {
    const { listProviders } = require('../providers/provider-registry');
    let result = {};
    for (const p of listProviders()) {
      const keyVars = p.envVars.filter(v => !v.endsWith('_BASE_URL'));
      if (keyVars.length > 0) {
        result[p.name] = { displayName: p.displayName, vars: keyVars.map(v => ({ name: v, set: !!process.env[v], value: process.env[v] || '' })) };
      }
    }
    return result;
  } catch (e) { return {}; }
}

function getSpecialistEndpoints() {
  const config = getConfig();
  return config.specialistEndpoints || {};
}

function getConfiguredSpecialistEndpoint(name) {
  const endpoints = getSpecialistEndpoints();
  return endpoints[name] && endpoints[name].url ? endpoints[name] : null;
}




function getActiveProvider() {
  const config = getConfig();
  return config.activeProvider || null;
}

function setActiveProvider(providerName) {
  const config = getConfig();
  config.activeProvider = providerName;
  saveConfig(config);
}

function getProviderConfig(providerName) {
  if (!providerName) return null;
  const config = getConfig();

  /* 1. providers.json — the canonical store for user-configured providers.
   *    Field-by-field merge with config.json so providers.json wins for the
   *    fields the user can edit (apiKey, baseUrl, apiFormat, enabled,
   *    autoFetch) but legacy config.json fields still flow through. */
  try {
    const { getStoredProviderByName } = require('../services/providers/providers-routes');
    const stored = getStoredProviderByName(providerName);
    if (stored) {
      const legacyEntry =
        (config[providerName] && typeof config[providerName] === 'object' && config[providerName]) ||
        null;
      const merged = { ...(legacyEntry || {}) };
      if (stored.apiKey) merged.apiKey = stored.apiKey;
      if (stored.baseUrl) merged.baseUrl = stored.baseUrl;
      if (stored.apiFormat) merged.apiFormat = stored.apiFormat;
      if (stored.enabled !== undefined) merged.enabled = stored.enabled;
      if (stored.autoFetch !== undefined) merged.autoFetch = stored.autoFetch;
      if (stored.id) merged._providerId = stored.id;
      return merged;
    }
  } catch (_) {
    // providers-routes module may not be loaded yet — fall through.
  }

  if (config[providerName] && typeof config[providerName] === 'object') {
    return config[providerName];
  }

  // Resolve alias configurations (e.g. anthropic -> claude, openai-codex -> codex)
  try {
    const { getProvider } = require('../providers/provider-registry');
    const profile = getProvider(providerName);
    if (profile) {
      if (config[profile.name] && typeof config[profile.name] === 'object') {
        return config[profile.name];
      }
      for (const alias of profile.aliases) {
        if (config[alias] && typeof config[alias] === 'object') {
          return config[alias];
        }
      }
    }
  } catch (e) {
    // Ignore potential circular dependency or loading errors
  }

  // Special case: customProvider for custom
  if (providerName === 'custom' && config.customProvider && typeof config.customProvider === 'object') {
    return config.customProvider;
  }

  return null;
}

function saveProviderConfig(providerName, providerConfig) {
  const config = getConfig();
  config[providerName] = providerConfig;
  saveConfig(config);
}

module.exports = { getConfig, saveConfig, getProfile, saveProfile, syncClaudePublicAlias, syncGptPublicAlias, getProfileField, getBookmarks, saveBookmark, deleteBookmark, getActiveProvider, setActiveProvider, getProviderConfig, saveProviderConfig, getEnvVars, setEnvVar, deleteEnvVar, getProviderRequiredEnvVars, getSpecialistEndpoints, getConfiguredSpecialistEndpoint, CONFIG_PATH, ENV_PATH, getComputerRoots, saveComputerRoots };

function getComputerRoots() {
    const cfg = getConfig();
    const sec = cfg.security || {};
    return {
        allowedRoots: Array.isArray(sec.allowedRoots) ? sec.allowedRoots.slice() : [],
        filesystemScope: sec.filesystemScope === 'root' ? 'root' : 'allowlist',
        postObservationScreenshot: sec.postObservationScreenshot !== false
    };
}

function saveComputerRoots({ allowedRoots, filesystemScope, postObservationScreenshot } = {}) {
    const cfg = getConfig();
    cfg.security = cfg.security || {};
    if (Array.isArray(allowedRoots)) cfg.security.allowedRoots = allowedRoots.slice();
    if (filesystemScope === 'root' || filesystemScope === 'allowlist') {
        cfg.security.filesystemScope = filesystemScope;
    }
    if (typeof postObservationScreenshot === 'boolean') {
        cfg.security.postObservationScreenshot = postObservationScreenshot;
    }
    saveConfig(cfg);
    return getComputerRoots();
}