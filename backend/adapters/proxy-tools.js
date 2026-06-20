const { logActivity } = require('../lib/logger');
const { getMcpToolDefinitions, isMcpToolName, executeMcpToolCall, sanitizeToolSchema } = require('../services/tools/mcp-client');
const { getAugustToolDefinitions, isAugustToolName, executeAugustToolCall } = require('../services/tools/august-tools');
const { getCoworkToolDefinitions, isCoworkToolName, executeCoworkToolCall } = require('../services/tools/cowork-tools');
const { executeManagedWebTool } = require('../services/tools/local-web');
const { isManagedBashToolName, executeManagedBashTool } = require('../services/tools/local-bash');
const { validateToolArguments } = require('../services/workbench/validator');
const { recordToolFailure } = require('../services/memory/tool-failure-memory');
const { getBrainConfig } = require('../services/memory/brain-orchestrator');
const { executeToolBatch } = require('../services/workbench/tool-executor');
const { isManagedToolParallelSafe, isOpenAiToolCallParallelSafe, parseOpenAiToolArgs } = require('../services/workbench/managed-tool-policy');

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

function getManagedWebLocalToolName(toolName) {
    return (
        toolName === 'WebSearch' ||
        toolName === 'web_search' ||
        toolName === 'mcp__workspace__web_search'
    ) ? 'web_search' : 'web_fetch';
}

function getManagedAnthropicWebToolDefinitions() {
    return [
        {
            name: 'WebSearch',
            description: 'Search the public web for relevant pages. Supports DuckDuckGo (default), Brave Search, and SearXNG backends. Use only for external/public information. Do not combine this tool with any other tool in the same turn.',
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
                        description: 'Maximum number of results to return (max 20).'
                    }
                },
                required: ['query']
            }
        },
        {
            name: 'WebFetch',
            description: 'Fetch a public webpage by URL and convert it to clean Markdown. Private/local network addresses are blocked. Do not combine this tool with any other tool in the same turn.',
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
            description: 'Search the public web for relevant pages. Supports DuckDuckGo (default), Brave Search, and SearXNG backends. Workspace-compatible alias for third-party Claude clients. Do not combine this tool with any other tool in the same turn.',
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
                        description: 'Maximum number of results to return (max 20).'
                    }
                },
                required: ['query']
            }
        },
        {
            name: 'mcp__workspace__web_fetch',
            description: 'Fetch a public webpage by URL and convert it to clean Markdown. Workspace-compatible alias for third-party Claude clients. Private/local network addresses are blocked. Do not combine this tool with any other tool in the same turn.',
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

    return {
        name,
        description: typeof normalized.description === 'string' ? normalized.description : '',
        input_schema: sanitizeToolSchema(normalized.input_schema)
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
            input_schema: sanitizeToolSchema(tool.function.parameters)
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
            parameters: sanitizeToolSchema(tool.input_schema),
            strict: tool.strict
        }
    };
}

function getCanonicalCoworkAnthropicTools() {
    return getCoworkToolDefinitions().map(openAiToAnthropicToolDefinition);
}

// OpenAI-native web tools
function getCanonicalManagedOpenAiWebTools() {
    return [
        {
            type: 'function',
            function: {
                name: 'WebSearch',
                description: 'Search the public web for relevant pages. Supports DuckDuckGo (default), Brave Search, and SearXNG backends.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'The web search query.' },
                        prompt: { type: 'string', description: 'Compatibility alias for query.' },
                        max_results: { type: 'integer', description: 'Maximum number of results (max 20).' }
                    },
                    required: ['query']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'WebFetch',
                description: 'Fetch a public webpage by URL and convert it to clean Markdown. Private/local network addresses are blocked.',
                parameters: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'The public HTTP or HTTPS URL to fetch.' },
                        prompt: { type: 'string', description: 'Compatibility alias for url.' }
                    },
                    required: ['url']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'mcp__workspace__web_search',
                description: 'Search the public web for relevant pages. Supports DuckDuckGo (default), Brave Search, and SearXNG backends. Workspace-compatible alias.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'The web search query.' },
                        prompt: { type: 'string', description: 'Compatibility alias for query.' },
                        max_results: { type: 'integer', description: 'Maximum number of results (max 20).' }
                    },
                    required: ['query']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'mcp__workspace__web_fetch',
                description: 'Fetch a public webpage by URL and convert it to clean Markdown. Workspace-compatible alias.',
                parameters: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'The public HTTP or HTTPS URL to fetch.' },
                        prompt: { type: 'string', description: 'Compatibility alias for url.' }
                    },
                    required: ['url']
                }
            }
        }
    ];
}

