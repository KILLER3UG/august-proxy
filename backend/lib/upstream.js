function parseRetryAfterMs(retryAfterHeader) {
    if (!retryAfterHeader) return null;
    const trimmed = String(retryAfterHeader).trim();
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }

    const retryAt = Date.parse(trimmed);
    if (Number.isFinite(retryAt)) {
        return Math.max(0, retryAt - Date.now());
    }
    return null;
}

function isRetryableStatus(status) {
    return status === 429 || status === 503;
}

function getRetryDelayMs(response, attempt) {
    const headerDelay = parseRetryAfterMs(response?.headers?.get?.('retry-after'));
    if (headerDelay !== null) {
        return Math.min(headerDelay, 30000);
    }

    const baseDelay = Math.min(1000 * (2 ** Math.max(0, attempt - 1)), 8000);
    const jitter = Math.floor(Math.random() * 400);
    return baseDelay + jitter;
}

function buildFriendlyRateLimitMessage(status, rawBody, attempts) {
    const guidance = 'Upstream is rate-limiting this request. The proxy retried automatically. If this keeps happening, spread traffic across multiple providers or API keys, reduce parallel requests, or move this workload to a higher-capacity plan.';
    return `Upstream Error (${status}): ${rawBody}\n\n${guidance}\nRetries attempted: ${attempts}.`;
}

module.exports = {
    buildFriendlyRateLimitMessage,
    getRetryDelayMs,
    isRetryableStatus,
    parseRetryAfterMs
};
