let Client = null;
let StdioClientTransport = null;
let StreamableHTTPClientTransport = null;
let mcpSdkLoadError = null;
const { spawnSync } = require('child_process');

try {
    ({ Client } = require('@modelcontextprotocol/sdk/client/index.js'));
    ({ StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js'));
    try {
        ({ StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js'));
    } catch (httpErr) {
        console.warn(`[MCP] StreamableHTTPClientTransport not available: ${httpErr.message}`);
    }
} catch (error) {
    mcpSdkLoadError = error;
    console.warn(`[MCP] SDK unavailable; MCP servers disabled: ${error.message}`);
}
const { getMcpServers } = require('./mcp-registry');

const clients = new Map();
const toolRegistry = new Map(); // "mcp__serverName__toolName" -> tool schema
const serverStatus = new Map();

// ── Schema sanitization ──────────────────────────────────────────────
function sanitizeToolSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        return { type: 'object', properties: {} };
    }
    if (Array.isArray(schema)) {
        return { type: 'object', properties: {} };
    }
    if (!schema.type) {
        schema = { ...schema, type: 'object' };
    }
    if (schema.type === 'object') {
        if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
            schema = { ...schema, properties: {} };
        }
        const sanitizedProps = {};
        for (const [key, val] of Object.entries(schema.properties)) {
            sanitizedProps[key] = sanitizeSchemaDeep(val);
        }
        schema = { ...schema, properties: sanitizedProps };
    }
    return schema;
}

// Deep recursive sanitizer — walks the entire JSON Schema tree and fixes invalid structures
function sanitizeSchemaDeep(val) {
    if (!val || typeof val !== 'object') {
        return { type: 'string' };
    }
    // Raw array of type objects → {type:'array', items:{oneOf:[...]}}
    if (Array.isArray(val)) {
        if (val.length > 0 && val.every(item => item && typeof item === 'object' && !Array.isArray(item) && item.type)) {
            return { type: 'array', items: { oneOf: val.map(sanitizeSchemaDeep) } };
        }
        return { type: 'string' };
    }

    const result = { ...val };

    // Fix items: raw array of type objects
    if (Array.isArray(result.items)) {
        if (result.items.length > 0 && result.items.every(item => item && typeof item === 'object' && !Array.isArray(item) && item.type)) {
            result.items = { oneOf: result.items.map(sanitizeSchemaDeep) };
        } else {
            result.items = { type: 'string' };
        }
    } else if (result.items && typeof result.items === 'object') {
        result.items = sanitizeSchemaDeep(result.items);
    }

    // Recurse into anyOf / oneOf / allOf
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(result[key])) {
            result[key] = result[key].map(sanitizeSchemaDeep);
        }
    }

    // Recurse into nested properties
    if (result.properties && typeof result.properties === 'object' && !Array.isArray(result.properties)) {
        const nested = {};
        for (const [k, v] of Object.entries(result.properties)) {
            nested[k] = sanitizeSchemaDeep(v);
        }
        result.properties = nested;
    }

    // Recurse into additionalProperties
    if (result.additionalProperties && typeof result.additionalProperties === 'object' && !Array.isArray(result.additionalProperties)) {
        result.additionalProperties = sanitizeSchemaDeep(result.additionalProperties);
    }

    // Recurse into definitions/$defs
    for (const defsKey of ['definitions', '$defs']) {
        if (result[defsKey] && typeof result[defsKey] === 'object' && !Array.isArray(result[defsKey])) {
            const defs = {};
            for (const [k, v] of Object.entries(result[defsKey])) {
                defs[k] = sanitizeSchemaDeep(v);
            }
            result[defsKey] = defs;
        }
    }

    return result;
}

function nowIso() {
    return new Date().toISOString();
}

function updateStatus(name, patch) {
    const current = serverStatus.get(name) || { name };
    serverStatus.set(name, { ...current, ...patch, updatedAt: nowIso() });
}

function commandExists(command) {
    if (!command) return false;
    try {
        if (process.platform === 'win32') {
            const result = spawnSync('where.exe', [command], { stdio: 'ignore' });
            return result.status === 0;
        }
        const result = spawnSync('sh', ['-lc', `command -v "$1" >/dev/null 2>&1`, 'sh', command], { stdio: 'ignore' });
        return result.status === 0;
    } catch (e) {
        return false;
    }
}

