/**
 * plugin-cli.js — Plugin management CLI (august plugins ...)
 * Inspired by Hermes Agent's plugins CLI and OpenCode's plugin boot sequence.
 *
 * Plugin manifest format (plugin.yaml):
 * ---
 * name: my-plugin
 * version: 1.0.0
 * description: Plugin description
 * author: User
 * hooks: [tool_tool_post, llm_response_pre, session_start, session_end]
 * requires_env: [API_KEY]
 * skills: [skill-name]
 * mcp_servers: [mcp-server-configs]
 * source: git|npm|local
 * ---
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGINS_CONFIG_FILE = path.join(__dirname, '..', '..', '..', 'data', 'config.json');
const PLUGINS_DIR = path.join(os.homedir(), '.august', 'plugins');

// ── Ensure plugins directory ──

function pluginsDir() {
  if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  return PLUGINS_DIR;
}

// ── Plugin type ──

class PluginEntry {
  constructor(opts) {
    this.name = opts.name;
    this.version = opts.version || '1.0.0';
    this.description = opts.description || '';
    this.author = opts.author || '';
    this.hooks = opts.hooks || [];
    this.requiresEnv = opts.requiresEnv || [];
    this.skills = opts.skills || [];
    this.mcpServers = opts.mcpServers || [];
    this.source = opts.source || 'local'; // git | npm | local
    this.sourceUrl = opts.sourceUrl || '';
    this.updatedAt = opts.updatedAt || new Date().toISOString();
    this.enabled = opts.enabled !== false;
    this.installedAt = opts.installedAt || new Date().toISOString();
    this.manifestPath = opts.manifestPath || '';
  }
}

// ── Get plugins from config.json ──

function getPlugins() {
  const plugins = [];

  // From config.json customPlugins
  try {
    const config = JSON.parse(fs.readFileSync(PLUGINS_CONFIG_FILE, 'utf8'));
    if (Array.isArray(config.customPlugins)) {
      for (const p of config.customPlugins) {
        plugins.push(new PluginEntry({
          name: p.name,
          description: p.description || '',
          source: p.sourceUrl ? 'git' : 'local',
          sourceUrl: p.sourceUrl || '',
          skills: (p.skills || []).map(s => s.name),
          mcpServers: (p.mcpServers || []).map(m => m.name),
          enabled: p.enabled !== false,
          updatedAt: p.updatedAt || '',
          version: p.version || '1.0.0'
        }));
      }
    }
  } catch (e) {}

  // From plugins directory (manifest-based)
  try {
    if (fs.existsSync(PLUGINS_DIR)) {
      for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(PLUGINS_DIR, entry.name, 'plugin.yaml');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const content = fs.readFileSync(manifestPath, 'utf8');
          const parsed = parsePluginManifest(content);
          parsed.manifestPath = manifestPath;
          // Don't duplicate config-based plugins
          if (!plugins.some(p => p.name === parsed.name)) {
            plugins.push(new PluginEntry(parsed));
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  return plugins;
}

// ── Parse plugin.yaml (simple YAML subset) ──

function parsePluginManifest(content) {
  const result = {
    name: '',
    version: '1.0.0',
    description: '',
    author: '',
    hooks: [],
    requiresEnv: [],
    skills: [],
    mcpServers: [],
    source: 'local',
    sourceUrl: '',
    enabled: true
  };

  // Match YAML key: value pairs (simple parser)
  const lines = content.split('\n');
  let currentKey = '';
  for (const line of lines) {
    const kv = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      let value = kv[2].trim();
      if (value.startsWith('[') && value.endsWith(']')) {
        try { value = JSON.parse(value.replace(/'/g, '"')); } catch (e) { value = value.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, '')); }
      }
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      if (currentKey in result) result[currentKey] = value;
    } else if (line.trim().startsWith('- ') && currentKey && Array.isArray(result[currentKey])) {
      // Multiline array items
      result[currentKey].push(line.trim().slice(2).replace(/['"]/g, ''));
    }
  }

  return result;
}

// ── Generate plugin.yaml ──

function toPluginYaml(plugin) {
  const lines = ['---'];
  lines.push(`name: ${plugin.name}`);
  lines.push(`version: ${plugin.version}`);
  lines.push(`description: ${plugin.description}`);
  lines.push(`author: ${plugin.author}`);
  if (plugin.hooks && plugin.hooks.length) lines.push(`hooks: [${plugin.hooks.join(', ')}]`);
  if (plugin.requiresEnv && plugin.requiresEnv.length) lines.push(`requires_env: [${plugin.requiresEnv.join(', ')}]`);
  if (plugin.skills && plugin.skills.length) lines.push(`skills: [${plugin.skills.join(', ')}]`);
  lines.push(`source: ${plugin.source}`);
  if (plugin.sourceUrl) lines.push(`sourceUrl: ${plugin.sourceUrl}`);
  if (plugin.enabled !== undefined) lines.push(`enabled: ${plugin.enabled}`);
  lines.push(`updatedAt: ${plugin.updatedAt || new Date().toISOString()}`);
  lines.push('---');
  lines.push('');
  lines.push(plugin.description || '');
  return lines.join('\n');
}

// ── Save/Delete/Enable/Disable ──

function savePlugin(config) {
  // Save to config.json customPlugins array
  const configFile = JSON.parse(fs.readFileSync(PLUGINS_CONFIG_FILE, 'utf8'));
  configFile.customPlugins = configFile.customPlugins || [];
  const idx = configFile.customPlugins.findIndex(p => p.name === config.name);
  const entry = {
    name: config.name,
    description: config.description || '',
    sourceUrl: config.sourceUrl || '',
    skills: config.skills || [],
    mcpServers: config.mcpServers || [],
    enabled: config.enabled !== false,
    updatedAt: new Date().toISOString(),
    version: config.version || '1.0.0',
    notes: config.notes || ''
  };
  if (idx >= 0) configFile.customPlugins[idx] = { ...configFile.customPlugins[idx], ...entry };
  else configFile.customPlugins.push(entry);
  fs.writeFileSync(PLUGINS_CONFIG_FILE, JSON.stringify(configFile, null, 2), 'utf8');
  return entry;
}

function deletePlugin(name) {
  const configFile = JSON.parse(fs.readFileSync(PLUGINS_CONFIG_FILE, 'utf8'));
  configFile.customPlugins = (configFile.customPlugins || []).filter(p => p.name !== name);
  fs.writeFileSync(PLUGINS_CONFIG_FILE, JSON.stringify(configFile, null, 2), 'utf8');

  // Clean up plugin directory
  const pluginDir = path.join(PLUGINS_DIR, name);
  try { fs.rmSync(pluginDir, { recursive: true, force: true }); } catch (e) {}
  return true;
}

function setPluginEnabled(name, enabled) {
  const configFile = JSON.parse(fs.readFileSync(PLUGINS_CONFIG_FILE, 'utf8'));
  configFile.customPlugins = configFile.customPlugins || [];
  const plugin = configFile.customPlugins.find(p => p.name === name);
  if (plugin) {
    plugin.enabled = enabled;
    plugin.updatedAt = new Date().toISOString();
    fs.writeFileSync(PLUGINS_CONFIG_FILE, JSON.stringify(configFile, null, 2), 'utf8');
    return true;
  }
  return false;
}

// ── Install from URL (git clone) ──

async function installFromUrl(url, name) {
  const execSync = require('child_process').execSync;
  const targetName = name || url.split('/').pop().replace('.git', '');
  const targetDir = path.join(pluginsDir(), targetName);

  if (fs.existsSync(targetDir)) {
    throw new Error(`Plugin "${targetName}" already installed at ${targetDir}`);
  }

  fs.mkdirSync(targetDir, { recursive: true });

  // Check for local path (development)
  if (url.startsWith('file://') || url.startsWith('/') || url.match(/^[a-zA-Z]:\\/)) {
    const srcPath = url.replace(/^file:\/\//, '');
    try {
      fs.cpSync(srcPath, targetDir, { recursive: true });
      console.log(`[PluginCLI] Copied plugin from ${srcPath}`);
    } catch (e) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      throw new Error(`Failed to copy plugin: ${e.message}`);
    }
  } else {
    // Git clone
    try {
      execSync(`git clone --depth 1 "${url}" "${targetDir}"`, { stdio: 'pipe', timeout: 60000 });
      console.log(`[PluginCLI] Cloned plugin from ${url}`);
    } catch (e) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      throw new Error(`Failed to clone plugin: ${e.stderr?.toString() || e.message}`);
    }
  }

  // Verify manifest exists
  const manifestPath = path.join(targetDir, 'plugin.yaml');
  if (!fs.existsSync(manifestPath)) {
    console.warn(`[PluginCLI] No plugin.yaml found in ${targetDir}`);
  }

  return { name: targetName, path: targetDir };
}

// ── List installed plugins (JSON output for UI) ──

function renderPluginsJson() {
  const plugins = getPlugins();
  return plugins.map(p => ({
    name: p.name,
    version: p.version,
    description: p.description,
    author: p.author,
    enabled: p.enabled,
    source: p.source,
    sourceUrl: p.sourceUrl,
    hooks: p.hooks,
    requiresEnv: p.requiresEnv,
    skillsCount: p.skills.length,
    mcpServersCount: p.mcpServers.length,
    updatedAt: p.updatedAt
  }));
}

// ── Hook system (like Hermes plugin hooks) ──

const _hookHandlers = new Map();
// Pre-defined hooks: tool_call_pre, tool_call_post, llm_request_pre, llm_response_post, session_start, session_end

function registerHook(hookName, pluginName, handler) {
  if (!_hookHandlers.has(hookName)) _hookHandlers.set(hookName, []);
  _hookHandlers.get(hookName).push({ plugin: pluginName, handler });
}

function runHooks(hookName, context = {}) {
  const handlers = _hookHandlers.get(hookName) || [];
  for (const h of handlers) {
    try {
      const result = h.handler(context);
      if (result && typeof result.then === 'function') {
        // Skip async hooks silently (fire-and-forget for simplicity)
        result.catch(e => console.warn(`[Plugin] Hook ${hookName}:${h.plugin} error:`, e.message));
      }
    } catch (e) {
      console.warn(`[Plugin] Hook ${hookName}:${h.plugin} error:`, e.message);
    }
  }
}

async function runHooksAsync(hookName, context = {}) {
  const handlers = _hookHandlers.get(hookName) || [];
  for (const h of handlers) {
    try {
      await h.handler(context);
    } catch (e) {
      console.warn(`[Plugin] Hook ${hookName}:${h.plugin} error:`, e.message);
    }
  }
}

module.exports = {
  PluginEntry,
  getPlugins,
  savePlugin,
  deletePlugin,
  setPluginEnabled,
  installFromUrl,
  renderPluginsJson,
  registerHook,
  runHooks,
  runHooksAsync,
  parsePluginManifest,
  toPluginYaml
};
