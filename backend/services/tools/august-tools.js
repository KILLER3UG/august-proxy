const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);
const readTimestamps = new Map();

const { checkCommandPaths, checkPathPermission, extractPathsFromCommand } = require('../../lib/path-permissions');
const { MEMORY_TOOLS, handleMemoryTool } = require('./memory-tools');
const {
    CORE_MEMORY_FILE,
    CORE_MEMORY_LIMITS,
    checkMemoryBudget,
    getDefaultAugustCoreMemory,
    normalizeAugustCoreMemory,
    readAugustCoreMemory,
    writeAugustCoreMemory,
    renderAugustCoreMemory,
    upsertProject,
    upsertIntegration,
    appendRecentEvent,
    appendCheckpoint
} = require('../memory/core-memory');
const { getDefaultSubagentConfig, loadSubagentConfig, saveSubagentConfig, subagentConfigToContextBlock } = require('./subagent-config');

function formatCoreMemoryBudgetError(section, budget) {
    if (budget.error) return budget.error;
    const limit = CORE_MEMORY_LIMITS[section] || budget.limit;
    return `${section} core memory is ${budget.length}/${limit} characters (${budget.overage} over the ${limit} character limit). Use august__core_memory_replace to compact it before writing.`;
}

// ── Sub-agent Tool Execution ──
// Build tool definitions for the sub-agent from all available managed proxy tools
function buildSubAgentToolDefinitions() {
    const tools = [];
    try {
        const { getMcpToolDefinitions } = require('./mcp-client');
        const mcpTools = getMcpToolDefinitions() || [];
        mcpTools.forEach(t => tools.push(t));
    } catch (e) { /* MCP may be disabled */ }
    try {
        const { getCoworkToolDefinitions } = require('./cowork-tools');
        const coworkTools = getCoworkToolDefinitions() || [];
        coworkTools.forEach(t => tools.push(t));
    } catch (e) { /* ignore */ }
    tools.push({
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the web for up-to-date information on a given query. Returns a list of relevant results with titles, URLs, and snippets.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query.' } }, required: ['query'] }
        }
    });
    tools.push({
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Fetch and return the text content of a URL. Use this to read articles, documentation, or any web page.',
            parameters: { type: 'object', properties: { url: { type: 'string', description: 'The full URL to fetch.' } }, required: ['url'] }
        }
    });
    return tools;
}

// Convert OpenAI-format tool definitions to Anthropic format
function toolsToAnthropicFormat(openAiTools) {
    return openAiTools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters
    }));
}

// Known web tool names for sub-agent dispatch
const SUBAGENT_WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch', 'WebSearch', 'WebFetch', 'mcp__workspace__web_search', 'mcp__workspace__web_fetch']);

function isWebToolName(name) {
    return typeof name === 'string' && SUBAGENT_WEB_TOOL_NAMES.has(name);
}

// Dispatch sub-agent tool calls to the correct managed proxy executor
async function executeSubAgentTool(name, args) {
    if (name === 'august__spawn_subagent') {
        return '[Blocked] Sub-agents cannot spawn further sub-agents. Complete your task using the tools available.';
    }
    try {
        if (isWebToolName(name)) {
            const { executeManagedWebTool, normalizeManagedWebToolName } = require('./local-web');
            return await executeManagedWebTool(normalizeManagedWebToolName(name), args);
        }
    } catch (e) { /* web tools not available */ }
    try {
        const { isMcpToolName, executeMcpToolCall } = require('./mcp-client');
        if (isMcpToolName(name)) return await executeMcpToolCall(name, args);
    } catch (e) { /* MCP not available */ }
    try {
        const { isCoworkToolName, executeCoworkToolCall } = require('./cowork-tools');
        if (isCoworkToolName(name)) return await executeCoworkToolCall(name, args);
    } catch (e) { /* cowork not available */ }
    return `[Tool Error] Tool "${name}" is not available in sub-agent context.`;
}

