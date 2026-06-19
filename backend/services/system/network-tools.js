/**
 * Redacted network fetcher. Strips auth headers from both request and response
 * to avoid leaking secrets into audit logs.
 *
 * Headers matching these patterns are removed from response headers before
 * returning to the caller:
 *   - authorization
 *   - cookie / set-cookie
 *   - x-api-key
 *   - proxy-authenticate, proxy-authorization
 */

const SENSITIVE_HEADER_PATTERNS = [
    /^authorization$/i,
    /^cookie$/i,
    /^set-cookie$/i,
    /^x-api-key$/i,
    /^x-auth-token$/i,
    /^proxy-authenticate$/i,
    /^proxy-authorization$/i
];

function redactRequestHeaders(headers) {
    if (!headers || typeof headers !== 'object') return headers || {};
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (SENSITIVE_HEADER_PATTERNS.some(rx => rx.test(k))) {
            out[k] = '***REDACTED***';
        } else {
            out[k] = v;
        }
    }
    return out;
}

function redactResponseHeaders(headers) {
    if (!headers || typeof headers !== 'object') return headers || {};
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (SENSITIVE_HEADER_PATTERNS.some(rx => rx.test(k))) {
            // set-cookie can be an array; keep the array shape
            out[k] = '***REDACTED***';
        } else {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Redacted fetch. Uses global fetch if available (Node 18+).
 * Returns { status, statusText, headers (redacted), body (text) }.
 * Body size is capped at 256 KB to avoid huge responses.
 */
async function redactedFetch(url, options = {}) {
    const safeOptions = {
        method: options.method || 'GET',
        headers: redactRequestHeaders(options.headers || {}),
        body: options.body || undefined,
        timeoutMs: options.timeoutMs || 15000
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), safeOptions.timeoutMs);

    try {
        const res = await fetch(url, {
            method: safeOptions.method,
            headers: safeOptions.headers,
            body: safeOptions.body,
            signal: controller.signal
        });
        const text = await res.text();
        const truncated = text.length > 256 * 1024;
        return {
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            headers: redactResponseHeaders(Object.fromEntries(res.headers.entries())),
            body: truncated ? text.slice(0, 256 * 1024) + '\n... [truncated]' : text,
            truncated
        };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    redactedFetch,
    redactRequestHeaders,
    redactResponseHeaders,
    SENSITIVE_HEADER_PATTERNS
};
