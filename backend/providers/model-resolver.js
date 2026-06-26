/**
 * model-resolver.js — Centralized alias-first model resolution.
 *
 * Single source of truth for "given an alias or a raw model id, return
 * `{ alias, provider, model, isFallback }`". Used by every sub-agent spawning
 * site so that the upstream provider always receives a model id it actually
 * serves (instead of a stale raw backend id inherited from the parent's
 * already-resolved profile — which is the bug that produced `401 ModelError`
 * "Model X is not supported" when the active provider changed between
 * parent and child turns).
 *
 * Resolution order for `resolve(input, options)`:
 *   1. User-defined alias in config.modelAliases → use its targetModel /
 *      targetProvider, route through resolveProviderForModel.
 *   2. Catalog display alias from resolveModelAliasDetails() → if the resolved
 *      id differs, route the resolved id.
 *   3. resolveProviderForModel(input) → if a routed provider exists with
 *      credentials, return it. The returned `model` is whatever the
 *      provider's config / catalog says (NOT the raw alias — this is the
 *      bug-fix surface).
 *   4. Throw ModelResolutionError with message `"Alias '<x>' not found."`.
 *
 * `resolveOrFallback` wraps `resolve`, and on any miss falls back to
 * `resolveActiveProvider()`'s model. It logs a warning and returns
 * `{ alias: input, provider, model, isFallback: true }`. If even the active
 * provider is unavailable, returns `null` (caller decides whether to throw).
 *
 * `getAliasForModel` and `listAliases` walk the synchronous sources
 * (config.modelAliases, built-in Claude aliases) and the async catalog via
 * `getModelAliasMap()`. The async source is best-effort — when the catalog
 * cache is cold, the result is partial but always returns a `string[]`/
 * `string|null`.
 *
 * Callers should treat the input as an alias first and a raw id second;
 * never the other way around.
 */

const { resolveProviderForModel } = require('./route-resolver');
const { resolveActiveProvider } = require('./provider-resolver');
const { resolveModelAliasDetails, getModelAliasMap } = require('./model-list');
const { getConfig } = require('../lib/config');

const DEFAULT_ALIAS = 'default';

const BUILTIN_CLAUDE_PUBLIC_ALIASES = Object.freeze([
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
]);

class ModelResolutionError extends Error {
    constructor(message, { input, reason } = {}) {
        super(message);
        this.name = 'ModelResolutionError';
        this.input = input;
        this.reason = reason || null;
    }
}

function normalize(input) {
    if (input === null || input === undefined) return null;
    const s = String(input).trim();
    return s || null;
}

function findUserDefinedAlias(input) {
    if (!input) return null;
    try {
        const cfg = getConfig();
        const aliases = (cfg && cfg.modelAliases) || [];
        return aliases.find(a => a && a.alias === input) || null;
    } catch (_) {
        return null;
    }
}

/**
 * Resolve `input` to a `{ alias, provider, model, isFallback }` tuple.
 * Throws ModelResolutionError if the input can't be mapped.
 *
 * @param {string|null|undefined} input — alias or raw model id
 * @param {object} [options]
 * @param {string} [options.providerHint] — provider to prefer when multiple match
 * @param {string} [options.defaultAlias] — alias to use when input is falsy
 * @returns {{ alias: string, provider: string, model: string, isFallback: boolean }}
 */