const AUGUST_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'august__bash',
            description: 'Executes a PowerShell command on the host machine. You MUST show the user the exact command and ask for confirmation before calling this tool with confirmed=true. Always call once without confirmed to show the command, then call again with confirmed=true after approval.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The exact PowerShell command to execute.'
                    },
                    confirmed: {
                        type: 'boolean',
                        description: 'Must be true to actually run the command. Set to false (or omit) on the first call to preview; the proxy will prompt the user for approval.'
                    }
                },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__remember_project',
            description: 'Upserts an active project in August\'s shared brain so the same project context carries across devices and sessions.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Project name.' },
                    status: { type: 'string', description: 'Current project status.' },
                    summary: { type: 'string', description: 'Short description of the project and current focus.' }
                },
                required: ['name', 'summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__remember_integration',
            description: 'Upserts an integration state in August\'s shared brain, such as Claude Desktop, browser tools, phone access, or APIs.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Integration name.' },
                    status: { type: 'string', description: 'Current status of the integration.' },
                    summary: { type: 'string', description: 'Important notes about how the integration behaves.' }
                },
                required: ['name', 'summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__search_past_conversations',
            description: 'Searches the infinite memory vector database for past conversations. Use this when the user asks about something you discussed weeks or months ago that is no longer in your immediate memory. The search uses semantic similarity, so search queries should be full sentences or detailed phrases.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The semantic query to search for.' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__remember_event',
            description: 'Adds an important recent event to August\'s shared brain so future sessions remember what happened.',
            parameters: {
                type: 'object',
                properties: {
                    summary: { type: 'string', description: 'What happened and why it matters.' },
                    source: { type: 'string', description: 'Where this event came from, such as claude-desktop or proxy.' },
                    timestamp: { type: 'string', description: 'Optional ISO timestamp; defaults to now.' }
                },
                required: ['summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__remember_checkpoint',
            description: 'Stores a durable conversation checkpoint so the same assistant identity can resume later across devices.',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'Short topic or conversation area.' },
                    summary: { type: 'string', description: 'What should be remembered for resuming later.' },
                    timestamp: { type: 'string', description: 'Optional ISO timestamp; defaults to now.' }
                },
                required: ['summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__read_file',
            description: 'Reads the contents of a file on the host machine.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute or relative path to the file.'
                    }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__write_file',
            description: 'Creates or overwrites a file on the host machine. You MUST show the user the target path and ask for confirmation before calling this tool with confirmed=true. Always call once without confirmed to preview; the proxy will prompt the user for approval.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute or relative path to the file.'
                    },
                    content: {
                        type: 'string',
                        description: 'The exact text content to write to the file.'
                    },
                    confirmed: {
                        type: 'boolean',
                        description: 'Must be true to actually write the file. Set to false (or omit) on the first call to preview the target path; the proxy will ask the user to confirm.'
                    }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__patch',
            description: 'Patch file(s) using replace mode or V4A patch format. You MUST ask for confirmation before calling this tool with confirmed=true. Always call once without confirmed to preview; the proxy will show a preview/dry-run and prompt the user for approval.',
            parameters: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['replace', 'patch'],
                        description: 'Use "replace" for simple single-file search-and-replace, or "patch" for multi-file V4A patch block.'
                    },
                    path: {
                        type: 'string',
                        description: 'Required if mode is "replace". Absolute or relative path to the file to modify.'
                    },
                    old_string: {
                        type: 'string',
                        description: 'Required if mode is "replace". The exact snippet of text to find.'
                    },
                    new_string: {
                        type: 'string',
                        description: 'Required if mode is "replace". The replacement text.'
                    },
                    replace_all: {
                        type: 'boolean',
                        description: 'If true, replaces all occurrences of old_string. If false, fails if multiple occurrences are found.'
                    },
                    patch: {
                        type: 'string',
                        description: 'Required if mode is "patch". A complete V4A patch block starting with *** Begin Patch and ending with *** End Patch.'
                    },
                    confirmed: {
                        type: 'boolean',
                        description: 'Must be true to actually apply the patch. Set to false (or omit) on the first call to run validation and preview; the proxy will ask the user to confirm.'
                    }
                },
                required: ['mode']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__core_memory_append',
            description: 'Adds a new fact to August\'s Global Brain. Use this to remember user preferences, names, or important project rules across all devices and sessions.',
            parameters: {
                type: 'object',
                properties: {
                    section: {
                        type: 'string',
                        enum: ['user_profile', 'global_context'],
                        description: 'Which section of the brain to append to.'
                    },
                    content: {
                        type: 'string',
                        description: 'The new fact to append.'
                    }
                },
                required: ['section', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__core_memory_replace',
            description: 'Completely rewrites a section of August\'s Global Brain. Use this if the context is getting too long or needs a full update.',
            parameters: {
                type: 'object',
                properties: {
                    section: {
                        type: 'string',
                        enum: ['user_profile', 'global_context'],
                        description: 'Which section of the brain to replace.'
                    },
                    content: {
                        type: 'string',
                        description: 'The complete new text for this section.'
                    }
                },
                required: ['section', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__remember',
            description: 'Stores a durable fact in AUGUST\'s semantic memory. Use for user preferences, personal details, project rules, or workflow conventions that should persist across sessions.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'A unique identifier for this fact (e.g. "prefers_dark_mode", "name", "project_foo_stack").' },
                    value: { type: 'string', description: 'The fact content to remember.' },
                    category: { type: 'string', enum: ['user_preference', 'user_detail', 'project_info', 'workflow_rule', 'session_temp'], description: 'Category for this fact.' },
                    ttl_days: { type: 'number', description: 'Optional TTL in days. null = permanent. session_temp defaults to 1 day, project_info defaults to 90 days.' }
                },
                required: ['key', 'value']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__forget',
            description: 'Permanently removes a fact from AUGUST\'s semantic memory by its key.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'The key of the fact to forget.' }
                },
                required: ['key']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__recall',
            description: 'Searches AUGUST\'s semantic memory for facts matching the query text. Returns matching facts ranked by relevance.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search text to match against fact keys, values, and categories.' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__list_facts',
            description: 'Lists all active (non-expired) semantic memory facts, optionally filtered by category or source.',
            parameters: {
                type: 'object',
                properties: {
                    category: { type: 'string', enum: ['user_preference', 'user_detail', 'project_info', 'workflow_rule', 'session_temp'], description: 'Optional category filter.' },
                    source: { type: 'string', description: 'Optional source client filter (e.g. claude-code, hermes).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__graph_recall',
            description: 'Search August local graph memory across entities, relations, and observations. Use this when relationships between projects, tools, facts, or events matter.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Graph search query. Leave empty to list recent graph memory.' },
                    limit: { type: 'number', description: 'Maximum results per section. Defaults to 8.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__graph_entities',
            description: 'List local graph memory entities, optionally filtered by text.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Optional entity search query.' },
                    limit: { type: 'number', description: 'Maximum entities to return. Defaults to 20.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__graph_observe',
            description: 'Add an observation to August local graph memory. This edits durable memory and should be intentional.',
            parameters: {
                type: 'object',
                properties: {
                    entity: { type: 'string', description: 'Entity name to attach the observation to.' },
                    type: { type: 'string', description: 'Entity type. Defaults to concept.' },
                    text: { type: 'string', description: 'Observation text to remember.' },
                    source: { type: 'string', description: 'Where this observation came from. Defaults to august.' },
                    confidence: { type: 'number', description: 'Confidence from 0 to 1. Defaults to 0.7.' }
                },
                required: ['entity', 'text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__graph_link',
            description: 'Create or update a relationship between two graph memory entities. This edits durable memory and should be intentional.',
            parameters: {
                type: 'object',
                properties: {
                    from: { type: 'string', description: 'Source entity name or id.' },
                    relation: { type: 'string', description: 'Relationship type, such as uses, owns, blocked_by, depends_on, mentions.' },
                    to: { type: 'string', description: 'Target entity name or id.' },
                    from_type: { type: 'string', description: 'Optional source entity type.' },
                    to_type: { type: 'string', description: 'Optional target entity type.' },
                    source: { type: 'string', description: 'Where this relationship came from. Defaults to august.' },
                    confidence: { type: 'number', description: 'Confidence from 0 to 1. Defaults to 0.7.' }
                },
                required: ['from', 'relation', 'to']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__graph_index_memory',
            description: 'Backfill August local graph memory from core memory, semantic facts, recent events, and conversation checkpoints.',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__list_agent_jobs',
            description: 'List durable sub-agent jobs created by AI Workbench.',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', enum: ['running', 'completed', 'failed', 'all'], description: 'Optional status filter.' },
                    session_id: { type: 'string', description: 'Optional Workbench session id filter.' },
                    limit: { type: 'number', description: 'Maximum jobs to return. Defaults to 50.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__get_agent_job',
            description: 'Read one durable sub-agent job and its event/tool trace.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Agent job id.' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__review_learned_guidelines',
            description: 'Lists learned guidelines by review status. Pending guidelines are not strongly injected until approved.',
            parameters: {
                type: 'object',
                properties: {
                    status: {
                        type: 'string',
                        enum: ['pending', 'active', 'rejected', 'archived', 'all'],
                        description: 'Guideline review status to list. Defaults to pending.'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__set_learned_guideline_status',
            description: 'Approves, rejects, archives, or reopens a learned guideline. This changes August Brain behavior and should be done intentionally.',
            parameters: {
                type: 'object',
                properties: {
                    id_or_text: { type: 'string', description: 'Guideline id or exact guideline text.' },
                    status: { type: 'string', enum: ['pending', 'active', 'rejected', 'archived'] }
                },
                required: ['id_or_text', 'status']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__call_specialist',
            description: 'Calls a specialized AI model for a focused task (coding, research, analysis) and returns its response. Use this when the task requires a model optimized for a specific domain.',
            parameters: {
                type: 'object',
                properties: {
                    specialty: {
                        type: 'string',
                        enum: ['coding', 'research', 'analysis'],
                        description: 'Which specialist to invoke.'
                    },
                    task: { type: 'string', description: 'The task description or prompt to send to the specialist.' }
                },
                required: ['specialty', 'task']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__supermemory',
            description: 'Access the Supermemory knowledge graph to store or retrieve durable cross-session memories, documents, and structured knowledge.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['store', 'search', 'list'], description: 'What to do with supermemory.' },
                    content: { type: 'string', description: 'Content to store (required for store action).' },
                    query: { type: 'string', description: 'Search query (required for search action).' },
                    type: { type: 'string', description: 'Document type for storage (e.g. note, code_snippet, specification).' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__spawn_background_task',
            description: 'Spawns a detached PowerShell script that will run in the background indefinitely. Use this for massive scraping jobs, long compiles, or starting watcher servers. The output is streamed to august_background.log',
            parameters: {
                type: 'object',
                properties: {
                    script_content: {
                        type: 'string',
                        description: 'The exact PowerShell script content to execute in the background.'
                    }
                },
                required: ['script_content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__spawn_subagent',
            description: 'Spawns a focused sub-agent to autonomously complete a complex multi-step task. The sub-agent has access to MCP servers, web search/fetch, and file operations. It runs its own reasoning loop and reports back. Use this for tasks that deserve focused attention — research, code generation, debugging, data analysis. The sub-agent\'s results are returned as text.',
            parameters: {
                type: 'object',
                properties: {
                    task: {
                        type: 'string',
                        description: 'The detailed task for the sub-agent. Include context, what tools to use, what to look for, and the expected output format.'
                    }
                },
                required: ['task']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__learn_subagent',
            description: 'Scans all clients passing through the proxy (Claude Desktop, Claude Code, Cline, Cursor, VS Code, custom APIs) to discover how they spawn and manage sub-agents. Extracts patterns, compares against your current strategy, and upgrades if a better approach is found. Call this when you want to improve your sub-agent spawning strategy.',
            parameters: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['auto', 'learn_only', 'report'],
                        description: 'auto = scan, compare, and upgrade if better. learn_only = scan and store patterns without upgrading. report = just return a summary of what is known.'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__find_skill_sources',
            description: 'Find importable skills/capabilities from GitHub or preview a direct GitHub/raw/http URL. Use this when the user asks to fetch a new skill from the internet. This is read-only.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Skill topic, capability name, or direct public URL.' },
                    url: { type: 'string', description: 'Direct GitHub/raw/http URL to resolve instead of searching.' },
                    limit: { type: 'number', description: 'Maximum GitHub candidates. Defaults to 5.' },
                    verify: { type: 'boolean', description: 'When true, preview the first one or two candidates. Defaults to false.' },
                    enable_mcp: { type: 'boolean', description: 'Preview imported MCP servers as enabled. Defaults to false.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__preview_skill_import',
            description: 'Preview what a GitHub/raw/http capability link would save as skills, MCP servers, and plugins. This does not write anything.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'GitHub repo/blob, raw URL, plugin manifest, MCP config, package metadata, pyproject.toml, or SKILL.md URL.' },
                    enable_mcp: { type: 'boolean', description: 'Preview imported MCP servers as enabled. Defaults to false.' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__import_skill',
            description: 'Import and save a skill/capability from a GitHub/raw/http link into the global August skill catalog. Requires explicit user confirmation. Saved skills become available to Claude Code, Hermes, Workbench, Codex, and other proxy clients on the next request.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'GitHub repo/blob, raw URL, plugin manifest, MCP config, package metadata, pyproject.toml, or SKILL.md URL.' },
                    enable_mcp: { type: 'boolean', description: 'Enable imported MCP servers immediately. Defaults to false for safety.' },
                    restart_mcp: { type: 'boolean', description: 'Restart MCP servers after enabling imported MCP servers. Defaults to true.' },
                    confirmed: { type: 'boolean', description: 'Must be true after explicit user approval/confirmation.' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'august__load_skill',
            description: 'Loads the full instructions for a named skill from the skill catalog. Use this when a task description in the catalog matches what you need to do. Returns the complete skill content including trigger conditions and step-by-step guidance.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'The exact name of the skill to load, as listed in the skill_catalog or team_skills section of the system prompt.'
                    },
                    agent_id: {
                        type: 'string',
                        description: 'Optional team agent owner. Use this when loading a skill from the team_skills section for a specific agent.'
                    }
                },
                required: ['name']
            }
        }
    },
    ...MEMORY_TOOLS
];

function isAugustToolName(name) {
    return typeof name === 'string' && name.startsWith('august__');
}

function getAugustToolDefinitions() {
    return AUGUST_TOOLS;
}

async function executeAugustToolCall(toolName, args, bypassConfirmation = false, workspacePath = null) {
    try {
        switch (toolName) {
            case 'august__bash': {
                // ── Permission check ──
                const pathViolation = checkCommandPaths(args.command);
                if (pathViolation) return pathViolation;

                // ── Confirmation gate ──
                // The AI must first call with confirmed=false (or omitted) to surface
                // the command to the user. Only executes when confirmed=true.
                if (!bypassConfirmation && !args.confirmed) {
                    return `[August Confirmation Required]\n` +
                           `The AI wants to run the following PowerShell command on your machine:\n\n` +
                           `  ${args.command}\n\n` +
                           `To approve, call this tool again with the same command and confirmed=true.\n` +
                           `To cancel, tell me to stop.`;
                }
                // Executing in PowerShell explicitly
                const execOpts = { shell: 'powershell.exe' };
                if (workspacePath) {
                    execOpts.cwd = workspacePath;
                }
                const { stdout, stderr } = await execPromise(args.command, execOpts);
                if (stderr && stderr.trim().length > 0) {
                    return `[Executed with Warnings/Errors]\n${stderr}\n[Output]\n${stdout}`;
                }
                return stdout || '[Command executed successfully with no output]';
            }

            case 'august__read_file': {
                const { resolveAnyPath, toDisplayPath } = require('../workbench/workbench');
                const readPath = resolveAnyPath(args.path, workspacePath);

                // ── Permission check ──
                const pathViolation = checkPathPermission(readPath);
                if (pathViolation) return pathViolation;

                if (!fs.existsSync(readPath)) {
                    throw new Error(`File not found: ${readPath}`);
                }
                const maxChars = Math.max(1000, Math.min(80000, Number(args.max_chars || 20000)));
                const text = fs.readFileSync(readPath, 'utf8');

                try {
                    const stat = fs.statSync(readPath);
                    readTimestamps.set(readPath, stat.mtimeMs);
                } catch (e) { /* ignore */ }

                return {
                    path: toDisplayPath(readPath, workspacePath),
                    length: text.length,
                    truncated: text.length > maxChars,
                    content: text.slice(0, maxChars)
                };
            }

            case 'august__write_file': {
                const { resolveAnyPath, toDisplayPath } = require('../workbench/workbench');
                const writePath = resolveAnyPath(args.path, workspacePath);

                // ── Permission check ──
                const pathViolation = checkPathPermission(writePath);
                if (pathViolation) return pathViolation;

                // Check staleness
                let staleWarning = null;
                const oldMtime = readTimestamps.get(writePath);
                if (oldMtime !== undefined && fs.existsSync(writePath)) {
                    const currentMtime = fs.statSync(writePath).mtimeMs;
                    if (currentMtime !== oldMtime) {
                        staleWarning = `Warning: ${args.path} was modified since you last read it (external edit or concurrent agent).`;
                    }
                }

                // ── Confirmation gate ──
                if (!bypassConfirmation && !args.confirmed) {
                    let confirmMsg = `[August Confirmation Required]\n` +
                           `The AI wants to write a file to the following path:\n\n` +
                           `  ${writePath}\n\n`;
                    if (staleWarning) {
                        confirmMsg += `⚠️  ${staleWarning}\n\n`;
                    }
                    confirmMsg += `Content preview (first 300 chars):\n${String(args.content || '').slice(0, 300)}${String(args.content || '').length > 300 ? '\n...(truncated)' : ''}\n\n` +
                           `To approve, call this tool again with the same arguments and confirmed=true.\n` +
                           `To write to a different path, specify a new path and confirmed=true.\n` +
                           `To cancel, tell me to stop.`;
                    return confirmMsg;
                }
                const dir = path.dirname(writePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(writePath, String(args.content || ''), 'utf8');

                try {
                    const stat = fs.statSync(writePath);
                    readTimestamps.set(writePath, stat.mtimeMs);
                } catch (e) { /* ignore */ }

                const result = {
                    status: 'written',
                    path: toDisplayPath(writePath, workspacePath),
                    bytes: Buffer.byteLength(String(args.content || ''), 'utf8')
                };
                if (staleWarning) {
                    result._warning = staleWarning;
                }
                return result;
            }

            case 'august__patch': {
                const { resolveAnyPath, toDisplayPath } = require('../workbench/workbench');
                const { parseV4APatch, applyV4AOperations } = require('../../lib/patch-parser');

                const mode = args.mode;

                // Helper to build list of files affected
                const affectedPaths = [];
                if (mode === 'replace') {
                    if (!args.path) throw new Error("path is required for replace mode");
                    affectedPaths.push(resolveAnyPath(args.path, workspacePath));
                } else if (mode === 'patch') {
                    if (!args.patch) throw new Error("patch is required for patch mode");
                    const parsed = parseV4APatch(args.patch);
                    if (parsed.error) {
                        return { error: parsed.error };
                    }
                    for (const op of parsed.operations) {
                        affectedPaths.push(resolveAnyPath(op.file_path, workspacePath));
                        if (op.new_path) {
                            affectedPaths.push(resolveAnyPath(op.new_path, workspacePath));
                        }
                    }
                } else {
                    throw new Error(`Unknown mode: ${mode}`);
                }

                // Permission check
                for (const p of affectedPaths) {
                    const violation = checkPathPermission(p);
                    if (violation) return violation;
                }

                // Check staleness warnings
                const staleWarnings = [];
                for (const p of affectedPaths) {
                    const oldMtime = readTimestamps.get(p);
                    if (oldMtime !== undefined && fs.existsSync(p)) {
                        const currentMtime = fs.statSync(p).mtimeMs;
                        if (currentMtime !== oldMtime) {
                            staleWarnings.push(`Warning: ${toDisplayPath(p, workspacePath)} was modified since you last read it (external edit or concurrent agent).`);
                        }
                    }
                }
                const warningMsg = staleWarnings.length > 0 ? staleWarnings.join('\n') : null;

                // File operations interface
                const fileOps = {
                    read_file_raw(filePath) {
                        const p = resolveAnyPath(filePath, workspacePath);
                        if (!fs.existsSync(p)) return { error: "File not found" };
                        return { content: fs.readFileSync(p, 'utf8'), error: null };
                    },
                    write_file(filePath, content) {
                        const p = resolveAnyPath(filePath, workspacePath);
                        const dir = path.dirname(p);
                        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                        fs.writeFileSync(p, content, 'utf8');
                        try {
                            readTimestamps.set(p, fs.statSync(p).mtimeMs);
                        } catch (e) { /* ignore */ }
                        return { error: null };
                    },
                    delete_file(filePath) {
                        const p = resolveAnyPath(filePath, workspacePath);
                        if (fs.existsSync(p)) {
                            fs.unlinkSync(p);
                        }
                        return { error: null };
                    },
                    move_file(filePath, newPath) {
                        const p = resolveAnyPath(filePath, workspacePath);
                        const np = resolveAnyPath(newPath, workspacePath);
                        const dir = path.dirname(np);
                        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                        fs.renameSync(p, np);
                        try {
                            if (fs.existsSync(np)) {
                                readTimestamps.set(np, fs.statSync(np).mtimeMs);
                            }
                        } catch (e) { /* ignore */ }
                        return { error: null };
                    }
                };

                // If not confirmed, do validation and show preview
                if (!bypassConfirmation && !args.confirmed) {
                    if (mode === 'replace') {
                        const readResult = fileOps.read_file_raw(args.path);
                        if (readResult.error) {
                            return `Validation failed:\nFile not found: ${args.path}`;
                        }
                        const { fuzzyFindAndReplace } = require('../memory/fuzzy-match');
                        const [newContent, count, strategy, error] = fuzzyFindAndReplace(
                            readResult.content, args.old_string, args.new_string, !!args.replace_all
                        );
                        if (error) {
                            const { formatNoMatchHint } = require('../memory/fuzzy-match');
                            let errMsg = error;
                            const hint = formatNoMatchHint(error, count, args.old_string, readResult.content);
                            if (hint) errMsg += hint;
                            return `Validation failed:\n${errMsg}`;
                        }

                        let confirmMsg = `[August Confirmation Required]\n` +
                                         `The AI wants to perform a search-and-replace on ${args.path}:\n\n`;
                        if (warningMsg) {
                            confirmMsg += `⚠️  ${warningMsg}\n\n`;
                        }
                        confirmMsg += `Find (old_string):\n${args.old_string}\n\n` +
                                      `Replace (new_string):\n${args.new_string}\n\n` +
                                      `To approve, call this tool again with the same arguments and confirmed=true.`;
                        return confirmMsg;
                    } else {
                        const parsed = parseV4APatch(args.patch);
                        if (parsed.error) {
                            return `Validation failed:\n${parsed.error}`;
                        }
                        for (const op of parsed.operations) {
                            op.file_path = resolveAnyPath(op.file_path, workspacePath);
                            if (op.new_path) op.new_path = resolveAnyPath(op.new_path, workspacePath);
                        }
                        const { validateOperations } = require('../../lib/patch-parser');
                        const valErrors = validateOperations(parsed.operations, fileOps);
                        if (valErrors.length > 0) {
                            return `Validation failed:\n` + valErrors.map(e => `  • ${e}`).join('\n');
                        }

                        let confirmMsg = `[August Confirmation Required]\n` +
                                         `The AI wants to apply a V4A patch block:\n\n`;
                        if (warningMsg) {
                            confirmMsg += `⚠️  ${warningMsg}\n\n`;
                        }
                        confirmMsg += `${args.patch}\n\n` +
                                      `To approve, call this tool again with the same arguments and confirmed=true.`;
                        return confirmMsg;
                    }
                }

                // If confirmed, execute the real patch
                if (mode === 'replace') {
                    const readResult = fileOps.read_file_raw(args.path);
                    if (readResult.error) return { error: readResult.error };
                    const { fuzzyFindAndReplace } = require('../memory/fuzzy-match');
                    const [newContent, count, strategy, error] = fuzzyFindAndReplace(
                        readResult.content, args.old_string, args.new_string, !!args.replace_all
                    );
                    if (error) {
                        const { formatNoMatchHint } = require('../memory/fuzzy-match');
                        let errMsg = error;
                        const hint = formatNoMatchHint(error, count, args.old_string, readResult.content);
                        if (hint) errMsg += hint;
                        return { error: errMsg };
                    }
                    const writeResult = fileOps.write_file(args.path, newContent);
                    if (writeResult.error) return { error: writeResult.error };

                    const result = {
                        success: true,
                        files_modified: [toDisplayPath(resolveAnyPath(args.path, workspacePath), workspacePath)],
                        diff: `# Updated: ${args.path}`
                    };
                    if (warningMsg) result._warning = warningMsg;
                    return result;
                } else {
                    const parsed = parseV4APatch(args.patch);
                    if (parsed.error) return { error: parsed.error };
                    for (const op of parsed.operations) {
                        op.file_path = resolveAnyPath(op.file_path, workspacePath);
                        if (op.new_path) op.new_path = resolveAnyPath(op.new_path, workspacePath);
                    }
                    const applyResult = applyV4AOperations(parsed.operations, fileOps);
                    if (!applyResult.success) {
                        return { error: applyResult.error };
                    }
                    const result = {
                        success: true,
                        files_modified: applyResult.files_modified.map(p => {
                            if (p.includes(' -> ')) {
                                const parts = p.split(' -> ');
                                return `${toDisplayPath(resolveAnyPath(parts[0], workspacePath), workspacePath)} -> ${toDisplayPath(resolveAnyPath(parts[1], workspacePath), workspacePath)}`;
                            }
                            return toDisplayPath(resolveAnyPath(p, workspacePath), workspacePath);
                        }),
                        files_created: applyResult.files_created.map(p => toDisplayPath(resolveAnyPath(p, workspacePath), workspacePath)),
                        files_deleted: applyResult.files_deleted.map(p => toDisplayPath(resolveAnyPath(p, workspacePath), workspacePath)),
                        diff: applyResult.diff
                    };
                    if (warningMsg) result._warning = warningMsg;
                    return result;
                }
            }

            case 'august__core_memory_append':
                if (!args?.section || !args?.content) return '[Tool Execution Failed]: section and content are required';
                {
                    const appendMem = readAugustCoreMemory();
                    const current = appendMem[args.section] || '';
                    const candidate = `${current}${current ? '\n' : ''}- ${args.content}`;
                    const budget = checkMemoryBudget(args.section, candidate);
                    if (!budget.valid) {
                        return `[Tool Execution Failed]: ${formatCoreMemoryBudgetError(args.section, budget)} Current ${args.section} memory is ${current.length}/${budget.limit} characters.`;
                    }
                    appendMem[args.section] = candidate;
                    writeAugustCoreMemory(appendMem);
                    return `Successfully appended to ${args.section} memory.`;
                }

            case 'august__core_memory_replace':
                if (!args?.section || !Object.prototype.hasOwnProperty.call(args, 'content')) return '[Tool Execution Failed]: section and content are required';
                {
                    const replaceMem = readAugustCoreMemory();
                    const budget = checkMemoryBudget(args.section, args.content);
                    if (!budget.valid) {
                        return `[Tool Execution Failed]: ${formatCoreMemoryBudgetError(args.section, budget)} Current ${args.section} memory is ${String(replaceMem[args.section] || '').length}/${budget.limit} characters.`;
                    }
                    replaceMem[args.section] = args.content;
                    writeAugustCoreMemory(replaceMem);
                    return `Successfully replaced ${args.section} memory.`;
                }

            case 'august__remember_project': {
                const nextMemory = upsertProject(readAugustCoreMemory(), args);
                writeAugustCoreMemory(nextMemory);
                return `Successfully updated project memory for ${args.name}.`;
            }

            case 'august__remember_integration': {
                const nextMemory = upsertIntegration(readAugustCoreMemory(), args);
                writeAugustCoreMemory(nextMemory);
                return `Successfully updated integration memory for ${args.name}.`;
            }

            case 'august__remember_event': {
                const nextMemory = appendRecentEvent(readAugustCoreMemory(), args);
                writeAugustCoreMemory(nextMemory);
                return `Successfully recorded recent event.`;
            }

            case 'august__remember_checkpoint': {
                const nextMemory = appendCheckpoint(readAugustCoreMemory(), args);
                writeAugustCoreMemory(nextMemory);
                return `Successfully recorded recent conversation checkpoint.`;
            }

            case 'august__search_past_conversations': {
                const { getProfile } = require('../../lib/config');
                const cfg = getProfile('claude'); // Fallback to claude profile for embeddings
                const { searchCheckpoints, searchCheckpointsByText } = require('../memory/vector-db');
                const localFallback = (reason) => {
                    const fallbackResults = searchCheckpointsByText(args.query, 5);
                    if (fallbackResults.length === 0) {
                        return `No past conversations found matching the query. Local fallback was used because ${reason}.`;
                    }
                    return `[Infinite Memory Database Results - local fallback: ${reason}]\n\n` + fallbackResults.map(r =>
                        `Date: ${r.timestamp}\nTopic: ${r.topic}\nSummary: ${r.summary}\nRelevance: ${(r.score * 100).toFixed(1)}%\nEmbedding: ${r.embeddingSource || 'unknown'}`
                    ).join('\n\n---\n\n');
                };
                
                let embeddingsUrl = cfg.targetUrl;
                if (embeddingsUrl && embeddingsUrl.includes('/anthropic')) {
                    embeddingsUrl = embeddingsUrl.replace('/anthropic/v1/messages', '/v1/embeddings').replace('/anthropic', '/v1/embeddings');
                } else if (embeddingsUrl && embeddingsUrl.includes('/v1/')) {
                    embeddingsUrl = embeddingsUrl.substring(0, embeddingsUrl.indexOf('/v1/') + 4) + 'embeddings';
                } else {
                    return localFallback('the proxy could not determine an embeddings endpoint');
                }

                const embedHeaders = { 'Content-Type': 'application/json' };
                if (cfg.apiKey) {
                    embedHeaders['Authorization'] = `Bearer ${cfg.apiKey}`;
                    embedHeaders['x-api-key'] = cfg.apiKey;
                }
                const isMiniMaxEmbed = embeddingsUrl.includes('minimax');
                const embedModel = cfg.embeddingModel || (isMiniMaxEmbed ? 'embo-01' : 'text-embedding-3-small');
                const embedPayload = isMiniMaxEmbed
                    ? { model: embedModel, texts: [args.query], type: 'query' }
                    : { model: embedModel, input: args.query };

                const embedResponse = await fetch(embeddingsUrl, {
                    method: 'POST',
                    headers: embedHeaders,
                    body: JSON.stringify(embedPayload),
                    signal: AbortSignal.timeout(10000)
                });

                if (!embedResponse.ok) {
                    return localFallback(`the embedding API returned HTTP ${embedResponse.status}`);
                }

                const embedData = await embedResponse.json();
                if (embedData.base_resp && Number(embedData.base_resp.status_code || 0) !== 0) {
                    return localFallback(embedData.base_resp.status_msg || `provider status ${embedData.base_resp.status_code}`);
                }

                const vector = isMiniMaxEmbed ? embedData.vectors?.[0] : embedData.data?.[0]?.embedding;
                
                if (!vector || !Array.isArray(vector)) {
                    return localFallback('the embedding provider returned no vector');
                }

                const results = searchCheckpoints(vector, 3);
                
                if (results.length === 0) {
                    return localFallback('semantic embedding search returned no matches');
                }

                return `[Infinite Memory Database Results]\n\n` + results.map(r => 
                    `Date: ${r.timestamp}\nTopic: ${r.topic}\nSummary: ${r.summary}\nRelevance: ${(r.score * 100).toFixed(1)}%\nEmbedding: ${r.embeddingSource || 'unknown'}`
                ).join('\n\n---\n\n');
            }

            case 'august__spawn_background_task': {
                // ── Permission check ──
                const pathViolation = checkCommandPaths(args.script_content);
                if (pathViolation) return pathViolation;

                const scriptName = path.join(__dirname, '..', `august_bg_task_${Date.now()}.ps1`);
                fs.writeFileSync(scriptName, args.script_content, 'utf8');
                const outLog = path.join(__dirname, '..', '..', '..', 'data', 'august_background.log');
                
                // Spawn detached powershell process
                const { spawn } = require('child_process');
                const child = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', scriptName], {
                    detached: true,
                    stdio: ['ignore', fs.openSync(outLog, 'a'), fs.openSync(outLog, 'a')]
                });
                
                child.unref(); // Allow the main proxy to exit without waiting for this child

                // Clean up the temp script file after a short delay.
                // We wait 2 seconds so PowerShell has time to open and read the file
                // before we delete it. The process itself continues running from its
                // in-memory copy once loaded.
                setTimeout(() => {
                    try {
                        if (fs.existsSync(scriptName)) fs.unlinkSync(scriptName);
                    } catch (e) {
                        console.warn(`[August] Failed to delete temp script ${scriptName}:`, e.message);
                    }
                }, 2000);
                
                return `Background task successfully spawned (PID: ${child.pid}). The script is now running independently and its output is streaming into august_background.log. The temporary script file will be auto-deleted in 2 seconds. You can continue interacting with the user immediately.`;
            }

            case 'august__remember':
                const sm = require('../memory/semantic-memory');
                const cat = args.category || 'user_preference';
                const ttl = args.ttl_days !== undefined ? args.ttl_days : null;
                sm.setFact(args.key, args.value, cat, ttl, 'august');
                return `Remembered: "${args.key}" = "${args.value}" (category: ${cat})`;

            case 'august__forget': {
                const sm2 = require('../memory/semantic-memory');
                const found = sm2.deleteFact(args.key);
                return found
                    ? `Forgotten fact: "${args.key}".`
                    : `No fact found with key "${args.key}".`;
            }

            case 'august__recall': {
                const sm3 = require('../memory/semantic-memory');
                const results = sm3.searchFacts(args.query);
                if (results.length === 0) return `No matching facts found for: "${args.query}".`;
                return '[Semantic Memory Results]\n' + results.map(f =>
                    `- ${f.key}: ${f.value} [${f.category}]${f.source ? ` (from ${f.source})` : ''}`
                ).join('\n');
            }

            case 'august__list_facts': {
                const sm4 = require('../memory/semantic-memory');
                let facts;
                if (args.category) facts = sm4.getFactsByCategory(args.category);
                else if (args.source) facts = sm4.getFactsBySource(args.source);
                else facts = sm4.getAllFacts();
                if (facts.length === 0) return 'No semantic memory facts found.';
                const label = args.category ? `category="${args.category}"` : args.source ? `source="${args.source}"` : 'all';
                return `[Semantic Memory Facts (${label})]\n` + facts.map(f =>
                    `- ${f.key}: ${f.value} [${f.category}]${f.source ? ` (from ${f.source})` : ''}${f.ttl ? ` (expires: ${f.ttl})` : ''}`
                ).join('\n');
            }

            case 'august__graph_recall': {
                const { formatGraphSearch } = require('../memory/graph-memory');
                return formatGraphSearch(args.query || '', args.limit || 8);
            }

            case 'august__graph_entities': {
                const { searchGraph, graphStats } = require('../memory/graph-memory');
                const limit = Math.max(1, Math.min(50, Number(args.limit || 20)));
                const result = searchGraph(args.query || '', { limit });
                if (!result.entities.length) return `No graph entities found. Stats: ${JSON.stringify(graphStats().counts)}`;
                return '[August Graph Entities]\n' + result.entities.map(entity =>
                    `- ${entity.id}: ${entity.name} [${entity.type}] confidence=${entity.confidence ?? 'n/a'}`
                ).join('\n');
            }

            case 'august__graph_observe': {
                const { addObservation } = require('../memory/graph-memory');
                const observation = addObservation({
                    entity: args.entity,
                    type: args.type || 'concept',
                    text: args.text,
                    source: args.source || 'august',
                    confidence: args.confidence
                });
                return `Recorded graph observation ${observation.id} on ${observation.entityId}.`;
            }

            case 'august__graph_link': {
                const { upsertRelation } = require('../memory/graph-memory');
                const relation = upsertRelation({
                    from: args.from,
                    fromType: args.from_type || 'concept',
                    type: args.relation || args.type || 'related_to',
                    to: args.to,
                    toType: args.to_type || 'concept',
                    source: args.source || 'august',
                    confidence: args.confidence
                });
                return `Recorded graph relation ${relation.id}: ${relation.from} --${relation.type}--> ${relation.to}.`;
            }

            case 'august__graph_index_memory': {
                const { indexCoreMemory } = require('../memory/graph-memory');
                return indexCoreMemory();
            }

            case 'august__list_agent_jobs': {
                const { listAgentJobs } = require('./agent-jobs');
                return listAgentJobs({ status: args.status || 'all', sessionId: args.session_id, limit: args.limit });
            }

            case 'august__get_agent_job': {
                const { getAgentJob } = require('./agent-jobs');
                return getAgentJob(args.id) || { status: 'not_found', id: args.id };
            }

            case 'august__review_learned_guidelines': {
                const { formatGuidelineReview } = require('../memory/learned-guidelines');
                return '[Learned Guideline Review]\n' + formatGuidelineReview(args.status || 'pending');
            }

            case 'august__set_learned_guideline_status': {
                const { setLearnedGuidelineStatus } = require('../memory/learned-guidelines');
                const updated = setLearnedGuidelineStatus(args.id_or_text, args.status);
                if (!updated) return `No learned guideline found for "${args.id_or_text}".`;
                return `Updated learned guideline ${updated.id} to status "${updated.status}".`;
            }

            case 'august__call_specialist':
                const { getConfig, getProfile } = require('../../lib/config');
                const cfgSpecial = getConfig();
                const endpoints = cfgSpecial.specialistEndpoints || {};
                const ep = endpoints[args.specialty];
                if (!ep) return `No specialist endpoint configured for "${args.specialty}". Available: ${Object.keys(endpoints).join(', ')}`;

                const specPayload = {
                    model: ep.model || 'MiniMax-M2.7',
                    messages: [{ role: 'user', content: args.task }],
                    max_tokens: ep.maxTokens || 4096
                };
                const specHeaders = { 'Content-Type': 'application/json' };
                if (ep.apiKey) specHeaders['Authorization'] = `Bearer ${ep.apiKey}`;

                const specResponse = await fetch(ep.url, {
                    method: 'POST',
                    headers: specHeaders,
                    body: JSON.stringify(specPayload),
                    signal: AbortSignal.timeout(ep.timeoutMs || 120000)
                });
                if (!specResponse.ok) {
                    const errText = await specResponse.text().catch(() => '');
                    return `Specialist "${args.specialty}" returned HTTP ${specResponse.status}: ${errText.slice(0, 300)}`;
                }
                const specData = await specResponse.json();
                const specReply = specData.choices?.[0]?.message?.content || specData.content?.[0]?.text || '(no content)';
                return `[Specialist: ${args.specialty}]\n${specReply}`;

            case 'august__supermemory': {
                const {
                    getSupermemorySettings,
                    listSupermemoryDocuments,
                    searchSupermemory,
                    storeSupermemoryDocument,
                    summarizeSupermemoryResult
                } = require('../memory/supermemory');
                const settings = getSupermemorySettings();
                if (!settings.configured) {
                    return `Supermemory is not configured. Set SUPERMEMORY_API_KEY in .env or save a Supermemory API key in config.`;
                }

                switch (args.action) {
                    case 'store': {
                        if (!args.content) return 'Content is required for store action.';
                        const storeData = await storeSupermemoryDocument({
                            content: args.content,
                            type: args.type || 'note'
                        });
                        return `Stored in Supermemory. ID: ${storeData.id || storeData.documentId || 'ok'}`;
                    }
                    case 'search': {
                        if (!args.query) return 'Query is required for search action.';
                        const searchData = await searchSupermemory({ query: args.query, limit: 5 });
                        const results = searchData.results || searchData.data || [];
                        if (results.length === 0) return 'No results from Supermemory.';
                        return '[Supermemory Results]\n' + results.slice(0, 5).map((r, i) =>
                            `[${i + 1}] ${summarizeSupermemoryResult(r).slice(0, 180)}`
                        ).join('\n');
                    }
                    case 'list': {
                        const listData = await listSupermemoryDocuments({ limit: 10 });
                        const docs = listData.memories || listData.documents || listData.data || [];
                        if (docs.length === 0) return 'No documents in Supermemory.';
                        return '[Supermemory Documents]\n' + docs.slice(0, 10).map((d, i) =>
                            `[${i + 1}] ${d.title || d.summary || d.content?.slice(0, 80) || '(untitled)'} (ID: ${d.id})`
                        ).join('\n');
                    }
                    default:
                        return `Unknown supermemory action: ${args.action}. Use store, search, or list.`;
                }
            }

            case 'august__spawn_subagent': {
                const subCfg = loadSubagentConfig();
                const strategy = subCfg.current;
                const { getProfile: getProfileForSub } = require('../../lib/config');
                const subProfile = getProfileForSub('claude') || getProfileForSub('codex') || {};
                const subTargetUrl = subProfile.targetUrl;
                const subApiKey = subProfile.apiKey;
                const subModel = subProfile._upstreamModel || subProfile.currentModel || 'claude-opus-4-6';

                if (!subTargetUrl) return '[Error] No upstream provider configured for sub-agent.';

                const subPrompt = `${strategy.system_prompt}\n\nTASK: ${args.task}`;
                const subTools = buildSubAgentToolDefinitions();
                const subMessages = [{ role: 'user', content: args.task }];
                let subFinalText = '';
                let subLoops = 0;
                let subError = false;
                const subStartTime = Date.now();

                while (subLoops < strategy.max_loops) {
                    subLoops++;
                    try {
                        const isAnthropic = subTargetUrl.includes('anthropic') || subTargetUrl.includes('/v1/messages');
                        let body, headers;
                        if (isAnthropic) {
                            headers = { 'Content-Type': 'application/json', 'x-api-key': subApiKey || '', 'anthropic-version': '2023-06-01' };
                            if (subApiKey) headers['Authorization'] = `Bearer ${subApiKey}`;
                            body = JSON.stringify({
                                model: subModel,
                                max_tokens: 8192,
                                system: subPrompt,
                                messages: subMessages,
                                tools: toolsToAnthropicFormat(subTools)
                            });
                        } else {
                            headers = { 'Content-Type': 'application/json' };
                            if (subApiKey) headers['Authorization'] = `Bearer ${subApiKey}`;
                            body = JSON.stringify({
                                model: subModel,
                                max_tokens: 8192,
                                messages: [{ role: 'system', content: subPrompt }, ...subMessages],
                                tools: subTools,
                                stream: false
                            });
                        }

                        const subRes = await fetch(subTargetUrl, {
                            method: 'POST', headers, body,
                            signal: AbortSignal.timeout(180000)
                        });
                        const subRaw = await subRes.text();
                        if (!subRes.ok) {
                            subFinalText = `[Sub-agent upstream error: ${subRaw.slice(0, 300)}]`;
                            subError = true;
                            break;
                        }

                        const subData = JSON.parse(subRaw);
                        let blocks;
                        if (isAnthropic) {
                            blocks = Array.isArray(subData.content) ? subData.content : [];
                        } else {
                            const msg = subData.choices?.[0]?.message || {};
                            const content = msg.content || '';
                            const toolCalls = msg.tool_calls || [];
                            blocks = [];
                            if (content) blocks.push({ type: 'text', text: content });
                            toolCalls.forEach(tc => {
                                blocks.push({
                                    type: 'tool_use',
                                    id: tc.id,
                                    name: tc.function?.name || tc.name,
                                    input: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch(e) { return {}; } })()
                                });
                            });
                        }

                        const textBlocks = blocks.filter(b => b.type === 'text');
                        if (textBlocks.length) subFinalText = textBlocks.map(b => b.text || '').join('\n');
                        subMessages.push({ role: 'assistant', content: blocks });

                        const toolUses = blocks.filter(b => b.type === 'tool_use');
                        if (!toolUses.length) break;

                        const toolResults = [];
                        for (const tu of toolUses) {
                            try {
                                const result = await executeSubAgentTool(tu.name, tu.input || {});
                                toolResults.push({
                                    type: 'tool_result',
                                    tool_use_id: tu.id,
                                    content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
                                    is_error: false
                                });
                            } catch (e) {
                                toolResults.push({
                                    type: 'tool_result',
                                    tool_use_id: tu.id,
                                    content: `[Sub-agent Tool Error] ${e.message}`,
                                    is_error: true
                                });
                            }
                        }
                        subMessages.push({ role: 'user', content: toolResults });
                    } catch (e) {
                        subFinalText = `[Sub-agent error at loop ${subLoops}]: ${e.message}`;
                        subError = true;
                        break;
                    }
                }

                const elapsed = Date.now() - subStartTime;
                subCfg.metadata.total_spawns++;
                if (!subError) subCfg.metadata.total_successes++;
                const curScore = subCfg.current.score;
                const n = curScore.total_runs;
                const newN = n + 1;
                const successVal = subError ? 0 : 1;
                curScore.completion_rate = ((curScore.completion_rate * n) + successVal) / newN;
                curScore.avg_loops = ((curScore.avg_loops * n) + subLoops) / newN;
                curScore.error_rate = ((curScore.error_rate * n) + (subError ? 1 : 0)) / newN;
                curScore.total_runs = newN;
                curScore.last_run = new Date().toISOString();
                saveSubagentConfig(subCfg);

                const status = subError ? 'errored' : 'completed';
                const summary = `[August Sub-agent] (${status}, ${subLoops} loop${subLoops > 1 ? 's' : ''}, ${elapsed}ms)${subError ? '\n' + subFinalText : '\n' + subFinalText}`;
                return summary;
            }

            case 'august__learn_subagent': {
                const mode = args.mode || 'auto';
                const cfg = loadSubagentConfig();
                const reportLines = ['[August Sub-agent Learning Report]'];
                reportLines.push(`Mode: ${mode}\n`);

                // Read the request log
                const REQUEST_LOG_PATH = path.join(__dirname, '..', '..', '..', 'data', 'request-log.json', 'log.json');
                let entries = [];
                try {
                    const raw = fs.readFileSync(REQUEST_LOG_PATH, 'utf8');
                    entries = JSON.parse(raw);
                } catch (e) {
                    reportLines.push(`Could not read request log: ${e.message}`);
                    if (mode !== 'report') {
                        reportLines.push('\n[Learning skipped — request log unavailable]');
                    }
                    return reportLines.join('\n');
                }

                if (!Array.isArray(entries) || entries.length === 0) {
                    reportLines.push('No request log entries found.');
                    return reportLines.join('\n');
                }

                // Scan the last 1000 entries
                const scanSize = Math.min(entries.length, 1000);
                const recent = entries.slice(-scanSize);
                reportLines.push(`Scanning ${scanSize} request log entries across all clients...\n`);

                // Detect unique client types
                const clientTypes = new Set();
                const subagentPatterns = [];
                recent.forEach(entry => {
                    const body = (() => { try { return JSON.parse(entry.requestBody || '{}'); } catch(e) { return {}; } })();
                    const resp = (() => { try { return JSON.parse(entry.responseBody || '{}'); } catch(e) { return {}; } })();
                    const headers = (() => { try { return JSON.parse(entry.requestHeaders || '{}'); } catch(e) { return {}; } })();
                    const client = headers['anthropic-client'] || headers['user-agent'] || body.client || 'unknown';
                    clientTypes.add(client);

                    // Look for sub-agent patterns in system prompts
                    const systemContent = body.system || '';
                    const sysStr = typeof systemContent === 'string' ? systemContent : JSON.stringify(systemContent);
                    if (sysStr && (sysStr.includes('sub-agent') || sysStr.includes('subagent') || sysStr.includes('sub_agent') || sysStr.includes('delegate') || sysStr.includes('spawn sub'))) {
                        subagentPatterns.push({
                            client,
                            source: 'system_prompt',
                            snippet: sysStr.slice(0, 500),
                            timestamp: entry.timestamp || entry.createdAt || new Date().toISOString()
                        });
                    }

                    // Look for sub-agent patterns in tool definitions
                    const tools = Array.isArray(body.tools) ? body.tools : [];
                    tools.forEach(t => {
                        const tName = t.function?.name || t.name || '';
                        if (tName.includes('subagent') || tName.includes('sub_agent') || tName.includes('delegate') || tName.includes('fork') || tName.includes('spawn')) {
                            subagentPatterns.push({
                                client,
                                source: `tool_definition:${tName}`,
                                snippet: t.function?.description || t.description || '',
                                timestamp: entry.timestamp || entry.createdAt || new Date().toISOString()
                            });
                        }
                    });

                    // Look for sub-agent tool call patterns in response
                    const respContent = Array.isArray(resp.content) ? resp.content : [];
                    respContent.forEach(block => {
                        if (block.type === 'tool_use' && (block.name.includes('subagent') || block.name.includes('sub_agent') || block.name.includes('delegate') || block.name.includes('spawn'))) {
                            subagentPatterns.push({
                                client,
                                source: `tool_call:${block.name}`,
                                snippet: JSON.stringify(block.input || {}).slice(0, 300),
                                timestamp: entry.timestamp || entry.createdAt || new Date().toISOString()
                            });
                        }
                    });
                });

                reportLines.push(`Client types detected: ${[...clientTypes].join(', ')}`);
                reportLines.push(`Sub-agent patterns found: ${subagentPatterns.length}\n`);

                // Store observed patterns
                const existingSources = new Set(cfg.observed_patterns.map(p => `${p.source}|${p.client}`));
                subagentPatterns.forEach(p => {
                    const key = `${p.source}|${p.client}`;
                    if (!existingSources.has(key)) {
                        cfg.observed_patterns.push(p);
                        existingSources.add(key);
                    }
                });

                if (subagentPatterns.length === 0) {
                    reportLines.push('No sub-agent patterns found in recent request log entries.');
                    reportLines.push('Your current strategy remains active.');
                    if (mode === 'auto') reportLines.push('\nNo upgrade needed — no patterns discovered to learn from.');
                    saveSubagentConfig(cfg);
                    return reportLines.join('\n');
                }

                // Show discovered patterns
                reportLines.push('Discovered patterns:');
                subagentPatterns.slice(0, 10).forEach((p, i) => {
                    reportLines.push(`\n[${i + 1}] Client: ${p.client}`);
                    reportLines.push(`    Source: ${p.source}`);
                    reportLines.push(`    Snippet: ${p.snippet.slice(0, 200)}`);
                    if (p.timestamp) reportLines.push(`    Seen: ${p.timestamp}`);
                });
                if (subagentPatterns.length > 10) reportLines.push(`\n... and ${subagentPatterns.length - 10} more patterns`);

                if (mode === 'learn_only' || mode === 'report') {
                    saveSubagentConfig(cfg);
                    reportLines.push(`\nMode is "${mode}" — strategy unchanged.`);
                    return reportLines.join('\n');
                }

                // Auto mode: generate candidate strategy from discovered patterns
                // Extract the most common patterns and build an improved strategy
                const bestPattern = subagentPatterns.reduce((best, p) => {
                    return (p.snippet.length > (best?.snippet.length || 0)) ? p : best;
                }, subagentPatterns[0]);

                const prevStrategy = cfg.current;
                const newStrategy = {
                    name: `learned_${new Date().toISOString().slice(0, 10)}`,
                    system_prompt: bestPattern.snippet.length > 100
                        ? bestPattern.snippet
                        : prevStrategy.system_prompt,
                    max_loops: prevStrategy.max_loops,
                    score: { completion_rate: 0, avg_loops: 0, total_runs: 0, error_rate: 0 },
                    source: bestPattern.client,
                    created: new Date().toISOString(),
                    derived_from: bestPattern.source
                };

                // Keep the old strategy in history
                cfg.history.push({ ...prevStrategy, retired: new Date().toISOString() });
                if (cfg.history.length > 20) cfg.history = cfg.history.slice(-20);

                cfg.current = newStrategy;
                cfg.metadata.last_learning_at = new Date().toISOString();
                cfg.metadata.total_learnings++;
                saveSubagentConfig(cfg);

                reportLines.push(`\n[Upgrade Applied]`);
                reportLines.push(`Previous strategy "${prevStrategy.name}" archived.`);
                reportLines.push(`New strategy "${newStrategy.name}" activated (source: ${bestPattern.client}).`);
                reportLines.push(`System prompt length: ${newStrategy.system_prompt.length} chars.`);
                reportLines.push(`\nAugust can call august__learn_subagent again anytime to scan for newer patterns.`);

                return reportLines.join('\n');
            }

            case 'august__find_skill_sources': {
                const { findSkillSources } = require('./skill-importer');
                return findSkillSources({
                    query: args.query,
                    url: args.url,
                    limit: args.limit,
                    verify: args.verify === true,
                    enableMcp: args.enable_mcp === true
                });
            }

            case 'august__preview_skill_import': {
                const { previewSkillImport } = require('./skill-importer');
                return previewSkillImport({
                    url: args.url,
                    enableMcp: args.enable_mcp === true
                });
            }

            case 'august__import_skill': {
                if (!bypassConfirmation && !args.confirmed) {
                    return `[August Confirmation Required]\n` +
                           `The AI wants to import and save a proxy skill/capability from:\n\n` +
                           `  ${args.url || '(missing url)'}\n\n` +
                           `This can add local skills, plugins, and MCP server config that will be visible to all clients connected through this proxy.\n` +
                           `To approve, call this tool again with the same URL and confirmed=true.\n` +
                           `To cancel, tell me to stop.`;
                }
                const { importSkillFromLink } = require('./skill-importer');
                return importSkillFromLink({
                    url: args.url,
                    enableMcp: args.enable_mcp === true,
                    restartMcp: args.restart_mcp !== false
                });
            }

            case 'august__load_skill': {
                const { getSkillsForAgent } = require('./skills');
                const agentId = String(args.agent_id || '').trim();
                const skill = (agentId ? getSkillsForAgent(agentId) : getSkillsForAgent('')).find(s => s.name === args.name);
                if (!skill) {
                    const available = (agentId ? getSkillsForAgent(agentId) : getSkillsForAgent('')).map(s => `"${s.name}"${s.ownerAgentId ? ` (owned by ${s.ownerAgentId})` : ''}`).join(', ');
                    return `Skill "${args.name}" not found for agent ${agentId || 'global'}. Available skills: ${available}`;
                }
                return [
                    `## Skill: ${skill.name}`,
                    skill.ownerAgentId ? `**Owner agent:** ${skill.ownerAgentId}` : '**Owner agent:** global',
                    skill.description ? `\n${skill.description}` : '',
                    skill.trigger ? `\n**Trigger:** ${skill.trigger}` : '',
                    `\n### Instructions\n\n${skill.instructions}`
                ].join('\n');
            }

            case 'august__scan_brain':
                return handleMemoryTool(toolName, args);

            case 'august__memory_topics':
            case 'august__memory_search':
            case 'august__memory_read':
            case 'august__fact_search':
            case 'august__context_read':
            case 'august__graph_explore':
            case 'august__scan_brain':
            case 'august__memory_pack':
            case 'august__brain_edit':
            case 'august__brain_commit':
            case 'august__memory_retention':
            case 'august__memory_retention_apply':
            case 'august__model_observation':
                return handleMemoryTool(toolName, args);

            default:
                throw new Error(`Unknown august tool: ${toolName}`);
        }
    } catch (error) {
        return `[Tool Execution Failed]: ${error.message}`;
    }
}

module.exports = {
    getAugustToolDefinitions,
    isAugustToolName,
    executeAugustToolCall,
    readAugustCoreMemory,
    writeAugustCoreMemory,
    renderAugustCoreMemory,
    loadSubagentConfig,
    saveSubagentConfig,
    subagentConfigToContextBlock
};
