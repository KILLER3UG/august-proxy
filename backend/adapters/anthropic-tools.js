const { getMcpToolDefinitions, isMcpToolName } = require('../services/tools/mcp-client');
const { getAugustToolDefinitions, isAugustToolName } = require('../services/tools/august-tools');
const { getCoworkToolDefinitions, isCoworkToolName } = require('../services/tools/cowork-tools');

const MANAGED_WEB_TOOL_NAMES = new Set([
    'WebSearch',
    'WebFetch',
    'web_search',
    'web_fetch',
    'mcp__workspace__web_search',
    'mcp__workspace__web_fetch'
]);

const MANAGED_BASH_TOOL_NAMES = new Set([
    'bash',
    'mcp__workspace__bash'
]);

function isManagedWebToolName(name) {
    return typeof name === 'string' && MANAGED_WEB_TOOL_NAMES.has(name);
}

function isManagedBashToolName(name) {
    return typeof name === 'string' && MANAGED_BASH_TOOL_NAMES.has(name);
}

function getManagedWebToolKind(name) {
    if (typeof name !== 'string') return null;
    if (name === 'WebSearch' || name === 'web_search' || name === 'mcp__workspace__web_search') {
        return 'search';
    }
    if (name === 'WebFetch' || name === 'web_fetch' || name === 'mcp__workspace__web_fetch') {
        return 'fetch';
    }
    return null;
}

function getManagedAnthropicWebToolDefinitions() {
    return [
        {
            name: 'WebSearch',
            description: 'Search the public web for relevant pages. Use only for external/public information. Do not combine this tool with any other tool in the same turn.',
            input_schema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The web search query.'
                    },
                    prompt: {
                        type: 'string',
                        description: 'Compatibility alias for query when a stale client schema still sends prompt.'
                    },
                    max_results: {
                        type: 'integer',
                        description: 'Maximum number of results to return.'
                    }
                },
                required: ['query']
            }
        },
        {
            name: 'WebFetch',
            description: 'Fetch and summarize a public webpage by URL. Private/local network addresses are blocked. Do not combine this tool with any other tool in the same turn.',
            input_schema: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The public HTTP or HTTPS URL to fetch.'
                    },
                    prompt: {
                        type: 'string',
                        description: 'Compatibility alias for url when a stale client schema still sends prompt containing the URL.'
                    }
                },
                required: ['url']
            }
        },
        {
            name: 'mcp__workspace__web_search',
            description: 'Search the public web for relevant pages. Workspace-compatible alias for third-party Claude clients. Do not combine this tool with any other tool in the same turn.',
            input_schema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The web search query.'
                    },
                    prompt: {
                        type: 'string',
                        description: 'Compatibility alias for query when a stale client schema still sends prompt.'
                    },
                    max_results: {
                        type: 'integer',
                        description: 'Maximum number of results to return.'
                    }
                },
                required: ['query']
            }
        },
        {
            name: 'mcp__workspace__web_fetch',
            description: 'Fetch and summarize a public webpage by URL. Workspace-compatible alias for third-party Claude clients. Private/local network addresses are blocked. Do not combine this tool with any other tool in the same turn.',
            input_schema: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The public HTTP or HTTPS URL to fetch.'
                    },
                    prompt: {
                        type: 'string',
                        description: 'Compatibility alias for url when a stale client schema still sends prompt containing the URL.'
                    }
                },
                required: ['url']
            }
        },
        {
            name: 'mcp__workspace__bash',
            description: 'Execute a bash command in the proxy workspace container. Returns stdout, stderr, and exit code. Use for file operations, code analysis, git commands, and scripting.',
            input_schema: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The bash command to execute.'
                    },
                    timeout_ms: {
                        type: 'integer',
                        description: 'Timeout in milliseconds (default 60000).'
                    }
                },
                required: ['command']
            }
        }
    ];
}

