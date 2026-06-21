/**
 * session-model-inheritance.js — Per‑session alias‑level model inheritance.
 *
 * Each session maintains a map of alias → resolved provider + model.
 * Sub‑agents (non‑alias requests) inherit from the alias that spawned them
 * rather than from a global “latest alias”. Concurrent alias updates in the
 * same session are serialised so sub‑agents always see a consistent snapshot.
 *
 * Thread‑safety model: Node.js is single‑threaded, so plain property reads
 * are safe. Updates across async boundaries could interleave, so we use a
 * per‑session promise queue (a simple serialiser) so that
 * recordAliasResolution runs one at a time per session.
 *
 * Exported helpers:
 *   isAliasCandidate(input)  – quick check before calling the resolver
 *   getSessionState(sessionId)
 *   recordAliasResolution({ sessionId, alias, resolution, logger })
 *   resolveInheritedModel({ sessionId, model, parentAlias, metadata, headers, logger })
 *   getParentAliasFromRequest(body, req)  – extract parent alias from metadata/headers
 *   clearSession(sessionId)
 */

const modelResolver = require('./model-resolver');

// Built‑in Claude public model ids that count as aliases.
const BUILTIN_CLAUDE_ALIASES = Object.freeze([
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
]);

// Codex / OpenAI default aliases that should be treated as alias candidates
// for the first request, so the OpenAI adapter can route them through the
// session alias store.
const CODEX_DEFAULT_ALIASES = Object.freeze([
    'gpt-5.4',
    'gpt-4o',
    'gpt-4-turbo',
]);

// ══════════════════════════════════════════════════════════════════════════
//  In‑memory per‑session state
// ══════════════════════════════════════════════════════════════════════════

/**
 @typedef {Map<string, { alias: string, provider: string, model: string,
            updatedAt: string, updatedAtMs: number, source: string }>} AliasMap
 */

const sessions = new Map(); // sessionId → { aliases: AliasMap, lastAlias: string|null, queue: Promise }

// ── Internal helpers ──────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString(); }
function nowMs()  { return Date.now(); }

function touchSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { aliases: new Map(), lastAlias: null, queue: Promise.resolve() });
    }
    return sessions.get(sessionId);
}

/**
 * Serialise alias‑map mutations so concurrent calls to recordAliasResolution
 * for the same session do not interleave reads/writes.
 */
function enqueue(sessionId, fn) {
    const state = touchSession(sessionId);
    state.queue = state.queue.then(fn, fn);
    return state.queue;
}

// ══════════════════════════════════════════════════════════════════════════
//  Public API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Return the current session state object (aliases Map + lastAlias).
 * Callers MUST NOT mutate the returned maps directly — use
 * recordAliasResolution instead.
 */
function getSessionState(sessionId) {
    if (!sessionId) return null;
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    return { aliases: new Map(entry.aliases), lastAlias: entry.lastAlias };
}

/**
 * Quick check whether `input` looks like an alias before going through the
 * full resolver.  Returns true when the input is:
 *   • a user‑defined alias from config, or
 *   • a catalog display alias that maps to a different backend id, or
 *   • a built‑in Claude public alias.
 */
function isAliasCandidate(input) {
    if (!input || typeof input !== 'string') return false;
    const trimmed = input.trim();
    if (!trimmed) return false;

    // 1. Starts with a valid public Claude model/alias format, or ends with "-Alias"
    const lowered = trimmed.toLowerCase();
    const isClaudeFormat = /^claude-(?:3-)?(?:5|7|8)?-?(?:sonnet|opus|haiku)(?:-20\d{6})?$/i.test(trimmed) ||
                           /^claude-(?:opus|sonnet|haiku)-\d-\d$/i.test(trimmed) ||
                           /^claude-[34](?:\.[57])?-(?:sonnet|opus|haiku)$/i.test(trimmed) ||
                           /^(?:sonnet|opus|haiku|best|opusplan)$/i.test(trimmed);
    if (isClaudeFormat) return true;
    if (trimmed.endsWith('-Alias')) return true;

    // 2. Built-in Claude public aliases.
    if (BUILTIN_CLAUDE_ALIASES.includes(trimmed)) return true;

    // 3. Codex / OpenAI default aliases.
    if (CODEX_DEFAULT_ALIASES.includes(trimmed)) return true;

    // 4. User-defined alias in config.
    try {
        const { getConfig } = require('../lib/config');
        const cfg = getConfig();
        const userAliases = cfg.modelAliases || [];
        if (userAliases.some(a => a && a.alias === trimmed)) return true;
    } catch (_) { /* config not ready */ }

    // 5. Catalog display alias via modelResolver.listAliases() (built-ins +
    //    user aliases + warm catalog cache).
    try {
        const list = modelResolver.listAliases();
        if (Array.isArray(list) && list.includes(trimmed)) return true;
    } catch (_) { /* resolver not ready */ }

    return false;
}