function resolve(input, options = {}) {
    const normalized = normalize(input) || normalize(options.defaultAlias) || DEFAULT_ALIAS;
    const providerHint = options.providerHint || null;

    // 1. User-defined alias from config.modelAliases.
    const userAlias = findUserDefinedAlias(normalized);
    if (userAlias && userAlias.targetModel) {
        const routed = resolveProviderForModel(userAlias.targetModel, {
            providerHint: userAlias.targetProvider || providerHint || undefined,
        });
        if (routed && routed.baseUrl && routed.apiKey) {
            return {
                alias: normalized,
                provider: routed.name || (routed.provider && routed.provider.name) || userAlias.targetProvider || 'unknown',
                model: routed.model || userAlias.targetModel,
                isFallback: false,
            };
        }
    }

    // 2. Catalog display alias from resolveModelAliasDetails().
    try {
        const aliasDetails = resolveModelAliasDetails(normalized);
        if (aliasDetails && aliasDetails.modelId && aliasDetails.modelId !== normalized) {
            // When the catalog maps a display alias (e.g. "Sonnet 4 6-Alias")
            // to a model id with provider "Alias", the provider hint is
            // meaningless for actual routing — it just means "this came from a
            // user-defined alias entry in the model list".  Skip the direct
            // routing attempt in that case and recurse so the user-defined
            // alias (step 1) gets a chance to apply with its real targetProvider
            // (e.g. "Openmodel" instead of "Alias").
            const isAliasProvider = aliasDetails.provider === 'Alias';
            if (!isAliasProvider) {
                const routed = resolveProviderForModel(aliasDetails.modelId, {
                    providerHint: aliasDetails.provider || providerHint || undefined,
                });
                if (routed && routed.baseUrl && routed.apiKey) {
                    return {
                        alias: normalized,
                        provider: routed.name || (routed.provider && routed.provider.name) || aliasDetails.provider || 'unknown',
                        model: routed.model || aliasDetails.modelId,
                        isFallback: false,
                    };
                }
            }
            // Recurse once with the resolved model id so user-defined aliases
            // (step 1) or the model's real provider (step 3) can pick it up.
            // The providerHint from the catalog ("Alias") is stripped when the
            // catalog provider is "Alias" so it doesn't poison step 1's
            // resolveProviderForModel call with a meaningless hint.
            try {
                const inner = resolve(aliasDetails.modelId, {
                    providerHint: isAliasProvider ? undefined : (aliasDetails.provider || providerHint),
                });
                if (inner) return { ...inner, alias: normalized };
            } catch (_) { /* fall through */ }
        }
    } catch (_) { /* catalog not loaded — continue */ }

    // 3. Direct provider routing — input might be a raw backend id.
    const routed = resolveProviderForModel(normalized, { providerHint });
    if (routed && routed.baseUrl && routed.apiKey) {
        return {
            alias: normalized,
            provider: routed.name || (routed.provider && routed.provider.name) || 'unknown',
            model: routed.model || normalized,
            isFallback: false,
        };
    }

    // 4. Nothing matched.
    throw new ModelResolutionError(`Alias '${normalized}' not found.`, {
        input: normalized,
        reason: 'no_matching_provider',
    });
}

/**
 * Resolve `input` with a graceful fallback to the active provider.
 * Never throws. Returns `null` only when no provider is available at all.
 *
 * @param {string|null|undefined} input
 * @param {object} [options]
 * @returns {{ alias: string, provider: string, model: string, isFallback: boolean } | null}
 */
function resolveOrFallback(input, options = {}) {
    const originalInput = normalize(input);
    const normalized = originalInput || normalize(options.defaultAlias) || DEFAULT_ALIAS;

    try {
        const result = resolve(normalized, options);
        if (result) return result;
    } catch (err) {
        if (!(err instanceof ModelResolutionError)) {
            console.warn(`[ModelResolver] unexpected error resolving '${normalized}': ${err.message}`);
        }
        // Fall through to active provider fallback.
    }

    let active = null;
    try {
        active = resolveActiveProvider();
    } catch (_) { /* ignore */ }

    if (active && active.baseUrl && active.apiKey) {
        const model = active.model || active.defaultModel || normalized;
        const provider = active.name || (active.provider && active.provider.name) || 'active';
        console.warn(
            `[ModelResolver] falling back to active provider "${provider}" for input "${normalized}"`
        );
        return {
            alias: originalInput || normalized,
            provider,
            model,
            isFallback: true,
        };
    }

    console.warn(`[ModelResolver] no active provider available; cannot resolve '${normalized}'`);
    return null;
}

