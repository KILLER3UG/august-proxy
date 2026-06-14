const { getConfig, saveConfig } = require('../../lib/config');
const { mcpServers: builtinMcpServers } = require('./mcp-config');
const { maskSecretValue, SENSITIVE_KEY_PATTERN } = require('../../lib/redact');

const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,48}$/;
const MASKED_VALUE_PATTERN = /^(?:\*\*\*|.{1,12}\.\.\..{1,8})$/;

function toStringArray(value) {
    if (Array.isArray(value)) return value.map(item => String(item)).filter(Boolean);
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return [];
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed.map(item => String(item)).filter(Boolean);
        } catch (e) {
            // Treat plain text as newline-separated args.
        }
        return trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    }
    return [];
}

function toEnvObject(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => key)
                .map(([key, child]) => [String(key).trim(), String(child ?? '')])
        );
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return {};
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return toEnvObject(parsed);
            }
        } catch (e) {
            // Fall through to KEY=VALUE lines.
        }
        return Object.fromEntries(
            trimmed.split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)
                .map(line => {
                    const idx = line.indexOf('=');
                    if (idx === -1) return [line, ''];
                    return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
                })
                .filter(([key]) => key)
        );
    }
    return {};
}

function toHeadersObject(headers) {
    if (!headers || typeof headers !== 'object') return {};
    return Object.fromEntries(
        Object.entries(headers)
            .filter(([k, v]) => k && v !== undefined && v !== null)
            .map(([k, v]) => [k, String(v)])
    );
}

function normalizeMcpServer(raw, { source = 'custom' } = {}) {
    const name = String(raw?.name || '').trim();
    if (!MCP_NAME_PATTERN.test(name)) {
        throw new Error('MCP server name must be 1-48 characters and use only letters, numbers, underscores, or dashes.');
    }

    const url = String(raw?.url || '').trim();
    const command = String(raw?.command || '').trim();

    if (!url && !command) {
        throw new Error('MCP server requires either a "url" (for HTTP-based servers) or a "command" (for stdio-based servers).');
    }

    const headers = toHeadersObject(raw.headers);

    if (url) {
        try {
            new URL(url);
        } catch (e) {
            throw new Error(`Invalid MCP server URL: "${url}" — must be a valid HTTP/HTTPS URL.`);
        }
        return {
            name,
            enabled: raw.enabled !== false,
            source: raw.source || source,
            url,
            headers,
            timeoutMs: Math.max(1000, Number(raw.timeoutMs || 15000) || 15000)
        };
    }

    return {
        name,
        enabled: raw.enabled !== false,
        source: raw.source || source,
        command,
        headers,
        args: toStringArray(raw.args),
        env: toEnvObject(raw.env),
        cwd: raw.cwd ? String(raw.cwd).trim() : undefined,
        timeoutMs: Math.max(1000, Number(raw.timeoutMs || 15000) || 15000)
    };
}

function getBuiltinMcpServers() {
    return builtinMcpServers.map(server => normalizeMcpServer(server, { source: 'builtin' }));
}