/**
 * Record the resolution of an alias for a session.  This is the only way
 * to create or update an alias entry.  Mutations are serialised per session.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.alias       – the user‑facing alias that was resolved
 * @param {{ provider: string, model: string }} opts.resolution
 *        The resolved { provider, model } from ModelResolver.resolve().
 * @param {object} [opts.logger]    – optional console‑like logger
 * @returns {Promise<{ alias, provider, model, updatedAt, brandNew: boolean }>}
 */
async function recordAliasResolution({ sessionId, alias, resolution, logger } = {}) {
    if (!sessionId || !alias || !resolution) return null;
    const log = logger || console;

    return enqueue(sessionId, () => {
        const state = touchSession(sessionId);
        const existing = state.aliases.get(alias);
        const brandNew = !existing;

        // Detect concurrent update to the same alias (queued picks up latest).
        if (!brandNew) {
            // Log only when the provider or model actually changed.
            if (existing.provider !== resolution.provider || existing.model !== resolution.model) {
                log.log(`[Session ${sessionId}] Alias update for "${alias}" queued – applying in order.`);
            }
        } else {
            log.log(`[Session ${sessionId}] New alias "${alias}" → ${resolution.model} via ${resolution.provider}. Stored.`);
        }

        const entry = {
            alias,
            provider: resolution.provider,
            model: resolution.model,
            updatedAt: nowIso(),
            updatedAtMs: nowMs(),
            source: brandNew ? 'alias_request' : 'alias_update',
        };
        state.aliases.set(alias, entry);
        state.lastAlias = alias;
        return { ...entry, brandNew };
    });
}

/**
 * Resolve which backend provider + model to forward a request to.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.model       – the incoming model id from the request body
 * @param {string} [opts.parentAlias] – explicit parent alias from metadata/header
 * @param {object} [opts.metadata]  – request.body.metadata (for parentAlias field)
 * @param {object} [opts.headers]   – request headers (for x-parent-alias)
 * @param {object} [opts.logger]
 * @param {function} [opts.customResolver]
 *        Optional function (input, options) => { alias, provider, model }.
 *        When provided, used instead of modelResolver.resolve so adapters
 *        can route built-in defaults (e.g. Codex) without going through the
 *        catalog alias map.
 * @returns {Promise<{
 *   resolution: { alias, provider, model } | null,
 *   parentAlias: string | null,
 *   action: 'use_alias' | 'use_inherited' | 'reject_first_non_alias' | 'reject_no_alias' | 'alias_resolution_failed' | 'fallback_warning',
 * }>}
 */
