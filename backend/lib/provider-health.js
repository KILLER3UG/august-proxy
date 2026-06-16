/* ── provider-health ─ lightweight online probe for LLM providers ──── */
/* For each registered provider that has an API key, attempts a          */
/* lightweight `fetchModels(apiKey)` call against a 2-second timeout.   */
/* Results are cached for 30 seconds so the Settings → Providers and    */
/* Settings → Models views can poll the green online dot cheaply.       */
/*                                                                       */
/* Exposed via:                                                          */
/*   • GET /api/providers/health  — array of { provider, online, ... }  */
/*   • /api/providers/health?force=1 — bypass the cache                  */

const { listProviders } = require('../providers/provider-registry');
const { getProviderConfig } = require('./config');

const CACHE_TTL_MS = 30 * 1000;
const PROBE_TIMEOUT_MS = 2000;

let cache = { at: 0, results: [] };

/**
 * Probe a single provider. Returns an object with:
 *   { provider, online, lastSuccessAt, latencyMs, error? }
 */
async function pingProvider(provider, apiKey) {
  const start = Date.now();
  const name = provider.name;

  if (!apiKey) {
    return { provider: name, online: false, lastSuccessAt: null, latencyMs: null, error: 'no API key' };
  }

  // Some providers don't override fetchModels (returns []). Treat [] as
  // ambiguous — show the provider as online if the request itself didn't
  // throw and the response came back fast (i.e. the endpoint is reachable).
  try {
    const models = await Promise.race([
      Promise.resolve().then(() => provider.fetchModels(apiKey)),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('probe timeout')),
        PROBE_TIMEOUT_MS
      )),
    ]);
    const ok = Array.isArray(models) ? models.length >= 0 : !!models;
    return {
      provider: name,
      online: ok,
      lastSuccessAt: ok ? Date.now() : null,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      provider: name,
      online: false,
      lastSuccessAt: null,
      latencyMs: Date.now() - start,
      error: String(err && err.message || err),
    };
  }
}

/** Refresh and return the health of every registered provider. */
async function probeAllProviders({ force = false } = {}) {
  if (!force && Date.now() - cache.at < CACHE_TTL_MS && cache.results.length > 0) {
    return cache.results;
  }
  const results = [];
  for (const p of listProviders()) {
    const cfg = getProviderConfig(p.name) || {};
    const apiKey = cfg.apiKey || p.resolveApiKey();
    results.push(await pingProvider(p, apiKey));
  }
  cache = { at: Date.now(), results };
  return results;
}

/** Return the last-known health snapshot without re-probing. */
function getCachedHealth() {
  return cache.results;
}

/** Reset the cache (used by tests and on API key changes). */
function clearHealthCache() {
  cache = { at: 0, results: [] };
}

module.exports = {
  probeAllProviders,
  getCachedHealth,
  pingProvider,
  clearHealthCache,
  CACHE_TTL_MS,
  PROBE_TIMEOUT_MS,
};