function resolveCommand(config) {
    const rawCommand = config.command;
    if (process.platform === 'win32' && rawCommand === 'npx') {
        return { command: 'npx.cmd', args: config.args || [] };
    }
    if (process.platform === 'win32' && rawCommand === 'uvx') {
        return { command: 'uvx.exe', args: config.args || [] };
    }
    if (rawCommand === 'uvx' && !commandExists('uvx') && commandExists('uv')) {
        return { command: 'uv', args: ['tool', 'run', ...(config.args || [])] };
    }
    return { command: rawCommand, args: config.args || [] };
}

function cleanEnv(env) {
    const envVarPattern = /^\$\{env:([^}]+)\}$/;
    return Object.fromEntries(
        Object.entries(env || {})
            .filter(([key, value]) => key && value !== undefined && value !== null)
            .map(([key, value]) => {
                const text = String(value);
                const match = text.match(envVarPattern);
                if (match) return [key, process.env[match[1].trim()] || text];
                return [key, text];
            })
    );
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function startServer(config) {
    if (!Client || !StdioClientTransport) {
        return;
    }
    if (config.enabled === false) {
        updateStatus(config.name, {
            status: 'disabled',
            enabled: false,
            source: config.source,
            command: config.command || config.url || '',
            args: config.args || [],
            toolCount: 0,
            error: null
        });
        return;
    }

    console.log(`[MCP] Starting server '${config.name}'...`);

    // ── URL-based (HTTP) MCP server ──
    if (config.url) {
        if (!StreamableHTTPClientTransport) {
            const message = 'StreamableHTTPClientTransport not available in MCP SDK';
            updateStatus(config.name, { status: 'error', error: message });
            console.error(`[MCP] Failed to start '${config.name}': ${message}`);
            return;
        }
        updateStatus(config.name, {
            status: 'starting',
            enabled: true,
            source: config.source,
            url: config.url,
            toolCount: 0,
            error: null
        });

        const transport = new StreamableHTTPClientTransport({
            url: new URL(config.url),
            headers: config.headers || {}
        });

        const client = new Client({
            name: `august-proxy-${config.name}`,
            version: "1.0.0"
        }, {
            capabilities: {}
        });

        try {
            await withTimeout(client.connect(transport), config.timeoutMs || 15000, `MCP server '${config.name}' connect`);
            clients.set(config.name, { client, transport });
            console.log(`[MCP] Connected to URL-based server '${config.name}' at ${config.url}.`);

            const response = await withTimeout(client.listTools(), config.timeoutMs || 15000, `MCP server '${config.name}' tool discovery`);
            const tools = response.tools || [];
            console.log(`[MCP] '${config.name}' provides ${tools.length} tools via HTTP.`);

            tools.forEach(tool => {
                const namespacedName = `mcp__${config.name}__${tool.name}`;
                const toolDefinition = {
                    type: 'function',
                    function: {
                        name: namespacedName,
                        description: `[MCP: ${config.name}] ${tool.description || ''}`,
                        parameters: sanitizeToolSchema(tool.inputSchema)
                    }
                };
                toolRegistry.set(namespacedName, toolDefinition);
            });
            updateStatus(config.name, {
                status: 'running',
                url: config.url,
                toolCount: tools.length,
                tools: tools.map(tool => tool.name),
                error: null
            });
        } catch (e) {
            console.error(`[MCP] Failed to start URL-based server '${config.name}':`, e.message);
            updateStatus(config.name, { status: 'error', error: e.message });
        }
        return;
    }

    updateStatus(config.name, {
        status: 'starting',
        enabled: true,
        source: config.source,
        command: config.command,
        args: config.args || [],
        toolCount: 0,
        error: null
    });
    
    // Pass existing env vars plus any server-specific ones
    const env = cleanEnv({ ...process.env, ...config.env });
    
    const resolved = resolveCommand(config);
    const executableCheckName = process.platform === 'win32' && resolved.command.endsWith('.cmd')
        ? resolved.command
        : resolved.command;
    if (!commandExists(executableCheckName)) {
        const message = `Command not found: ${resolved.command}`;
        updateStatus(config.name, { status: 'error', error: message });
        console.error(`[MCP] Failed to start '${config.name}': ${message}`);
        return;
    }

    const transport = new StdioClientTransport({
        command: resolved.command,
        args: resolved.args,
        env,
        cwd: config.cwd || undefined
    });

    const client = new Client({
        name: `august-proxy-${config.name}`,
        version: "1.0.0"
    }, {
        capabilities: {}
    });

    try {
        await withTimeout(client.connect(transport), config.timeoutMs || 15000, `MCP server '${config.name}' connect`);
        clients.set(config.name, { client, transport });
        console.log(`[MCP] Connected to '${config.name}'.`);
        
        // Fetch and register tools
        const response = await withTimeout(client.listTools(), config.timeoutMs || 15000, `MCP server '${config.name}' tool discovery`);
        const tools = response.tools || [];
        console.log(`[MCP] '${config.name}' provides ${tools.length} tools.`);
        
        tools.forEach(tool => {
            const namespacedName = `mcp__${config.name}__${tool.name}`;
            const toolDefinition = {
                type: 'function',
                function: {
                    name: namespacedName,
                    description: `[MCP: ${config.name}] ${tool.description || ''}`,
                    parameters: sanitizeToolSchema(tool.inputSchema)
                }
            };
            toolRegistry.set(namespacedName, toolDefinition);
        });
        updateStatus(config.name, {
            status: 'running',
            command: resolved.command,
            args: resolved.args,
            toolCount: tools.length,
            tools: tools.map(tool => tool.name),
            error: null
        });

    } catch (e) {
        console.error(`[MCP] Failed to start '${config.name}':`, e.message);
        updateStatus(config.name, { status: 'error', error: e.message });
    }
}