async function resolveInheritedModel({ sessionId, model, parentAlias, metadata, headers, logger, customResolver } = {}) {
    if (!sessionId || !model) return null;
    const log = logger || console;
    const state = touchSession(sessionId);

    const isAlias = isAliasCandidate(model);
    const hasAliasEntries = state.aliases.size > 0;

    // ── No alias entries yet ──
    if (!hasAliasEntries) {
        if (!isAlias) {
            log.log(`[Session ${sessionId}] Sub-agent request but no alias resolved yet – rejecting.`);
            return {
                resolution: null,
                parentAlias: null,
                action: 'reject_first_non_alias',
            };
        }
        // First request: resolve and record.
        try {
            const resolved = customResolver
                ? customResolver(model, { providerHint: null, defaultAlias: modelResolver.DEFAULT_ALIAS })
                : modelResolver.resolve(model);
            const alias = resolved.alias;
            const resolution = { provider: resolved.provider, model: resolved.model };
            const result = await recordAliasResolution({ sessionId, alias, resolution, logger });
            log.log(`[Session ${sessionId}] First alias "${alias}" → ${resolution.model} via ${resolution.provider}. Stored.`);
            return {
                resolution,
                parentAlias: alias,
                action: 'use_alias',
            };
        } catch (err) {
            log.warn(`[Session ${sessionId}] Alias resolution failed for "${model}": ${err.message}`);
            return { resolution: null, parentAlias: null, action: 'alias_resolution_failed' };
        }
    }

    // ── Existing session ──
    if (isAlias) {
        // Alias request: resolve (may have been updated) and record.
        try {
            const resolved = customResolver
                ? customResolver(model, { providerHint: null, defaultAlias: modelResolver.DEFAULT_ALIAS })
                : modelResolver.resolve(model);
            const alias = resolved.alias;
            const resolution = { provider: resolved.provider, model: resolved.model };
            const result = await recordAliasResolution({ sessionId, alias, resolution, logger });
            // If alias already existed, recordAliasResolution already logged update.
            return {
                resolution,
                parentAlias: alias,
                action: 'use_alias',
            };
        } catch (err) {
            log.warn(`[Session ${sessionId}] Alias resolution failed for "${model}": ${err.message}`);
            return { resolution: null, parentAlias: null, action: 'alias_resolution_failed' };
        }
    }

    // ── Non‑alias request (sub‑agent) ──
    // Determine parent alias.
    const resolvedParentAlias = parentAlias
        || getParentAliasFromRequestBody(metadata)
        || getParentAliasFromHeaders(headers)
        || state.lastAlias;

    if (!resolvedParentAlias) {
        log.log(`[Session ${sessionId}] Sub‑agent request but no alias resolved yet – rejecting.`);
        return {
            resolution: null,
            parentAlias: null,
            action: 'reject_no_alias',
        };
    }

    const entry = state.aliases.get(resolvedParentAlias);
    if (!entry) {
        // Parent alias known but not in map — should not happen; fallback.
        log.warn(`[Session ${sessionId}] Parent alias "${resolvedParentAlias}" not found in alias entries – falling back to latest.`);
        const fallback = state.lastAlias ? state.aliases.get(state.lastAlias) : null;
        if (!fallback) {
            return {
                resolution: null,
                parentAlias: null,
                action: 'reject_no_alias',
            };
        }
        const resolution = { provider: fallback.provider, model: fallback.model };
        log.log(`[Session ${sessionId}] Sub‑agent "${model}" → using inherited model ${resolution.model} via ${resolution.provider} (parent alias: ${fallback.alias}, fallback from missing entry).`);
        return {
            resolution,
            parentAlias: fallback.alias,
            action: 'use_inherited',
        };
    }

    // Check whether the caller supplied a different parentAlias than the most
    // recent — if not explicit, it came from lastAlias, so warn.
    const explicitParent = parentAlias || getParentAliasFromRequestBody(metadata) || getParentAliasFromHeaders(headers);
    if (!explicitParent) {
        log.log(`[Session ${sessionId}] Sub‑agent "${model}" → using inherited model ${entry.model} via ${entry.provider} (parent alias: ${entry.alias}, from last alias – no explicit parentAlias in request).`);
    } else {
        log.log(`[Session ${sessionId}] Sub‑agent "${model}" → using inherited model ${entry.model} via ${entry.provider} (parent alias: ${entry.alias}).`);
    }

    return {
        resolution: { provider: entry.provider, model: entry.model },
        parentAlias: entry.alias,
        action: 'use_inherited',
    };
}

/**
 * Extract parent alias from request body metadata.
 * Order: metadata.parentAlias, metadata.parent_alias
 */
function getParentAliasFromRequestBody(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    return String(metadata.parentAlias || metadata.parent_alias || '').trim() || null;
}

/**
 * Extract parent alias from request headers.
 * Order: x-parent-alias, x-model-alias
 */
function getParentAliasFromHeaders(headers) {
    if (!headers || typeof headers !== 'object') return null;
    const src = headers['x-parent-alias'] || headers['x-model-alias'];
    if (src) return String(src).trim() || null;
    return null;
}

/**
 * Convenience: combine body metadata + request headers.
 */
function getParentAliasFromRequest(body, req) {
    const metadata = (body && typeof body === 'object') ? body.metadata : null;
    const fromBody = getParentAliasFromRequestBody(metadata);
    if (fromBody) return fromBody;
    if (req && req.headers) {
        return getParentAliasFromHeaders(req.headers);
    }
    return null;
}

/**
 * Snapshot an alias entry at a point in time (for sub‑agent creation in
 * delegate‑tools / executeSubAgent).  The snapshot is a plain object so the
 * caller can pass it to a durable job without holding a reference to the
 * live session state.
 */
function snapshotForSubAgent({ parentAlias, resolution } = {}) {
    return {
        parentAlias: parentAlias || null,
        provider: (resolution && resolution.provider) || null,
        model: (resolution && resolution.model) || null,
        inheritedAt: nowIso(),
    };
}

/**
 * Remove a session's alias state entirely (e.g. when a session expires).
 */
function clearSession(sessionId) {
    sessions.delete(sessionId);
}

module.exports = {
    isAliasCandidate,
    getSessionState,
    recordAliasResolution,
    resolveInheritedModel,
    getParentAliasFromRequest,
    getParentAliasFromRequestBody,
    getParentAliasFromHeaders,
    snapshotForSubAgent,
    clearSession,
};