// Anthropic-mapped version of OpenAI tools
function getCanonicalManagedAnthropicOpenAiWebTools() {
    return getCanonicalManagedAnthropicWebTools().map(anthropicToOpenAiToolDefinition);
}

// OpenAI version of tool definitions
function getProxyOpenAiToolDefinitions() {
    return [
        ...getMcpToolDefinitions(),
        ...getCoworkToolDefinitions(),
        ...getAugustToolDefinitions(),
        ...getCanonicalManagedOpenAiWebTools()
    ];
}

// Anthropic version of tool definitions
function getProxyOpenAiToolDefinitionsForAnthropic() {
    return [
        ...getMcpToolDefinitions(),
        ...getCoworkToolDefinitions(),
        ...getAugustToolDefinitions(),
        ...getCanonicalManagedAnthropicOpenAiWebTools()
    ];
}

function getToolDefinitionName(tool) {
    return tool?.function?.name || tool?.name || '';
}

function appendMissingTools(targetTools, extraTools) {
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

const appendMissingAnthropicTools = appendMissingTools;
const appendMissingOpenAiTools = appendMissingTools;

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

function formatManagedWebResult(result) {
    if (!result || typeof result !== 'object') {
        return String(result || '');
    }

    if (Array.isArray(result.results)) {
        const lines = [
            `Search query: ${result.query || ''}`.trim(),
            `Result count: ${result.count ?? result.results.length}`
        ].filter(Boolean);

        result.results.forEach((item, index) => {
            lines.push(`[${index + 1}] ${item.title || 'Untitled'}`);
            if (item.url) lines.push(`URL: ${item.url}`);
            if (item.snippet) lines.push(`Snippet: ${item.snippet}`);
        });

        return lines.join('\n');
    }

    if (result.url || result.content) {
        return [
            `Title: ${result.title || ''}`.trim(),
            `URL: ${result.url || ''}`.trim(),
            result.status ? `Status: ${result.status}` : '',
            '',
            result.content || ''
        ].filter(Boolean).join('\n');
    }

    return JSON.stringify(result);
}

function formatManagedToolResult(toolName, result) {
    if (isManagedWebToolName(toolName)) {
        return formatManagedWebResult(result);
    }
    if (isManagedBashToolName(toolName)) {
        if (!result || typeof result !== 'object') return String(result || '');
        const lines = [];
        if (result.stdout) lines.push(result.stdout);
        if (result.stderr) lines.push(`STDERR:\n${result.stderr}`);
        if (result.exitCode) lines.push(`Exit code: ${result.exitCode}`);
        return lines.join('\n') || '(no output)';
    }
    if (typeof result === 'string') return result;
    if (result === undefined || result === null) return '';
    return JSON.stringify(result);
}

async function executeManagedProxyTool(toolName, args, workspacePath = null, onProgress = null, parentSignal = null) {
    if (isManagedWebToolName(toolName)) {
        const localName = getManagedWebLocalToolName(toolName);
        logActivity('WEB', `${toolName} executed locally`);
        return executeManagedWebTool(localName, args || {});
    }
    if (isCoworkToolName(toolName)) {
        logActivity('COWORK', `${toolName} executed by proxy compatibility layer`);
        return executeCoworkToolCall(toolName, args || {});
    }
    if (isAugustToolName(toolName)) {
        logActivity('AUGUST', `${toolName} executed locally`);
        return executeAugustToolCall(toolName, args || {}, false, workspacePath);
    }
    if (isManagedBashToolName(toolName)) {
        logActivity('BASH', `${toolName} executed locally`);
        return executeManagedBashTool(toolName, args || {}, workspacePath, onProgress, parentSignal);
    }
    if (isMcpToolName(toolName)) {
        return executeMcpToolCall(toolName, args || {});
    }
    throw new Error(`Unsupported managed proxy tool: ${toolName}`);
}

async function executeManagedOpenAiToolCalls(toolCalls, knownTools, messages, workspacePath = null, onToolEvent = null, parentSignal = null) {
    const executeOne = async (tc) => {
        const toolName = tc.function?.name;
        if (!toolName) {
            return {
                tool_call_id: tc.id,
                role: 'tool',
                content: 'Error: missing tool name'
            };
        }
        const syntheticCall = { function: { name: toolName, arguments: tc.function?.arguments || '{}' } };
        const validation = validateToolArguments(syntheticCall, knownTools, messages);
        if (!validation.valid) {
            if (onToolEvent) onToolEvent({ type: 'tool_result', name: toolName, id: tc.id, error: validation.error, status: 'error', duration: 0 });
            console.warn(`[Proxy Validator]: OpenAI tool '${toolName}' rejected:`, validation.error);
            return {
                tool_call_id: tc.id,
                role: 'tool',
                content: `[Validation Error] Tool '${toolName}' rejected before execution:\n${validation.error}\n\n[Proxy Self-Heal]: Fix the tool arguments and retry. Do NOT stop.`
            };
        }

        const parsedArgs = parseOpenAiToolArgs(tc);
        // Format args as concise context string like "path=test.txt, limit=10"
        const contextStr = parsedArgs && typeof parsedArgs === 'object'
            ? Object.entries(parsedArgs).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
            : '';
        if (onToolEvent) onToolEvent({ type: 'tool_call', name: toolName, context: contextStr, id: tc.id, status: 'running' });

        const startTime = Date.now();
        try {
            const result = await executeManagedProxyTool(toolName, parsedArgs, workspacePath, (progressText) => {
                if (onToolEvent) {
                    onToolEvent({
                        type: 'tool_progress',
                        name: toolName,
                        id: tc.id,
                        preview: progressText
                    });
                }
            }, parentSignal);
            const duration = Date.now() - startTime;
            if (onToolEvent) onToolEvent({ type: 'tool_result', name: toolName, id: tc.id, summary: String(result).substring(0, 2000), status: 'done', duration });
            return {
                tool_call_id: tc.id,
                role: 'tool',
                content: formatManagedToolResult(toolName, result)
            };
        } catch (e) {
            const duration = Date.now() - startTime;
            if (onToolEvent) onToolEvent({ type: 'tool_result', name: toolName, id: tc.id, error: e.message, status: 'error', duration });
            recordToolFailure({
                toolName,
                args: parsedArgs,
                error: e,
                phase: 'openai-managed-tool'
            });
            return {
                tool_call_id: tc.id,
                role: 'tool',
                content: `Error: ${e.message}`
            };
        }
    };

    return executeToolBatch(toolCalls, executeOne, {
        parallel: getBrainConfig().adapterParallelTools === true,
        canRunInParallel: isOpenAiToolCallParallelSafe
    });
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
    getCanonicalManagedAnthropicOpenAiWebTools,
    getProxyOpenAiToolDefinitions,
    getProxyOpenAiToolDefinitionsForAnthropic,
    getToolDefinitionName,
    appendMissingAnthropicTools,
    appendMissingOpenAiTools,
    isProxyManagedLocalToolName,
    rememberManagedLocalToolDefinitions,
    buildClientToolGuidance,
    isBrowserAutomationToolName,
    getManagedWebLocalToolName,
    formatManagedWebResult,
    formatManagedToolResult,
    executeManagedProxyTool,
    executeManagedOpenAiToolCalls,
    getMcpToolDefinitions,
    getAugustToolDefinitions,
    isManagedToolParallelSafe
};