async function startMcpServers(minimaxApiKey) {
    if (process.env.AUGUST_PROXY_SKIP_MCP_STARTUP === '1') {
        for (const config of getMcpServers()) {
            updateStatus(config.name, {
                status: 'skipped',
                enabled: config.enabled !== false,
                source: config.source,
                command: config.command || config.url || '',
                args: config.args || [],
                toolCount: 0,
                error: null
            });
        }
        return;
    }
    if (!Client || !StdioClientTransport) {
        return;
    }
    if (minimaxApiKey && !process.env.MINIMAX_API_KEY) {
        process.env.MINIMAX_API_KEY = minimaxApiKey;
    }

    toolRegistry.clear();
    for (const config of getMcpServers()) {
        await startServer(config);
    }
}

async function stopMcpServers() {
    for (const [name, server] of clients.entries()) {
        try {
            if (server.client?.close) await server.client.close();
            else if (server.transport?.close) await server.transport.close();
        } catch (e) {
            console.warn(`[MCP] Failed to close '${name}': ${e.message}`);
        }
    }
    clients.clear();
    toolRegistry.clear();
}

async function restartMcpServers(minimaxApiKey) {
    await stopMcpServers();
    serverStatus.clear();
    await startMcpServers(minimaxApiKey);
    return getMcpServerStatus();
}

function getMcpToolDefinitions() {
    return Array.from(toolRegistry.values());
}

function getMcpServerStatus() {
    const configured = getMcpServers();
    return configured.map(server => ({
        name: server.name,
        enabled: server.enabled,
        source: server.source,
        command: server.command,
        args: server.args,
        url: server.url,
        headers: server.headers,
        cwd: server.cwd,
        timeoutMs: server.timeoutMs,
        ...(serverStatus.get(server.name) || {
            status: server.enabled === false ? 'disabled' : 'not_started',
            enabled: server.enabled !== false,
            toolCount: 0,
            error: null,
            updatedAt: null
        }),
        running: clients.has(server.name)
    }));
}

function isMcpToolName(name) {
    return name && name.startsWith('mcp__');
}

async function executeMcpToolCall(toolName, args) {
    if (!Client || !StdioClientTransport) {
        throw new Error(`[MCP Disabled] ${mcpSdkLoadError?.message || 'MCP SDK not installed.'}`);
    }
    if (!isMcpToolName(toolName)) {
        throw new Error(`Not an MCP tool: ${toolName}`);
    }

    const parts = toolName.split('__');
    if (parts.length < 3) throw new Error(`Invalid MCP tool name format: ${toolName}`);
    
    const serverName = parts[1];
    const originalToolName = parts.slice(2).join('__'); // in case tool name has '__' in it

    const server = clients.get(serverName);
    if (!server) {
        throw new Error(`MCP server '${serverName}' is not running.`);
    }

    console.log(`[MCP] Executing '${originalToolName}' on '${serverName}'...`);
    try {
        const result = await server.client.callTool({
            name: originalToolName,
            arguments: args
        });

        // Format result back to string — guard against non-text blocks and missing content
        const content = result?.content || [];
        const text = content
            .map(c => c.text ?? (c.type ? `[${c.type} block]` : JSON.stringify(c)))
            .filter(Boolean)
            .join('\n') || '(empty response)';

        if (result.isError) {
            return `[MCP Error] ${text}`;
        }
        return text;
    } catch (e) {
        throw new Error(`[MCP Execution Error] ${e.message}`);
    }
}

module.exports = {
    getMcpServerStatus,
    startMcpServers,
    restartMcpServers,
    stopMcpServers,
    getMcpToolDefinitions,
    isMcpToolName,
    executeMcpToolCall,
    sanitizeToolSchema
};
