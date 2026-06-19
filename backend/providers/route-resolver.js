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

const { listProviders, getProvider } = require('./provider-registry');
const { getProviderConfig, getActiveProvider } = require('../lib/config');
const { getProviderHint } = require('./provider-hints');

/**
 * Resolve a provider for a model id using this precedence:
 *   0. explicit provider hint from the selected model alias
 *   1. explicit provider-hint table
 *   2. exact model-profile key match
 *   3. longest model-profile prefix match
 *   4. provider name/alias prefix or segment on the model id
 *   5. well-known family prefixes (claude-, gpt-, gemini-, deepseek-)
 *   6. wildcard (*) profile match
 *   7. active provider
 *
 * Returns { provider, baseUrl, apiKey, apiMode } or null.
 */
function resolveProviderByName(providerName) {
    if (!providerName) return null;
    const rawName = String(providerName).trim();
    const p = getProvider(rawName) || getProvider(rawName.toLowerCase());
    if (!p || !hasCredentials(p)) return null;
    return toResolved(p);
}

function resolveProviderForModel(model, options = {}) {
    if (!model || typeof model !== 'string') return null;

    // 0. Explicit provider hint from the selected model alias.
    const hintedProvider = resolveProviderByName(options.providerHint || options.provider || options.providerName);
    if (hintedProvider) return hintedProvider;

    const providers = listProviders();
    if (providers.length === 0) return null;
    const lowerModel = model.toLowerCase();

    // 1. Explicit provider hint.
    const hinted = getProviderHint(model);
    if (hinted) {
        const p = providers.find((x) => x.name === hinted);
        if (p && hasCredentials(p)) return toResolved(p);
    }

    // 1.5. Live model-catalog match — if any provider in providers.json
    //      actually lists this model (live /v1/models fetch, user-added, or
    //      built-in static), prefer it over a generic prefix match. This
    //      prevents sibling providers (e.g. opencode-go vs opencode-zen) that
    //      share static model-profile prefixes from stealing models that
    //      belong to a more specific upstream.
    //
    //      Note: we do NOT honour `enabled: false` here as a skip — that
    //      field is the seed default when no env-var is set, and the user
    //      typically configures providers via the UI by setting an API key
    //      in providers.json without flipping `enabled`. `hasCredentials`
    //      below is the real "is this provider usable" check.
    try {
        const { listPublicProviders } = require('../services/providers/providers-routes');
        const stored = listPublicProviders ? listPublicProviders() : [];
        for (const sp of stored) {
            if (!sp) continue;
            const providerId = sp.id || sp.name;
            if (!providerId) continue;
            const profile = providers.find((x) => x.name === providerId || x.name === sp.name);
            if (!profile || !hasCredentials(profile)) continue;
            const models = Array.isArray(sp.models) ? sp.models : [];
            const hit = models.find((m) => m && (m.id === model || (m.id && m.id.toLowerCase() === lowerModel)));
            if (hit) return toResolved(profile);
        }
    } catch (_) { /* providers-routes not loaded yet — fall through */ }

    // 2–3. Model-profile matches (exact → longest prefix).
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

    // 4. Provider name / alias prefix or segment on the model id.
    const modelSegments = new Set(lowerModel.split(/[/:]/));
    for (const p of providers) {
        if (!hasCredentials(p)) continue;
        const aliases = Array.isArray(p.aliases) ? p.aliases : [];
        if (lowerModel.startsWith(p.name.toLowerCase()) ||
            modelSegments.has(p.name.toLowerCase()) ||
            aliases.some((a) => lowerModel.startsWith(a.toLowerCase()) || modelSegments.has(a.toLowerCase()))) {
            return toResolved(p);
        }
    }

    // 5. Well-known family prefixes.
    let familyProvider = null;
    if (lowerModel.startsWith('claude-')) familyProvider = 'anthropic';
    else if (lowerModel.startsWith('gpt-') || lowerModel.startsWith('o1') || lowerModel.startsWith('o3')) familyProvider = 'openai-api';
    else if (lowerModel.startsWith('gemini-')) familyProvider = 'gemini';
    else if (lowerModel.startsWith('deepseek-')) familyProvider = 'deepseek';
    if (familyProvider) {
        const p = providers.find((x) => x.name === familyProvider);
        if (p && hasCredentials(p)) return toResolved(p);
    }

    // 6. Wildcard profile match.
    if (wildcardMatch) return toResolved(wildcardMatch);

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
    const model = config.model || config._upstreamModel || config.currentModel || provider.defaultModel;
    return {
        provider,
        name: provider.name,
        baseUrl,
        apiKey,
        model,
        apiMode: config.apiMode || provider.apiMode,
    };
}

module.exports = { resolveProviderForModel, resolveProviderByName };