function sanitizeAnthropicToolDefinition(tool) {
    if (!tool || typeof tool !== 'object') return null;

    let normalized = tool;
    if (tool.type === 'function' && tool.function && typeof tool.function === 'object') {
        normalized = {
            name: tool.function.name,
            description: tool.function.description || '',
            input_schema: tool.function.parameters || { type: 'object', properties: {} }
        };
    }

    const name = typeof normalized.name === 'string' ? normalized.name.trim() : '';
    if (!name) return null;

    let inputSchema = normalized.input_schema;
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
        inputSchema = { type: 'object', properties: {} };
    }
    if (!inputSchema.type) inputSchema.type = 'object';
    if (inputSchema.type === 'object' && (!inputSchema.properties || typeof inputSchema.properties !== 'object' || Array.isArray(inputSchema.properties))) {
        inputSchema.properties = {};
    }

    return {
        name,
        description: typeof normalized.description === 'string' ? normalized.description : '',
        input_schema: inputSchema
    };
}

function dedupeAndCanonicalizeAnthropicTools(tools) {
    const sanitizedTools = [];
    let includeManagedSearch = false;
    let includeManagedFetch = false;
    const seenNames = new Set();

    for (const rawTool of Array.isArray(tools) ? tools : []) {
        const tool = sanitizeAnthropicToolDefinition(rawTool);
        if (!tool) continue;
        if (isBrowserAutomationToolName(tool.name)) continue;

        const managedKind = getManagedWebToolKind(tool.name);
        if (managedKind === 'search') {
            includeManagedSearch = true;
            continue;
        }
        if (managedKind === 'fetch') {
            includeManagedFetch = true;
            continue;
        }

        if (seenNames.has(tool.name)) continue;
        seenNames.add(tool.name);
        sanitizedTools.push(tool);
    }

    const canonicalManagedTools = getManagedAnthropicWebToolDefinitions().filter(tool => {
        const kind = getManagedWebToolKind(tool.name);
        return (kind === 'search' && includeManagedSearch) || (kind === 'fetch' && includeManagedFetch);
    });

    for (const tool of canonicalManagedTools) {
        if (seenNames.has(tool.name)) continue;
        seenNames.add(tool.name);
        sanitizedTools.push(tool);
    }

    const bashDef = getManagedAnthropicWebToolDefinitions().find(t => t.name === 'mcp__workspace__bash');
    if (bashDef && !seenNames.has(bashDef.name)) {
        seenNames.add(bashDef.name);
        sanitizedTools.push(bashDef);
    }

    return sanitizedTools;
}

function getCanonicalManagedAnthropicWebTools() {
    return getManagedAnthropicWebToolDefinitions().filter(tool =>
        tool.name === 'WebSearch' || tool.name === 'WebFetch' || tool.name === 'mcp__workspace__bash'
    );
}

function openAiToAnthropicToolDefinition(tool) {
    if (tool && tool.type === 'function') {
        return {
            name: tool.function.name,
            description: tool.function.description || '',
            input_schema: tool.function.parameters || { type: 'object', properties: {} }
        };
    }
    return tool;
}

function anthropicToOpenAiToolDefinition(tool) {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || { type: 'object', properties: {} },
            strict: tool.strict
        }
    };
}

function getCanonicalCoworkAnthropicTools() {
    return getCoworkToolDefinitions().map(openAiToAnthropicToolDefinition);
}

function getCanonicalManagedOpenAiWebTools() {
    return getCanonicalManagedAnthropicWebTools().map(anthropicToOpenAiToolDefinition);
}

function getProxyOpenAiToolDefinitions() {
    return [
        ...getMcpToolDefinitions(),
        ...getCoworkToolDefinitions(),
        ...getAugustToolDefinitions(),
        ...getCanonicalManagedOpenAiWebTools()
    ];
}

function getToolDefinitionName(tool) {
    return tool?.function?.name || tool?.name || '';
}

function appendMissingAnthropicTools(targetTools, extraTools) {
    const seen = new Set((targetTools || []).map(getToolDefinitionName).filter(Boolean));
    const appended = [];
    for (const tool of extraTools || []) {
        const name = getToolDefinitionName(tool);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        targetTools.push(tool);
        appended.push(name);
    }
    return appended;
}

