/* ── usage-recorder ── persist normalized usage into session-store ── */

const { normalizeUsage } = require('./usage-normalizer');
const sessionStore = require('../storage/session-store');

function ensureUsageSession({ sessionId, title, agentType, provider, model, metadata }) {
    if (!sessionId || !sessionStore.isReady()) return null;

    try {
        const existing = sessionStore.getSession(sessionId);
        if (existing) {
            const updates = {};
            if (provider) updates.provider = provider;
            if (model) updates.model = model;
            if (Object.keys(updates).length > 0) sessionStore.updateSession(sessionId, updates);
            return existing;
        }

        sessionStore.createSession({
            id: sessionId,
            title: title || `Usage: ${sessionId}`,
            agent_type: agentType || 'usage',
            provider: provider || '',
            model: model || '',
            metadata: metadata || { usageOnly: true },
        });
        return sessionStore.getSession(sessionId);
    } catch (e) {
        console.warn('[UsageRecorder] Failed to ensure usage session:', e.message);
        return null;
    }
}

function recordUsage(input = {}) {
    const usage = normalizeUsage(input);
    if (!usage.sessionId || !sessionStore.isReady()) return null;

    const { force = false, ...usageFields } = input || {};

    try {
        ensureUsageSession({
            sessionId: usage.sessionId,
            provider: usage.provider,
            model: usage.model,
            metadata: {
                ...(usage.metadata || {}),
                usageOnly: true,
                lastSource: usage.source,
                lastRequestId: usage.requestId,
            },
        });
        return sessionStore.recordUsageEvent({ ...usageFields, ...usage, force });
    } catch (e) {
        console.warn('[UsageRecorder] Failed to record usage:', e.message);
        return null;
    }
}

module.exports = {
    recordUsage,
    ensureUsageSession,
};
