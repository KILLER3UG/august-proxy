const { getConfig } = require('../../lib/config');

const DEFAULT_SUPERMEMORY_BASE_URL = 'https://api.supermemory.ai';

function hasUsableSecret(value) {
    if (!value) return false;
    return !/^\$\{env:[^}]+\}$/i.test(String(value));
}

function normalizeSupermemoryBaseUrl(value) {
    let baseUrl = String(value || DEFAULT_SUPERMEMORY_BASE_URL).trim();
    if (!baseUrl) baseUrl = DEFAULT_SUPERMEMORY_BASE_URL;
    baseUrl = baseUrl.replace(/\/+$/, '');

    if (/^https:\/\/supermemory\.ai\/api\/?$/i.test(baseUrl)) {
        return DEFAULT_SUPERMEMORY_BASE_URL;
    }
    if (/\/v[34]$/i.test(baseUrl)) {
        return baseUrl.replace(/\/v[34]$/i, '');
    }
    return baseUrl;
}

function getSupermemorySettings() {
    const config = getConfig();
    const apiKey = config.supermemoryApiKey || process.env.SUPERMEMORY_API_KEY || '';
    const baseUrl = normalizeSupermemoryBaseUrl(config.supermemoryUrl);
    return {
        apiKey,
        baseUrl,
        configured: hasUsableSecret(apiKey)
    };
}

function supermemoryHeaders(apiKey) {
    return {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };
}

async function readJsonOrText(response) {
    const raw = await response.text();
    try {
        return { data: raw ? JSON.parse(raw) : {}, raw };
    } catch (_) {
        return { data: null, raw };
    }
}

function requireConfigured(settings = getSupermemorySettings()) {
    if (!settings.configured) {
        const error = new Error('Supermemory is not configured. Set SUPERMEMORY_API_KEY in .env or save a Supermemory API key in config.');
        error.code = 'SUPERMEMORY_NOT_CONFIGURED';
        throw error;
    }
    return settings;
}

async function storeSupermemoryDocument({ content, type, metadata, containerTag } = {}) {
    if (!content) throw new Error('content is required for Supermemory store.');
    const settings = requireConfigured();
    const body = {
        content,
        metadata: {
            ...(metadata && typeof metadata === 'object' ? metadata : {}),
            ...(type ? { type } : {})
        }
    };
    if (containerTag) body.containerTag = containerTag;

    const response = await fetch(`${settings.baseUrl}/v3/documents`, {
        method: 'POST',
        headers: supermemoryHeaders(settings.apiKey),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
    });
    const { data, raw } = await readJsonOrText(response);
    if (!response.ok) throw new Error(`Supermemory store failed: HTTP ${response.status} ${raw.slice(0, 300)}`);
    return data || {};
}

async function searchSupermemory({ query, limit = 5, containerTag, searchMode = 'hybrid' } = {}) {
    if (!query) throw new Error('query is required for Supermemory search.');
    const settings = requireConfigured();
    const body = {
        q: query,
        searchMode,
        limit: Math.max(1, Math.min(20, Number(limit || 5)))
    };
    if (containerTag) body.containerTag = containerTag;

    const response = await fetch(`${settings.baseUrl}/v4/search`, {
        method: 'POST',
        headers: supermemoryHeaders(settings.apiKey),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
    });
    const { data, raw } = await readJsonOrText(response);
    if (!response.ok) throw new Error(`Supermemory search failed: HTTP ${response.status} ${raw.slice(0, 300)}`);
    return data || {};
}

async function listSupermemoryDocuments({ limit = 10, page = 1 } = {}) {
    const settings = requireConfigured();
    const response = await fetch(`${settings.baseUrl}/v3/documents/list`, {
        method: 'POST',
        headers: supermemoryHeaders(settings.apiKey),
        body: JSON.stringify({
            limit: Math.max(1, Math.min(50, Number(limit || 10))),
            page: Math.max(1, Number(page || 1))
        }),
        signal: AbortSignal.timeout(15000)
    });
    const { data, raw } = await readJsonOrText(response);
    if (!response.ok) throw new Error(`Supermemory list failed: HTTP ${response.status} ${raw.slice(0, 300)}`);
    return data || {};
}

function summarizeSupermemoryResult(item = {}) {
    return item.memory
        || item.chunk
        || item.title
        || item.summary
        || item.content
        || '(untitled)';
}

module.exports = {
    DEFAULT_SUPERMEMORY_BASE_URL,
    getSupermemorySettings,
    listSupermemoryDocuments,
    normalizeSupermemoryBaseUrl,
    searchSupermemory,
    storeSupermemoryDocument,
    summarizeSupermemoryResult
};