function mergeMcpServers(customServers = []) {
    const merged = new Map();
    getBuiltinMcpServers().forEach(server => merged.set(server.name, server));
    customServers.forEach(raw => {
        const existing = merged.get(raw?.name);
        const normalized = normalizeMcpServer({
            ...(existing || {}),
            ...raw,
            source: existing?.source === 'builtin' ? 'builtin' : (raw.source || 'custom')
        }, { source: existing?.source || 'custom' });
        merged.set(normalized.name, normalized);
    });
    return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function getMcpServers() {
    const config = getConfig();
    return mergeMcpServers(Array.isArray(config.mcpServers) ? config.mcpServers : []);
}

function maskSensitiveRecord(record = {}) {
    return Object.fromEntries(
        Object.entries(record)
            .map(([key, value]) => [key, SENSITIVE_KEY_PATTERN.test(key) ? maskSecretValue(value) : value])
    );
}

function preserveMaskedRecord(normalized, existing, fieldName) {
    if (!existing?.[fieldName]) return;
    normalized[fieldName] = Object.fromEntries(
        Object.entries(normalized[fieldName] || {})
            .map(([key, value]) => {
                if (SENSITIVE_KEY_PATTERN.test(key) && MASKED_VALUE_PATTERN.test(String(value))) {
                    return [key, existing[fieldName][key] || ''];
                }
                return [key, value];
            })
    );
}

function getMcpServersForUi() {
    return getMcpServers().map(server => {
        const safeEnv = maskSensitiveRecord(server.env || {});
        const safeHeaders = maskSensitiveRecord(server.headers || {});
        return {
            ...server,
            headers: safeHeaders,
            env: safeEnv,
            argsText: (server.args || []).join('\n'),
            headersText: Object.entries(safeHeaders)
                .map(([key, value]) => `${key}=${value}`)
                .join('\n'),
            envText: Object.entries(safeEnv)
                .map(([key, value]) => `${key}=${value}`)
                .join('\n')
        };
    });
}

function saveCustomMcpServer(data) {
    const normalized = normalizeMcpServer(data, { source: data.source || 'custom' });
    const config = getConfig();
    const current = Array.isArray(config.mcpServers) ? config.mcpServers : [];
    const existingIndex = current.findIndex(server => server?.name === normalized.name);
    const existing = existingIndex >= 0
        ? normalizeMcpServer(current[existingIndex], { source: current[existingIndex].source || 'custom' })
        : getMcpServers().find(server => server.name === normalized.name);

    if (existing?.source === 'builtin') {
        normalized.source = 'builtin';
    }

    preserveMaskedRecord(normalized, existing, 'env');
    preserveMaskedRecord(normalized, existing, 'headers');

    if (existingIndex >= 0) current[existingIndex] = normalized;
    else current.push(normalized);
    config.mcpServers = current;
    saveConfig(config);
    return normalized;
}

function setMcpServerEnabled(name, enabled) {
    const normalizedName = String(name || '').trim();
    if (!MCP_NAME_PATTERN.test(normalizedName)) throw new Error('Invalid MCP server name.');

    const existing = getMcpServers().find(server => server.name === normalizedName);
    if (!existing) throw new Error(`MCP server not found: ${normalizedName}`);

    const config = getConfig();
    const current = Array.isArray(config.mcpServers) ? config.mcpServers : [];
    const existingIndex = current.findIndex(server => server?.name === normalizedName);
    const override = normalizeMcpServer({
        ...existing,
        enabled: enabled !== false,
        source: existing.source || 'custom'
    }, { source: existing.source || 'custom' });

    if (existingIndex >= 0) current[existingIndex] = override;
    else current.push(override);
    config.mcpServers = current;
    saveConfig(config);
    return override;
}

function deleteMcpServer(name) {
    const normalizedName = String(name || '').trim();
    if (!MCP_NAME_PATTERN.test(normalizedName)) throw new Error('Invalid MCP server name.');
    const builtin = getBuiltinMcpServers().find(server => server.name === normalizedName);
    const config = getConfig();
    const current = Array.isArray(config.mcpServers) ? config.mcpServers : [];

    if (builtin) {
        const disabled = { ...builtin, enabled: false, source: 'builtin' };
        const existingIndex = current.findIndex(server => server?.name === normalizedName);
        if (existingIndex >= 0) current[existingIndex] = disabled;
        else current.push(disabled);
        config.mcpServers = current;
        saveConfig(config);
        return { deleted: false, disabled: true };
    }

    config.mcpServers = current.filter(server => server?.name !== normalizedName);
    saveConfig(config);
    return { deleted: true, disabled: false };
}

module.exports = {
    deleteMcpServer,
    getBuiltinMcpServers,
    getMcpServers,
    getMcpServersForUi,
    mergeMcpServers,
    normalizeMcpServer,
    saveCustomMcpServer,
    setMcpServerEnabled,
    toEnvObject,
    toStringArray,
    toHeadersObject
};