/**
 * Reverse lookup: given a raw model id, find the alias that maps to it.
 * Best-effort — synchronous sources (config.modelAliases, built-in aliases,
 * and the alias map cache if already populated) are consulted; the async
 * catalog is consulted via the alias map cache.
 *
 * @param {string} modelId
 * @returns {string|null}
 */
function getAliasForModel(modelId) {
    const id = normalize(modelId);
    if (!id) return null;

    // 1. User-defined aliases whose targetModel equals the input.
    try {
        const cfg = getConfig();
        const aliases = (cfg && cfg.modelAliases) || [];
        const hit = aliases.find(a => a && a.targetModel === id);
        if (hit) return hit.alias;
    } catch (_) { /* ignore */ }

    // 2. Catalog alias map (async, but cheap if cache is warm).
    try {
        // getModelAliasMap returns a Promise; we don't await it here. The
        // caller should use the async variant `getAliasForModelAsync` if they
        // need a guaranteed catalog-aware answer. The sync best-effort below
        // covers the common case.
        const mapSync = readAliasMapSync();
        if (mapSync) {
            for (const [alias, entry] of mapSync.entries()) {
                const target = entry && typeof entry === 'object' ? entry.modelId : entry;
                if (target === id) return alias;
            }
        }
    } catch (_) { /* ignore */ }

    // 3. Built-in Claude aliases — the canonical catalog id may BE one of them.
    if (BUILTIN_CLAUDE_PUBLIC_ALIASES.includes(id)) return id;

    return null;
}

/**
 * Async variant of getAliasForModel. Awaits the alias map cache if cold.
 *
 * @param {string} modelId
 * @returns {Promise<string|null>}
 */
async function getAliasForModelAsync(modelId) {
    const id = normalize(modelId);
    if (!id) return null;

    try {
        const map = await getModelAliasMap();
        for (const [alias, entry] of map.entries()) {
            const target = entry && typeof entry === 'object' ? entry.modelId : entry;
            if (target === id) return alias;
        }
    } catch (_) { /* ignore */ }

    // Fall back to sync path (covers user-defined + built-in).
    return getAliasForModel(id);
}

/**
 * Read the alias map synchronously if the cache is warm.
 * Returns null when the cache is cold; callers should fall back to other sources.
 */
function readAliasMapSync() {
    try {
        const { modelAliasCache } = require('./model-list');
        if (modelAliasCache && typeof modelAliasCache.entries === 'function') {
            return modelAliasCache;
        }
    } catch (_) { /* ignore */ }
    return null;
}

/**
 * Return every alias the system knows about, deduplicated.
 * Includes user-defined aliases, the cached catalog alias map, and the
 * built-in Claude public aliases referenced from
 * `backend/adapters/anthropic.js:KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES`.
 *
 * @returns {string[]}
 */
function listAliases() {
    const out = new Set();

    try {
        const cfg = getConfig();
        const aliases = (cfg && cfg.modelAliases) || [];
        for (const a of aliases) if (a && a.alias) out.add(a.alias);
    } catch (_) { /* ignore */ }

    try {
        const mapSync = readAliasMapSync();
        if (mapSync) {
            for (const alias of mapSync.keys()) out.add(alias);
        }
    } catch (_) { /* ignore */ }

    for (const a of BUILTIN_CLAUDE_PUBLIC_ALIASES) out.add(a);

    return Array.from(out).sort();
}

/**
 * Async variant of listAliases. Includes the async-cached catalog aliases.
 *
 * @returns {Promise<string[]>}
 */
async function listAliasesAsync() {
    const out = new Set(listAliases());
    try {
        const map = await getModelAliasMap();
        for (const alias of map.keys()) out.add(alias);
    } catch (_) { /* ignore */ }
    return Array.from(out).sort();
}

function getDefaultAlias() {
    return DEFAULT_ALIAS;
}

module.exports = {
    DEFAULT_ALIAS,
    ModelResolutionError,
    resolve,
    resolveOrFallback,
    getAliasForModel,
    getAliasForModelAsync,
    listAliases,
    listAliasesAsync,
    getDefaultAlias,
    BUILTIN_CLAUDE_PUBLIC_ALIASES,
};