const registry = new Map();
const aliasMap = new Map();
const userProviders = new Map();

function registerProvider(profile) {
  registry.set(profile.name, profile);
  for (const alias of profile.aliases) {
    aliasMap.set(alias.toLowerCase(), profile.name);
  }
}

function registerUserProvider(name, config) {
  const { ProviderProfile } = require('./provider-profile');
  const profile = new ProviderProfile({
    name,
    displayName: config.name || name,
    baseUrl: config.baseUrl || config.api || '',
    apiMode: config.apiMode || config.transport || 'openai_chat',
    envVars: config.keyEnv ? [config.keyEnv] : [],
    defaultModel: config.defaultModel || config.model || '',
    authType: config.authType || 'api_key',
    description: config.description || `User-defined provider: ${name}`,
  });
  userProviders.set(name, profile);
}

function unregisterUserProvider(name) {
  userProviders.delete(name);
}

function getProvider(name) {
  if (!name) return null;
  const canonical = aliasMap.get(name.toLowerCase()) || name;
  return registry.get(canonical) || userProviders.get(canonical) || null;
}

function getProviderName(name) {
  if (!name) return null;
  return aliasMap.get(name.toLowerCase()) || name;
}

function listProviders() {
  const builtin = Array.from(registry.values());
  const user = Array.from(userProviders.values());
  return [...builtin, ...user];
}

function listProviderNames() {
  return listProviders().map(p => p.name);
}

function resolveAlias(name) {
  if (!name) return null;
  return aliasMap.get(name.toLowerCase()) || null;
}

module.exports = {
  registerProvider,
  registerUserProvider,
  unregisterUserProvider,
  getProvider,
  getProviderName,
  listProviders,
  listProviderNames,
  resolveAlias,
};
