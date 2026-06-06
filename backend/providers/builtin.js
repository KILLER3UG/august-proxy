const { registerProvider } = require('./provider-registry');
const { ProviderProfile } = require('./provider-profile');

function p(name) { return require('path').join(__dirname, '..', '..', 'providers', name); }

function load(name) {
  const mod = require(p(name));
  const profile = mod.profile || mod;
  if (profile instanceof ProviderProfile) {
    registerProvider(profile);
  } else if (profile.name) {
    registerProvider(new ProviderProfile(profile));
  }
}

function registerBuiltinProviders() {
  load('opencode-go.js');
  load('opencode-zen.js');
  load('kilo.js');
  load('openrouter.js');
  load('minimax.js');
  load('minimax-cn.js');
  load('anthropic.js');
  load('openai-api.js');
  load('deepseek.js');
  load('gemini.js');
  load('xai.js');
  load('copilot.js');
  load('bedrock.js');
  load('azure-foundry.js');
  load('huggingface.js');
  load('novita.js');
  load('cline.js');
  load('custom.js');
  load('nvidia.js');

  // Register bookmarks from config as user providers
  registerBookmarkProviders();
}

function registerBookmarkProviders() {
  try {
    const { getConfig } = require('../lib/config');
    const cfg = getConfig();
    const bookmarks = cfg.bookmarks || [];
    const { registerUserProvider } = require('./provider-registry');
    for (const b of bookmarks) {
      if (b.name && b.baseUrl) {
        registerUserProvider(b.name.toLowerCase().replace(/\s+/g, '-'), {
          name: b.name,
          baseUrl: b.baseUrl,
          keyEnv: null,
          apiMode: b.apiMode || 'openai_chat',
        });
      }
    }
  } catch (e) { /* bookmarks are optional */ }
}

module.exports = { registerBuiltinProviders };