function appendMissingOpenAiTools(targetTools, extraTools) {
    const seen = new Set((targetTools || []).map(getToolDefinitionName).filter(Boolean));
    const appended = [];
    for (const tool of extraTools || []) {
        const name = getToolDefinitionName(tool);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        targetTools.push(tool);
        appended.push(name);
    }
    return appended;
}

function isProxyManagedLocalToolName(name) {
    return (
        isManagedWebToolName(name) ||
        isManagedBashToolName(name) ||
        isCoworkToolName(name) ||
        isAugustToolName(name) ||
        isMcpToolName(name)
    );
}

function rememberManagedLocalToolDefinitions(tools, ctx) {
    if (!ctx?.managedLocalToolNames) return [];
    const names = [];
    for (const tool of tools || []) {
        const name = getToolDefinitionName(tool);
        if (!isProxyManagedLocalToolName(name)) continue;
        ctx.managedLocalToolNames.add(name);
        names.push(name);
    }
    return names;
}

function buildClientToolGuidance(clientTools) {
    if (!Array.isArray(clientTools) || clientTools.length === 0) return '';
    const visibleNames = clientTools
        .map(tool => tool?.name || tool?.function?.name)
        .filter(Boolean);
    if (visibleNames.length === 0) return '';

    const webLike = visibleNames.filter(name =>
        /web[_-]?fetch|web[_-]?search|fetch/i.test(name)
    );
    const coworkLike = visibleNames.filter(name => isCoworkToolName(name));

    const lines = [
        '[CLIENT TOOL INVENTORY]',
        `Visible client tools include: ${visibleNames.join(', ')}.`
    ];

    if (webLike.length > 0) {
        lines.push(`For web access, prefer these visible client-compatible tool names first: ${webLike.join(', ')}.`);
        lines.push('If one of those visible web-fetch tools fails or is blocked, retry the research using the same compatible web-fetch/search name that remains available in the tool list instead of saying browsing is unavailable.');
        lines.push('Do not switch to browser automation for ordinary public web research while a compatible web fetch/search tool is available.');
        lines.push('Once a compatible web fetch/search tool returns content, summarize that content directly instead of switching to august__bash or another refetch tool.');
    }

    if (coworkLike.length > 0) {
        lines.push(`Cowork compatibility tools are available through the proxy: ${coworkLike.join(', ')}.`);
        lines.push('If a Cowork server is reported as unavailable by older client context, still use the visible mcp__cowork__* tool names because August Proxy resolves them locally.');
        lines.push('For Cowork delete-permission calls, remember the compatibility layer only checks safe roots and never deletes files by itself.');
    }

    return lines.join('\n');
}

function isBrowserAutomationToolName(name) {
    if (typeof name !== 'string') return false;
    const normalized = name.toLowerCase();
    return (
        normalized.includes('list_connected_browsers') ||
        normalized.includes('browser_navigate') ||
        normalized.includes('browser_snapshot') ||
        normalized.includes('browser_click') ||
        normalized.includes('browser_type') ||
        normalized.includes('browser_wait') ||
        normalized.includes('browser') ||
        normalized.includes('chrome')
    );
}

module.exports = {
    MANAGED_WEB_TOOL_NAMES,
    isManagedWebToolName,
    isManagedBashToolName,
    getManagedWebToolKind,
    getManagedAnthropicWebToolDefinitions,
    sanitizeAnthropicToolDefinition,
    dedupeAndCanonicalizeAnthropicTools,
    getCanonicalManagedAnthropicWebTools,
    openAiToAnthropicToolDefinition,
    anthropicToOpenAiToolDefinition,
    getCanonicalCoworkAnthropicTools,
    getCanonicalManagedOpenAiWebTools,
    getProxyOpenAiToolDefinitions,
    getToolDefinitionName,
    appendMissingAnthropicTools,
    appendMissingOpenAiTools,
    isProxyManagedLocalToolName,
    rememberManagedLocalToolDefinitions,
    buildClientToolGuidance,
    isBrowserAutomationToolName
};
