/* ── Per-model provider routing ────────────────────────────────────── */
/* Resolves which provider + baseUrl + apiKey + apiMode should serve a
 * given model id. This mirrors the cascade already proven in the /api/chat
 * route (backend/index.js) so that the OpenAI/Anthropic-compatible
 * /v1/ endpoints route consistently — e.g. a request
 * for `deepseek-chat` from Claude Code (/v1/messages) routes to the
 * deepseek provider instead of the claude profile's targetUrl.
 *
 * Returns null when no provider-specific match is found, in which case
 * callers keep their existing fallback (claude/codex profile). */

const { listProviders } = require('./provider-registry');
const { getProviderConfig, getActiveProvider } = require('../lib/config');
const { getProviderHint } = require('./provider-hints');

/**
 * Resolve a provider for a model id using the same precedence as /api/chat:
 *   1. explicit provider-hint table
 *   2. exact model-profile key match
 *   3. longest model-profile prefix match
 *   4. wildcard (*) profile match
 *   5. provider name/alias prefix on the model id
 *   6. well-known family prefixes (claude-, gpt-, gemini-, deepseek-)
 *   7. active provider
 *
 * Returns { provider, baseUrl, apiKey, apiMode } or null.
 */
function resolveProviderForModel(model) {
    if (!model || typeof model !== 'string') return null;
    const providers = listProviders();
    if (providers.length === 0) return null;
    const lowerModel = model.toLowerCase();

    // 1. Explicit provider hint.
    const hinted = getProviderHint(model);
    if (hinted) {
        const p = providers.find((x) => x.name === hinted);
        if (p && hasCredentials(p)) return toResolved(p);
    }

    // 2–4. Model-profile matches (exact → longest prefix → wildcard).
    let exactMatch = null;
    let bestPrefixMatch = null;
    let bestPrefixLength = -1;
    let wildcardMatch = null;

    for (const p of providers) {
        if (!hasCredentials(p)) continue;
        if (!p.getModelProfile || !p._modelProfiles) continue;

        if (p._modelProfiles[model]) {
            exactMatch = p;
            break;
        }
        const matchingKeys = Object.keys(p._modelProfiles)
            .filter((k) => k !== '*' && lowerModel.startsWith(k.toLowerCase()))
            .sort((a, b) => b.length - a.length);
        if (matchingKeys.length > 0) {
            const keyLength = matchingKeys[0].length;
            if (!bestPrefixMatch || keyLength > bestPrefixLength) {
                bestPrefixMatch = p;
                bestPrefixLength = keyLength;
            }
        } else if (!wildcardMatch && p._modelProfiles['*']) {
            wildcardMatch = p;
        }
    }
    if (exactMatch) return toResolved(exactMatch);
    if (bestPrefixMatch) return toResolved(bestPrefixMatch);
    if (wildcardMatch) return toResolved(wildcardMatch);

    // 5. Provider name / alias prefixes the model id (e.g. "deepseek/...").
    for (const p of providers) {
        if (!hasCredentials(p)) continue;
        if (lowerModel.startsWith(p.name.toLowerCase()) ||
            (Array.isArray(p.aliases) && p.aliases.some((a) => lowerModel.startsWith(a.toLowerCase())))) {
            return toResolved(p);
        }
    }

    // 6. Well-known family prefixes.
    let familyProvider = null;
    if (lowerModel.startsWith('claude-')) familyProvider = 'anthropic';
    else if (lowerModel.startsWith('gpt-') || lowerModel.startsWith('o1') || lowerModel.startsWith('o3')) familyProvider = 'openai-api';
    else if (lowerModel.startsWith('gemini-')) familyProvider = 'gemini';
    else if (lowerModel.startsWith('deepseek-')) familyProvider = 'deepseek';
    if (familyProvider) {
        const p = providers.find((x) => x.name === familyProvider);
        if (p && hasCredentials(p)) return toResolved(p);
    }

    // 7. Active provider (only if it actually has credentials).
    const active = getActiveProvider();
    if (active) {
        const p = providers.find((x) => x.name === active);
        if (p && hasCredentials(p)) return toResolved(p);
    }

    return null;
}

function hasCredentials(provider) {
    const config = getProviderConfig(provider.name) || {};
    return !!(provider.isAvailable() || config.apiKey);
}

function toResolved(provider) {
    const config = getProviderConfig(provider.name) || {};
    const apiKey = config.apiKey || provider.resolveApiKey();
    const baseUrl = config.baseUrl || config.targetUrl || provider.resolveBaseUrl();
    return {
        provider,
        name: provider.name,
        baseUrl,
        apiKey,
        apiMode: config.apiMode || provider.apiMode,
    };
}

module.exports = { resolveProviderForModel };
