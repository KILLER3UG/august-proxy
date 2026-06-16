const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { getProfile } = require('../../lib/config');
const { resolveActiveProvider } = require('../../providers/provider-resolver');
const { buildSystemPromptText } = require('../memory/context-builder');
const semanticMemory = require('../memory/semantic-memory');
const hostAgent = require('../../lib/host-agent');
const { getMcpToolDefinitions, executeMcpToolCall, isMcpToolName } = require('../tools/mcp-client');
const { getAugustToolDefinitions, executeAugustToolCall, isAugustToolName } = require('../tools/august-tools');
const { getCoworkToolDefinitions, executeCoworkToolCall, isCoworkToolName } = require('../tools/cowork-tools');
const { executeManagedWebTool, isManagedWebToolName, getManagedWebToolDefinitions } = require('../tools/local-web');
const { extractAndSaveMemories } = require('../memory/auto-memory');
const { getBrainDiagnostics } = require('../memory/brain-diagnostics');
const { getBrainConfig, getWorkbenchMaxToolLoops, planBrainTurn } = require('../memory/brain-orchestrator');
const { getCapabilityHealth } = require('../monitoring/health');
const { dataPath } = require('../../lib/data-paths');
const { getActivityLog, getPendingRequests, getRequestLog, getStats } = require('../../lib/logger');
const { findSkillSources, importSkillFromLink, previewSkillImport } = require('../tools/skill-importer');
const { executeToolBatch } = require('./tool-executor');
const { recordToolFailure } = require('../memory/tool-failure-memory');
const {
    appendAgentJobMessage,
    appendAgentJobToolResult,
    completeAgentJob,
    createAgentJob,
    failAgentJob,
    getAgentJob,
    listAgentJobs
} = require('../tools/agent-jobs');
const {
    canCrossLoadTeamSkills,
    deriveChildAgentPermissions,
    evaluateAgentTool,
    getAgent,
    getAgents,
    TEAM_AGENT_IDS,
    renderAgentContext
} = require('../tools/agent-registry');
const { renderTeamSkillsForSystem } = require('../tools/skills');
const { getTeamSkills } = require('../tools/skills');
const modelCatalog = require('../catalog/model-catalog');

/**
 * Resolve the provider profile for a Workbench turn.
 *
 * The proxy no longer assumes a "claude"/"codex" profile exists — providers
 * are configured by name (e.g. opencode-zen) under the active provider. This
 * resolves the active provider first (the real source of targetUrl/apiKey),
 * then falls back to the legacy claude/codex profile.
 *
 * Crucially, the upstream API *format* (Anthropic Messages vs OpenAI Chat) is
 * decided by the provider's apiMode, NOT by the session.provider hint. Most
 * configured providers (opencode-zen, kilo, deepseek, openrouter, …) are
 * openai_chat, so the Workbench must send OpenAI-format requests to them even
 * when the session hint is 'claude'. The returned profile carries:
 *   - targetUrl: the FULL endpoint URL for the resolved format
 *   - useOpenAiFormat: true → send OpenAI /chat/completions shape
 *   - apiMode, currentModel, _upstreamModel, apiKey, etc.
 */
function resolveWorkbenchProfile(provider) {
    // 1. Try the active provider (real config: targetUrl + apiKey + model).
    try {
        const resolved = resolveActiveProvider();
        if (resolved && resolved.baseUrl && resolved.apiKey) {
            const apiMode = resolved.apiMode || 'openai_chat';
            const useOpenAiFormat = apiMode !== 'anthropic_messages';
            const model = resolved.model || resolved.defaultModel;
            return {
                targetUrl: useOpenAiFormat
                    ? normalizeOpenAiTargetUrl({ targetUrl: resolved.baseUrl })
                    : ensureAnthropicMessagesUrl(resolved.baseUrl),
                apiKey: resolved.apiKey,
                currentModel: model,
                _upstreamModel: model,
                contextWindow: resolved.contextWindow,
                providerName: resolved.name,
                apiMode,
                useOpenAiFormat,
                inputCostPer1M: resolved.inputCostPer1M,
                outputCostPer1M: resolved.outputCostPer1M,
            };
        }
    } catch (e) {
        console.warn('[Workbench] resolveActiveProvider failed, falling back to legacy profile:', e.message);
    }

    // 2. Fall back to the legacy claude/codex profile shape.
    const legacy = getProfile(provider) || {};
    if (!legacy.targetUrl) {
        throw new Error(`${provider === 'codex' ? 'Codex' : 'Claude'} profile target URL is missing — set an active provider with a baseUrl and API key.`);
    }
    // A legacy 'codex' profile is OpenAI-shaped; a 'claude' profile may point at
    // either an Anthropic-native or an OpenAI-compatible upstream (some setups
    // set a claude profile targetUrl to an OpenAI endpoint).
    const legacyUseOpenAi = provider === 'codex' || /\/chat\/completions/i.test(legacy.targetUrl);
    return {
        ...legacy,
        targetUrl: legacyUseOpenAi ? normalizeOpenAiTargetUrl(legacy) : legacy.targetUrl,
        apiMode: legacyUseOpenAi ? 'openai_chat' : 'anthropic_messages',
        useOpenAiFormat: legacyUseOpenAi,
    };
}

/** Build the full /chat/completions URL from a provider baseUrl. */
function normalizeOpenAiTargetUrl(profile) {
    const target = String(profile.targetUrl || profile.baseUrl || '').trim();
    if (!target) return '';
    if (/\/chat\/completions$/i.test(target)) return target;
    return target.replace(/\/+$/, '').replace(/\/models$/i, '') + '/chat/completions';
}

/** Build the full /v1/messages URL from an Anthropic-native provider baseUrl. */
function ensureAnthropicMessagesUrl(baseUrl) {
    const target = String(baseUrl || '').trim();
    if (!target) return '';
    if (/\/v1\/messages$/i.test(target)) return target;
    return target.replace(/\/+$/, '').replace(/\/models$/i, '') + '/v1/messages';
}

// ── Reasoning effort helpers ─────────────────────────────────────────────
//
// A user-facing "effort" knob (low / medium / high / max) that meaningfully
// changes the model call. Resolution priority (first non-null wins):
//   1. effort explicitly passed to this turn
//   2. session.effort (last value the user picked for this workbench session)
//   3. model-catalog default for the resolved model
//   4. "medium"
//
// Per-provider mapping is applied at the call site:
//   • Anthropic (supportsThinking) → thinking.budget_tokens
//   • Anthropic (no native thinking) → system-prompt instruction
//   • OpenAI / Codex / OpenAI-compatible (supportsReasoning) → reasoning_effort
const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];

function normalizeEffort(value) {
    if (typeof value !== 'string') return null;
    const lower = value.toLowerCase().trim();
    return EFFORT_LEVELS.includes(lower) ? lower : null;
}

function resolveEffectiveEffort(incoming, session, modelEntry) {
    return normalizeEffort(incoming)
        || normalizeEffort(session && session.effort)
        || normalizeEffort(modelEntry && modelEntry.reasoningEffort)
        || 'medium';
}

function effortToThinkingBudget(effort, modelMax, maxTokens) {
    const base = (() => {
        switch (effort) {
            case 'low':    return 4000;
            case 'medium': return 16000;
            case 'high':   return 64000;
            case 'max':    return 128000;
            default:       return 16000;
        }
    })();
    let budget = base;
    if (modelMax && modelMax > 0) budget = Math.min(budget, modelMax);
    // Anthropic rejects budget_tokens >= max_tokens. Clamp to maxTokens - 1.
    if (maxTokens && maxTokens > 0) budget = Math.min(budget, maxTokens - 1);
    // Anthropic requires a minimum of 1024 budget tokens. If we can't honor
    // that, return 0 so the caller skips the thinking block.
    return budget >= 1024 ? budget : 0;
}

function effortToPromptInstruction(effort) {
    switch (effort) {
        case 'low':
            return 'Be concise. Think briefly before answering.';
        case 'high':
            return 'Think deeply and methodically. Consider edge cases and verify your reasoning before answering.';
        case 'max':
            return 'Think as deeply as possible. Plan, verify, and challenge your own assumptions before answering.';
        case 'medium':
        default:
            return 'Think carefully through the problem before answering.';
    }
}

// Map August's 4-level effort to OpenAI's 3-level reasoning_effort.
// OpenAI rejects "max"; clamp silently (matches Hermes behaviour).
function effortToOpenAiReasoningEffort(effort) {
    if (effort === 'low' || effort === 'medium' || effort === 'high') return effort;
    if (effort === 'max') return 'high';
    return null;
}

/**
 * Resolve the Workbench profile for a session. Single source of truth that all
 * call sites should use — picks the format from the provider, not session hint.
 */
function getWorkbenchProfile(session) {
    const provider = session?.provider === 'codex' ? 'codex' : 'claude';
    return resolveWorkbenchProfile(provider);
}

const sessions = new Map();
const WORKBENCH_SESSIONS_FILE = dataPath('august_workbench_sessions.json');

function loadSessions() {
    if (sessions.size > 0) return;
    try {
        if (fs.existsSync(WORKBENCH_SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(WORKBENCH_SESSIONS_FILE, 'utf8'));
            for (const session of data.sessions || []) {
                sessions.set(session.id, session);
            }
        }
    } catch (e) {
        console.warn('Failed to load workbench sessions:', e.message);
    }
}

function saveSessions() {
    try {
        const all = Array.from(sessions.values());
        all.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
        // keep last 50
        const toSave = all.slice(-50);
        fs.writeFileSync(WORKBENCH_SESSIONS_FILE, JSON.stringify({ sessions: toSave }));
    } catch (e) {
        console.warn('Failed to save workbench sessions:', e.message);
    }
}
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..');
const PROJECT_ROOT = path.resolve(WORKSPACE_ROOT);
const CONTAINER_PROJECT_ROOT = path.resolve(process.env.AUGUST_PROXY_CONTAINER_ROOT || PROJECT_ROOT);
const LEGACY_HOST_PROJECT_ROOTS = [
    'C:/Users/rober/LocalFolders/august-proxy',
    'C:/Users/rober/LocalFolders/DockerContainer/august-proxy'
];

function getWorkspaceRoot() {
    return path.resolve(process.env.AUGUST_PROXY_WORKDIR || process.env.AUGUST_WORKDIR || WORKSPACE_ROOT);
}

function getProjectRoot() {
    return path.resolve(process.env.AUGUST_PROXY_PROJECT_ROOT || getWorkspaceRoot());
}

function getContainerProjectRoot() {
    return path.resolve(process.env.AUGUST_PROXY_CONTAINER_ROOT || getProjectRoot());
}

function getProxyRoot() {
    return path.resolve(process.env.AUGUST_PROXY_ROOT || WORKSPACE_ROOT);
}

function getHostProjectRoots() {
    return uniquePaths([
        ...splitConfiguredRoots(process.env.AUGUST_PROXY_HOST_ROOTS),
        ...splitConfiguredRoots(process.env.AUGUST_PROXY_HOST_ROOT),
        ...splitConfiguredRoots(process.env.AUGUST_HOST_ROOT),
        getProjectRoot(),
        ...LEGACY_HOST_PROJECT_ROOTS
    ]);
}
const COMPACT_THRESHOLD = 60;      // compact messages after this many entries
const COMPACT_KEEP_RECENT = 12;    // keep last N messages verbatim
const DRIFT_INTERVAL = 8;          // inject identity reminder every N tool-result turns
const MAX_RETRIES = 2;             // upstream fetch retry count
const GOAL_CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

function splitConfiguredRoots(value) {
    return String(value || '')
        .split(/[;|]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function uniquePaths(paths) {
    const seen = new Set();
    const result = [];
    for (const item of paths.filter(Boolean)) {
        const key = normalizeForCompare(item);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

function normalizeForCompare(value) {
    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
}

const HOST_PROJECT_ROOTS = [];

function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveAgentId(agentId, fallback = 'build') {
    const id = String(agentId || '').trim();
    if (id && getAgents().some(agent => agent.id === id)) return id;
    return fallback;
}

function createWorkbenchSession({ provider = 'claude', agentId = 'build' } = {}) {
    const resolvedAgentId = resolveAgentId(agentId, 'build');
    const session = {
        id: newId('wb'),
        provider: provider === 'codex' ? 'codex' : 'claude',
        agentId: resolvedAgentId,
        parentAgentId: null,
        inheritedPermissions: null,
        messages: [],
        plan: null,
        approved: false,
        approvedAt: null,
        goal: null,
        lastGoal: null,
        mutationLog: [],
        todos: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    loadSessions();
    sessions.set(session.id, session);
    saveSessions();
    return summarizeSession(session);
}

function getWorkbenchSession(id) {
    loadSessions();
    if (id && sessions.has(id)) return sessions.get(id);
    const newSession = createWorkbenchSession();
    return sessions.get(newSession.id);
}

function listWorkbenchSessions() {
    loadSessions();
    const all = Array.from(sessions.values());
    all.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
    return all.map(summarizeSession);
}

function summarizeSession(session) {
    const agent = getAgent(session.agentId || 'build');
    return {
        id: session.id,
        title: session.title,
        provider: session.provider,
        agentId: agent.id,
        agentRole: agent.role,
        agentMode: agent.mode,
        approved: session.approved,
        approvedAt: session.approvedAt,
        plan: session.plan,
        goal: summarizeGoal(session.goal),
        lastGoal: summarizeGoal(session.lastGoal),
        messageCount: session.messages.length,
        mutationCount: Array.isArray(session.mutationLog) ? session.mutationLog.length : 0,
        lastMutationAt: Array.isArray(session.mutationLog) && session.mutationLog.length
            ? session.mutationLog[session.mutationLog.length - 1].at
            : null,
        updatedAt: session.updatedAt,
        todos: Array.isArray(session.todos) ? session.todos : []
    };
}

function extractAndSyncTodos(session) {
    const assistantMsgs = session.messages.filter(m => m.role === 'assistant');
    if (!assistantMsgs.length) return;
    const lastMsg = assistantMsgs[assistantMsgs.length - 1];
    let text = '';
    if (Array.isArray(lastMsg.content)) {
        text = lastMsg.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
    } else if (typeof lastMsg.content === 'string') {
        text = lastMsg.content;
    }
    
    if (!text) return;
    
    const lines = text.split('\n');
    const todos = [];
    const todoRegex = /^\s*[-*+]?\s*\d*\.?\s*\[\s*([ xX\/]?)\s*\]\s*(.+)$/;
    
    for (const line of lines) {
        const match = line.match(todoRegex);
        if (match) {
            const check = match[1].toLowerCase();
            const content = match[2].trim();
            let status = 'pending';
            if (check === 'x') {
                status = 'completed';
            } else if (check === '/') {
                status = 'in_progress';
            }
            todos.push({
                id: `todo_${todos.length + 1}`,
                content,
                status
            });
        }
    }
    
    if (todos.length > 0) {
        session.todos = todos;
        saveSessions();
    }
}

function summarizeGoal(goal) {
    if (!goal) return null;
    return {
        id: goal.id,
        condition: goal.condition,
        status: goal.status,
        startedAt: goal.startedAt,
        updatedAt: goal.updatedAt,
        achievedAt: goal.achievedAt || null,
        clearedAt: goal.clearedAt || null,
        turns: Number(goal.turns || 0),
        lastReason: goal.lastReason || null,
        lastMet: goal.lastMet === true
    };
}

function setWorkbenchGoal(session, condition) {
    const clean = String(condition || '').trim();
    if (!clean) throw new Error('Goal condition is required.');
    if (clean.length > 4000) throw new Error('Goal condition must be 4000 characters or less.');
    const now = new Date().toISOString();
    session.goal = {
        id: newId('goal'),
        condition: clean,
        status: 'active',
        startedAt: now,
        updatedAt: now,
        turns: 0,
        lastReason: 'Goal started. Waiting for the first turn to finish before evaluation.',
        lastMet: false
    };
    session.updatedAt = now;
    saveSessions();
    return summarizeGoal(session.goal);
}

function clearWorkbenchGoal(session, reason = 'cleared') {
    if (!session.goal) return summarizeGoal(session.lastGoal);
    const now = new Date().toISOString();
    session.goal.status = 'cleared';
    session.goal.clearedAt = now;
    session.goal.updatedAt = now;
    session.goal.lastReason = reason || 'cleared';
    session.lastGoal = session.goal;
    session.goal = null;
    session.updatedAt = now;
    saveSessions();
    return summarizeGoal(session.lastGoal);
}

function mapHostPath(inputPath) {
    const raw = String(inputPath || '').trim();
    if (!raw) return getWorkspaceRoot();
    const normalizedRaw = normalizeForCompare(raw);
    for (const hostRoot of getHostProjectRoots()) {
        const normalizedHost = normalizeForCompare(hostRoot);
        if (normalizedRaw === normalizedHost || normalizedRaw.startsWith(`${normalizedHost}/`)) {
            const suffix = raw.replace(/\\/g, '/')
                .slice(String(hostRoot).replace(/\\/g, '/').replace(/\/+$/, '').length)
                .replace(/^\/+/, '');
            return path.join(getContainerProjectRoot(), suffix);
        }
    }
    return raw;
}

function resolveAnyPath(inputPath, workspacePath = null) {
    if (!inputPath || typeof inputPath !== 'string') return workspacePath || getWorkspaceRoot();
    const mapped = mapHostPath(inputPath);
    const resolved = path.isAbsolute(mapped)
        ? path.resolve(mapped)
        : path.resolve(workspacePath || getProjectRoot(), mapped);
    return resolved;
}

function toDisplayPath(filePath, workspacePath = null) {
    return path.relative(workspacePath || getWorkspaceRoot(), filePath).replace(/\\/g, '/') || '.';
}

const PROXY_ROOT = path.resolve(__dirname, '..', '..', '..');

function isProxyPath(filePath) {
    if (!filePath) return false;
    const resolved = path.resolve(String(filePath));
    const normalizedRoot = path.resolve(getProxyRoot()).toLowerCase().replace(/\\/g, '/');
    const normalizedPath = resolved.toLowerCase().replace(/\\/g, '/');
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + '/');
}

function toolNameLooksMutating(toolName) {
    return /write|edit|create|move|rename|delete|remove|install|import|save|set|update|add|forget|remember|bash|command|run|spawn|launch|click|type|focus|clipboard_set/i.test(String(toolName || ''));
}

function isProxyMutation(toolName, args) {
    if (!toolNameLooksMutating(toolName)) return false;
    const pathArgs = ['path', 'file_path', 'source', 'destination'];
    for (const arg of pathArgs) {
        if (args[arg] && isProxyPath(args[arg])) return true;
    }
    if (toolName === 'august__bash' || toolName === 'august__run_command') {
        const cmd = String(args.command || '').toLowerCase();
        const normalizedRoot = getProxyRoot().toLowerCase().replace(/\\/g, '/');
        if (cmd.includes(normalizedRoot)) return true;
    }
    if (toolName.startsWith('mcp__filesystem__')) {
        const mutOps = ['write_file', 'edit', 'create', 'move', 'delete', 'rename'];
        if (mutOps.some(op => toolName.includes(op))) {
            return isProxyPath(args.path) || isProxyPath(args.source) || isProxyPath(args.destination);
        }
    }
    return false;
}

const MUTATING_WORKBENCH_TOOLS = new Set([
    'august__write_file',
    'august__replace_text',
    'august__run_command',
    'august__write_file',
    'august__bash',
    'august__spawn_background_task',
    'august__remember',
    'august__forget',
    'august__learn_subagent',
    'august__set_learned_guideline_status',
    'august__graph_observe',
    'august__graph_link',
    'august__graph_index_memory',
    'august__import_skill',
    'august__import_skill',
    'computer_mouse_click',
    'computer_mouse_double_click',
    'computer_mouse_right_click',
    'computer_type',
    'computer_key',
    'computer_focus_window',
    'computer_launch',
    'computer_open_browser',
    'computer_close_browser',
    'computer_clipboard_set'
]);

const SAFE_COMPUTER_TOOLS = new Set([
    'computer_screenshot',
    'computer_mouse_move',
    'computer_mouse_position',
    'computer_screen_size',
    'computer_list_windows',
    'computer_clipboard_get'
]);

function isMutatingWorkbenchTool(toolName, args) {
    const normalized = (typeof toolName === 'string' && toolName.startsWith('workbench_'))
        ? toolName.replace('workbench_', 'august__')
        : toolName;
    if (MUTATING_WORKBENCH_TOOLS.has(normalized)) return true;
    if (normalized?.startsWith('computer_')) return !SAFE_COMPUTER_TOOLS.has(normalized);
    if (isProxyMutation(normalized, args || {})) return true;
    if (normalized?.startsWith('mcp__filesystem__')) {
        return /write|edit|create|move|rename|delete|remove/i.test(normalized);
    }
    if (normalized?.startsWith('mcp__')) {
        return /write|edit|create|move|rename|delete|remove|install|import|save|set|update|add|forget|remember/i.test(normalized);
    }
    return false;
}

function openAiToAnthropicTool(openAiTool) {
    return {
        name: openAiTool.function.name,
        description: openAiTool.function.description || '',
        input_schema: openAiTool.function.parameters || { type: 'object', properties: {} }
    };
}

function getAllTools() {
    const coreWorkbenchTools = [
        {
            name: 'august__list_directory',
            description: 'List files and folders anywhere on the filesystem.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Any file system path. Defaults to proxy root.' }
                }
            }
        },
        {
            name: 'august__search_files',
            description: 'Search text files for a query anywhere on the filesystem.',
            input_schema: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    path: { type: 'string', description: 'Folder path to search. Defaults to proxy root.' },
                    limit: { type: 'number' }
                },
                required: ['query']
            }
        },
        {
            name: 'august__diagnose_proxy',
            description: 'Run a non-mutating self-diagnostic for the proxy, August Brain, vector DB, semantic memory, Supermemory configuration, providers, MCP, and recent activity.',
            input_schema: {
                type: 'object',
                properties: {
                    include_activity: { type: 'boolean', description: 'Include recent request/activity summaries. Defaults to true.' }
                }
            }
        },
        {
            name: 'august__describe_environment',
            description: 'Describe the Workbench runtime roots, host-to-container path mappings, provider mode, approval state, and recent mutation audit without changing anything.',
            input_schema: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'august__list_proxy_capabilities',
            description: 'List every tool and capability currently exposed to AI Workbench, grouped by source.',
            input_schema: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'august__list_agent_registry',
            description: 'List the Workbench agent registry, default roles, and parent-to-child inherited permissions.',
            input_schema: {
                type: 'object',
                properties: {
                    parent_agent_id: { type: 'string', description: 'Parent agent whose permissions should be used for inheritance. Defaults to the current session agent.' }
                }
            }
        },
        {
            name: 'august__get_activity',
            description: 'Read recent proxy activity, pending requests, and request stats without mutating anything.',
            input_schema: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Number of recent request log entries to return. Defaults to 10.' }
                }
            }
        },
        {
            name: 'august__submit_plan',
            description: 'Submit an implementation plan for user review. Required BEFORE any mutation anywhere on the system.',
            input_schema: {
                type: 'object',
                properties: {
                    summary: { type: 'string' },
                    steps: { type: 'array', items: { type: 'string' } },
                    files: { type: 'array', items: { type: 'string' } },
                    risks: { type: 'array', items: { type: 'string' } },
                    verification: { type: 'array', items: { type: 'string' } }
                },
                required: ['summary', 'steps']
            }
        },
        {
            name: 'august__replace_text',
            description: 'Replace exact text inside any file. Requires an approved plan first.',
            input_schema: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    find: { type: 'string' },
                    replace: { type: 'string' }
                },
                required: ['path', 'find', 'replace']
            }
        },
        {
            name: 'august__run_command',
            description: 'Run a PowerShell command in the workspace root. Requires an approved plan first.',
            input_schema: {
                type: 'object',
                properties: {
                    command: { type: 'string' },
                    timeout_ms: { type: 'number' }
                },
                required: ['command']
            }
        },
        {
            name: 'august__spawn_subagent',
            description: 'Spawn a focused sub-agent to complete a specific task independently. Choose explore for read-only codebase questions, plan for architecture/planning, frontend_dev for React/Vite/Tailwind UI work, backend_dev for Node/API/tool/backend work, qa_tester for verification, documentation for docs, deployment for scoped deploy/build/release work, or project_manager for coordination. The child inherits the parent agent permissions and approval policy.',
            input_schema: {
                type: 'object',
                properties: {
                    agent_id: { type: 'string', enum: ['build', 'plan', 'explore', 'general', 'coordinator', 'project_manager', 'frontend_dev', 'backend_dev', 'qa_tester', 'documentation', 'deployment'], description: 'Agent profile. Defaults to general for delegated work. Use coordinator only for approved hierarchical decomposition.' },
                    parent_agent_id: { type: 'string', description: 'Optional parent agent override for permission inheritance. Defaults to the current session agent.' },
                    parent_job_id: { type: 'string', description: 'Optional parent durable job id when a sub-agent delegates a child job.' },
                    depth: { type: 'number', description: 'Current delegation depth. The proxy enforces the configured max depth.' },
                    scope: { type: 'string', enum: ['project', 'frontend', 'backend', 'qa', 'docs', 'deploy'], description: 'Optional work scope. Example: use deployment with scope=frontend for frontend-only deploy.' },
                    task: { type: 'string', description: 'The specific task for the sub-agent to complete. Be precise about what to do and what to report back.' }
                },
                required: ['task']
            }
        },
        {
            name: 'august__run_team',
            description: 'Run one or more team agents in parallel or sequence. Use team_roles/agent_ids to select roles, or exclude_team_roles/exclude_agent_ids to run all team agents except specific ones. Mutations still require an approved Workbench plan.',
            input_schema: {
                type: 'object',
                properties: {
                    goal: { type: 'string', description: 'Overall goal for the team run.' },
                    task: { type: 'string', description: 'Optional default task for each selected agent when task_by_agent is not provided.' },
                    task_by_agent: {
                        type: 'object',
                        description: 'Optional per-agent task overrides keyed by agent id, such as frontend_dev, backend_dev, qa_tester, documentation, deployment, or project_manager.',
                        additionalProperties: { type: 'string' }
                    },
                    team_roles: { type: 'array', items: { type: 'string', enum: ['project_manager', 'frontend_dev', 'backend_dev', 'qa_tester', 'documentation', 'deployment'] }, description: 'Optional selected team agents. Defaults to all team agents when omitted.' },
                    agent_ids: { type: 'array', items: { type: 'string' }, description: 'Alias for team_roles.' },
                    exclude_team_roles: { type: 'array', items: { type: 'string', enum: ['project_manager', 'frontend_dev', 'backend_dev', 'qa_tester', 'documentation', 'deployment'] }, description: 'Team agents to skip.' },
                    exclude_agent_ids: { type: 'array', items: { type: 'string' }, description: 'Alias for exclude_team_roles.' },
                    parent_agent_id: { type: 'string', description: 'Optional parent agent override for permission inheritance. Defaults to the current session agent.' },
                    parent_job_id: { type: 'string', description: 'Optional parent durable job id when a team run delegates child jobs.' },
                    depth: { type: 'number', description: 'Current delegation depth. The proxy enforces the configured max depth.' },
                    scope: { type: 'string', enum: ['project', 'frontend', 'backend', 'qa', 'docs', 'deploy'], description: 'Optional work scope passed to selected agents when they do not have a narrower scope.' },
                    parallel: { type: 'boolean', description: 'Run selected team agents in parallel. Defaults to true.' }
                },
                required: ['goal']
            }
        },
        {
            name: 'august__list_agent_jobs',
            description: 'List durable sub-agent jobs spawned by AI Workbench, including running, completed, and failed jobs.',
            input_schema: {
                type: 'object',
                properties: {
                    status: { type: 'string', enum: ['running', 'completed', 'failed', 'all'], description: 'Optional status filter.' },
                    session_id: { type: 'string', description: 'Optional Workbench session id filter.' },
                    limit: { type: 'number', description: 'Maximum jobs to return. Defaults to 50.' }
                }
            }
        },
        {
            name: 'august__get_agent_job',
            description: 'Read one durable sub-agent job with its event/tool/message trace.',
            input_schema: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Agent job id.' }
                },
                required: ['id']
            }
        },
        {
            name: 'august__generate_session_title',
            description: 'Generate an AI title for the current workbench session based on its first user message. Use when the session title is empty or a more meaningful title is needed.',
            input_schema: {
                type: 'object',
                properties: {},
                required: []
            }
        },
        {
            name: 'august__update_todos',
            description: 'Explicitly update the session todo/task list. Use this to update progress when the task list changes.',
            input_schema: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                content: { type: 'string', description: 'Task description' },
                                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] }
                            },
                            required: ['content', 'status']
                        }
                    }
                },
                required: ['todos']
            }
        }
    ];

    const mcpTools = (getMcpToolDefinitions() || []).map(openAiToAnthropicTool);
    const augustTools = (getAugustToolDefinitions() || []).map(openAiToAnthropicTool);
    const coworkTools = (getCoworkToolDefinitions() || []).map(openAiToAnthropicTool);
    const webTools = (getManagedWebToolDefinitions() || []).map(openAiToAnthropicTool);

    const all = [
        ...coreWorkbenchTools,
        ...augustTools,
        ...mcpTools,
        ...coworkTools,
        ...webTools,
        ...hostAgent.toolDefinitions()
    ];

    const seen = new Set();
    return all.filter(tool => {
        if (seen.has(tool.name)) return false;
        seen.add(tool.name);
        return true;
    });
}

function toolDefinitions(session) {
    const allTools = getAllTools();
    return allTools;
}

function openAiToolDefinitions(session) {
    return toolDefinitions(session).map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema
        }
    }));
}

function requireApproval(session, toolName, args) {
    if (!isMutatingWorkbenchTool(toolName, args || {})) return null;
    if (session.plan && session.approved) return null;
    return {
        blocked: true,
        message: 'WORKBENCH APPROVAL GATE - This operation can update files, run commands, change memory, control the host desktop, or otherwise change system state. Create a plan with august__submit_plan and wait for the user to approve it in the Workbench UI or August terminal /approve, then retry.',
        detail: `Tool: ${toolName} | Arguments: ${JSON.stringify(args)}`
    };
}

function requireAgentPermission(session, toolName, args, toolContext = {}) {
    const agentId = resolveAgentId(toolContext.agentId || session?.agentId || 'build', 'build');
    const inheritedPermissions = toolContext.inheritedPermissions || session?.inheritedPermissions || null;
    const decision = evaluateAgentTool(agentId, toolName, inheritedPermissions);
    if (decision.action !== 'deny') return null;
    return {
        blocked: true,
        message: 'AGENT PERMISSION GUARD - This agent profile is not allowed to use that category of tool. Use a different agent, spawn an allowed child, or ask the build agent to submit an approved plan for the mutation.',
        detail: [
            `Agent: ${agentId}`,
            toolContext.parentAgentId ? `Parent: ${toolContext.parentAgentId}` : null,
            `Tool: ${toolName}`,
            `Category: ${decision.category}`,
            `Arguments: ${JSON.stringify(args)}`
        ].filter(Boolean).join(' | ')
    };
}

function getSessionBrainPolicy(session) {
    let providerName = session?.provider === 'codex' ? 'codex' : 'claude';
    let profile = {};
    try {
        profile = getWorkbenchProfile(session);
        providerName = profile.providerName || providerName;
    } catch {
        profile = getProfile(providerName) || {};
    }
    const model = profile._upstreamModel || profile.currentModel || '';
    const planned = planBrainTurn({
        messages: session?.messages || [],
        provider: providerName,
        model,
        session,
        requestKind: 'workbench'
    });
    session.brainPolicy = planned;
    return planned;
}

function isParallelSafeWorkbenchToolUse(toolUse) {
    const name = toolUse?.name || '';
    const args = toolUse?.input || {};
    if (!name) return false;
    if (isMutatingWorkbenchTool(name, args)) return false;
    if (/submit_plan|update_todos|generate_session_title|spawn_subagent|computer_|remember|forget|learn|set_|approve|reject|archive/i.test(name)) {
        return false;
    }
    return true;
}

function listDirectory(args) {
    const dir = resolveAnyPath(args.path || '.');
    const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 100).map(entry => {
        const fullPath = path.join(dir, entry.name);
        const stat = fs.statSync(fullPath);
        return {
            name: entry.name,
            path: toDisplayPath(fullPath),
            type: entry.isDirectory() ? 'directory' : (entry.isFile() ? 'file' : 'other'),
            sizeBytes: stat.size
        };
    });
    return { root: toDisplayPath(dir), entries };
}

function readFile(args) {
    const filePath = resolveAnyPath(args.path);
    const maxChars = Math.max(1000, Math.min(80000, Number(args.max_chars || 20000)));
    const text = fs.readFileSync(filePath, 'utf8');
    return {
        path: toDisplayPath(filePath),
        length: text.length,
        truncated: text.length > maxChars,
        content: text.slice(0, maxChars)
    };
}

function walkFiles(root, limit = 800) {
    const results = [];
    const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.next']);
    function walk(dir) {
        if (results.length >= limit) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (skip.has(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(fullPath);
            else if (entry.isFile()) results.push(fullPath);
            if (results.length >= limit) return;
        }
    }
    walk(root);
    return results;
}

function searchFiles(args) {
    const root = resolveAnyPath(args.path || '.');
    const query = String(args.query || '');
    const limit = Math.max(1, Math.min(100, Number(args.limit || 50)));
    const matches = [];
    for (const filePath of walkFiles(root)) {
        let text = '';
        try { text = fs.readFileSync(filePath, 'utf8'); } catch (e) { continue; }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                matches.push({ path: toDisplayPath(filePath), line: i + 1, text: lines[i].slice(0, 300) });
                if (matches.length >= limit) return { query, matches };
            }
        }
    }
    return { query, matches };
}

function submitPlan(session, args) {
    session.plan = {
        id: newId('plan'),
        summary: String(args.summary || '').trim(),
        steps: Array.isArray(args.steps) ? args.steps.map(String).filter(Boolean) : [],
        files: Array.isArray(args.files) ? args.files.map(String).filter(Boolean) : [],
        risks: Array.isArray(args.risks) ? args.risks.map(String).filter(Boolean) : [],
        verification: Array.isArray(args.verification) ? args.verification.map(String).filter(Boolean) : [],
        createdAt: new Date().toISOString()
    };
    session.approved = false;
    session.approvedAt = null;
    return {
        status: 'plan_submitted_waiting_for_user_approval',
        plan: session.plan,
        hardRule: 'Do not write files or run commands until the user approves this plan in the Workbench UI or August terminal /approve.'
    };
    saveSessions();
    return result;
}

function writeFile(args) {
    const filePath = resolveAnyPath(args.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(args.content || ''), 'utf8');
    return { status: 'written', path: toDisplayPath(filePath), bytes: Buffer.byteLength(String(args.content || ''), 'utf8') };
}

function replaceText(args) {
    const filePath = resolveAnyPath(args.path);
    const text = fs.readFileSync(filePath, 'utf8');
    const find = String(args.find || '');
    if (!find) throw new Error('find text is required.');
    if (!text.includes(find)) throw new Error(`Text to replace was not found in ${toDisplayPath(filePath)}.`);
    const next = text.replace(find, String(args.replace || ''));
    fs.writeFileSync(filePath, next, 'utf8');
    return { status: 'replaced', path: toDisplayPath(filePath), replacements: 1 };
}

function runCommand(args) {
    return new Promise(resolve => {
        const timeout = Math.max(1000, Math.min(120000, Number(args.timeout_ms || 30000)));
        execFile(process.platform === 'win32' ? 'powershell.exe' : 'sh', process.platform === 'win32'
            ? ['-NoProfile', '-Command', String(args.command || '')]
            : ['-lc', String(args.command || '')], {
            cwd: WORKSPACE_ROOT,
            timeout,
            maxBuffer: 1024 * 1024
        }, (error, stdout, stderr) => {
            resolve({
                status: error ? 'error' : 'ok',
                exitCode: error?.code ?? 0,
                stdout: String(stdout || '').slice(-20000),
                stderr: String(stderr || '').slice(-20000)
            });
        });
    });
}

function groupToolName(name) {
    if (name.startsWith('workbench_')) return 'workbench';
    if (name.startsWith('august__')) return 'august';
    if (name.startsWith('mcp__workspace__web_') || name === 'WebSearch' || name === 'WebFetch' || name.startsWith('web_')) return 'web';
    if (name.startsWith('mcp__cowork__')) return 'cowork';
    if (name.startsWith('mcp__')) return 'mcp';
    if (name.startsWith('computer_')) return 'computer';
    return 'other';
}

function listProxyCapabilities() {
    const tools = getAllTools();
    const groups = {};
    for (const tool of tools) {
        const name = tool.name;
        const group = groupToolName(name);
        if (!groups[group]) groups[group] = [];
        groups[group].push({
            name: name,
            mutating: isMutatingWorkbenchTool(name, {}),
            description: tool.description || ''
        });

        // Expose workbench_ aliases in capabilities for backwards compatibility
        if (name.startsWith('august__')) {
            const baseName = name.slice(8);
            const isCoreWorkbench = [
                'list_directory', 'search_files', 'diagnose_proxy', 'describe_environment',
                'list_proxy_capabilities', 'list_agent_registry', 'get_activity', 'submit_plan',
                'replace_text', 'run_command', 'spawn_subagent', 'read_file', 'write_file',
                'find_skill_sources', 'preview_skill_import', 'import_skill'
            ].includes(baseName);
            
            if (isCoreWorkbench) {
                const wbName = 'workbench_' + baseName;
                if (!groups['workbench']) groups['workbench'] = [];
                groups['workbench'].push({
                    name: wbName,
                    mutating: isMutatingWorkbenchTool(wbName, {}),
                    description: tool.description || ''
                });
            }
        }
    }
    return {
        generatedAt: new Date().toISOString(),
        totalTools: tools.length,
        groups,
        agents: listAgentRegistry('build'),
        approvalGate: {
            readSearchInspectAllowed: true,
            mutationsRequireApprovedPlan: true
        }
    };
}

function listAgentRegistry(parentAgentId = 'build') {
    const activeAgentId = resolveAgentId(parentAgentId, 'build');
    const agents = getAgents().map(agent => {
        const effectivePermissions = agent.id === activeAgentId
            ? agent.permissions
            : deriveChildAgentPermissions(activeAgentId, agent.id);
        return {
            id: agent.id,
            role: agent.role,
            mode: agent.mode,
            goal: agent.goal,
            scopes: agent.scopes || ['project'],
            team: TEAM_AGENT_IDS.has(agent.id),
            teamSkills: getTeamSkills(agent.id).map(skill => ({
                name: skill.name,
                description: skill.description,
                trigger: skill.trigger,
                ownerAgentId: skill.ownerAgentId,
                scope: skill.scope
            })),
            memoryEnabled: agent.memory_enabled !== false,
            canCrossLoadTeamSkills: agent.can_cross_load_team_skills === true,
            allowDelegation: agent.allow_delegation === true,
            tools: agent.tools || [],
            permissions: agent.permissions || {},
            inheritedFrom: agent.id === activeAgentId ? null : activeAgentId,
            effectivePermissions
        };
    });
    return {
        generatedAt: new Date().toISOString(),
        activeAgentId,
        agents,
        inheritance: {
            rule: 'Child agent permissions are the most restrictive merge of parent and child. deny beats ask; ask beats allow.',
            parentAgentId: activeAgentId
        }
    };
}

function getWorkbenchActivity(args = {}) {
    const limit = Math.max(1, Math.min(50, Number(args.limit || 10)));
    return {
        generatedAt: new Date().toISOString(),
        activity: getActivityLog().slice(0, limit),
        pending: getPendingRequests(),
        stats: getStats('all'),
        recentRequests: getRequestLog().slice(0, limit)
    };
}

function describeWorkbenchEnvironment(session) {
    return {
        generatedAt: new Date().toISOString(),
        provider: session?.provider || 'claude',
        roots: {
            projectRoot: getProjectRoot(),
            workspaceRoot: getWorkspaceRoot(),
            containerProjectRoot: getContainerProjectRoot(),
            hostProjectRoots: getHostProjectRoots(),
            proxyRoot: getProxyRoot()
        },
        pathMapping: {
            envVars: [
                'AUGUST_PROXY_HOST_ROOTS',
                'AUGUST_PROXY_HOST_ROOT',
                'AUGUST_HOST_ROOT',
                'AUGUST_PROXY_CONTAINER_ROOT',
                'AUGUST_PROXY_WORKDIR',
                'AUGUST_PROXY_ALLOWED_ROOTS',
                'AUGUST_PROXY_DESKTOP_ROOTS'
            ],
            hostRootsMapTo: getContainerProjectRoot(),
            note: 'Host project paths are mapped to the configured container/project root before file tools run. Desktop apps should set AUGUST_PROXY_WORKDIR and AUGUST_PROXY_ALLOWED_ROOTS to the user-approved folders.'
        },
        approvalGate: {
            approved: session?.approved === true,
            approvedAt: session?.approvedAt || null,
            activePlanId: session?.plan?.id || null,
            mutationsRequireApprovedPlan: true
        },
        agent: {
            id: session?.agentId || 'build',
            role: getAgent(session?.agentId || 'build').role,
            parentAgentId: session?.parentAgentId || null,
            inheritedPermissions: session?.inheritedPermissions || null
        },
        mutationAudit: Array.isArray(session?.mutationLog)
            ? session.mutationLog.slice(-10)
            : []
    };
}

function diagnoseProxy(args = {}) {
    const includeActivity = args.include_activity !== false;
    const capabilityHealth = getCapabilityHealth();
    const brain = getBrainDiagnostics();
    const capabilityInventory = listProxyCapabilities();
    const activity = includeActivity ? getWorkbenchActivity({ limit: 8 }) : null;
    const recommendedActions = [
        ...capabilityHealth.checks,
        ...brain.checks
    ]
        .filter(check => check.status !== 'ok' && check.action)
        .map(check => ({
            id: check.id,
            area: check.area,
            status: check.status,
            action: check.action,
            detail: check.detail
        }));

    return {
        generatedAt: new Date().toISOString(),
        status: capabilityHealth.summary.overall === 'error' || brain.summary.overall === 'error'
            ? 'error'
            : (capabilityHealth.summary.overall === 'warn' || brain.summary.overall === 'warn' ? 'warn' : 'ok'),
        health: capabilityHealth,
        brain,
        capabilities: capabilityInventory,
        activity,
        recommendedActions
    };
}

async function executeSubAgent(session, args, toolContext = {}) {
    const task = String(args.task || '').trim();
    if (!task) return { status: 'error', message: 'No task provided for sub-agent.' };
    const parentAgentId = resolveAgentId(args.parent_agent_id || session?.agentId || 'build', 'build');
    const requestedAgentId = String(args.agent_id || args.agent || args.subagent_type || 'general').trim();
    const childAgentId = getAgents().some(agent => agent.id === requestedAgentId)
        ? requestedAgentId
        : 'general';
    const childAgent = getAgent(childAgentId);
    const inheritedPermissions = deriveChildAgentPermissions(parentAgentId, childAgentId);
    const profile = getWorkbenchProfile(session);
    const useOpenAi = profile.useOpenAiFormat;
    const targetUrl = profile.targetUrl;
    const model = profile._upstreamModel || profile.currentModel || 'claude-opus-4-6';
    if (!targetUrl) return { status: 'error', message: 'Provider target URL missing.' };

    const brainConfig = getBrainConfig();
    const maxDepth = Math.max(1, Math.min(5, Number(brainConfig.maxAgentDepth || 2)));
    const depth = Math.max(0, Number(args.depth ?? toolContext.depth ?? 0) || 0);
    if (depth >= maxDepth) {
        return {
            status: 'blocked',
            message: `Sub-agent depth ${depth} reached maxAgentDepth ${maxDepth}. Report back to the parent agent instead of spawning another child.`
        };
    }

    const scope = String(args.scope || childAgent.scopes?.[0] || 'project').trim();
    const scopeNote = childAgent.scopes && childAgent.scopes.length ? ` This agent's registered scopes are: ${childAgent.scopes.join(', ')}.` : '';
    const teamSkillGuide = renderTeamSkillsForSystem(childAgentId);

    const job = createAgentJob({
        sessionId: session?.id || null,
        parentJobId: args.parent_job_id || toolContext.parentJobId || null,
        depth,
        agentId: childAgentId,
        parentAgentId,
        provider: session?.provider,
        model,
        scope,
        task,
        status: 'running'
    });
    appendAgentJobMessage(job.id, 'user', task, { depth, parentAgentId, childAgentId });

    const subPrompt = [
        'You are a focused sub-agent spawned by the main AI Workbench agent.',
        `Sub-agent profile: ${childAgent.id} (${childAgent.role}). Goal: ${childAgent.goal}`,
        `Work scope: ${scope}.${scopeNote}`,
        `Parent agent profile: ${parentAgentId}. Your effective inherited permissions are: ${Object.entries(inheritedPermissions).map(([key, value]) => `${key}:${value}`).join(', ')}.`,
        `Durable job id: ${job.id}. Current delegation depth: ${depth}. Max delegation depth: ${maxDepth}.`,
        'Your task is: ' + task,
        'You have access to the same registered tools, but the server enforces your inherited permissions before the approval gate.',
        'Read/search/explore freely when your profile permits it, but do not perform any mutation unless the parent session already has an approved plan and your inherited permissions allow that tool category.',
        'A mutation means writing/editing/deleting/moving files, running shell commands, changing memory, launching background tasks, or controlling the host desktop.',
        'If a mutation is required and approval is not active, stop and report the exact plan the parent should submit for user approval.',
        'If you are a coordinator and delegation is allowed, spawn child sub-agents only for clearly separate subtasks and include parent_job_id plus depth+1.',
        teamSkillGuide ? `=== TEAM SKILLS OWNED BY THIS AGENT ===\n${teamSkillGuide}\nTo load one of these skills, call august__load_skill with the skill name and agent_id=${childAgentId}.` : '',
        'For exploration tasks, report concrete evidence: exact files read, commands/tools used, key findings, and any limits or uncertainty.',
        'Do not claim comprehensive understanding unless the evidence supports it. Todo or task-list updates are internal state, not project file updates.',
        'Keep your response concise and actionable.'
    ].join('\n');

    const subMessages = [{ role: 'user', content: task }];
    let subResult = '';
    let subLoops = 0;
    while (subLoops < 4) {
        subLoops++;
        try {
            const headers = useOpenAi
                ? { 'Content-Type': 'application/json', ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}) }
                : buildHeaders(profile.apiKey);
            const body = useOpenAi
                ? { model, messages: [{ role: 'system', content: subPrompt }, ...subMessages], tools: openAiToolDefinitions(session), tool_choice: 'auto', stream: false }
                : { model, max_tokens: 1024, system: subPrompt, messages: subMessages, tools: toolDefinitions(session) };

            const res = await fetch(targetUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
            const raw = await res.text();
            if (!res.ok) {
                const message = `Sub-agent upstream error: ${raw.slice(0, 300)}`;
                failAgentJob(job.id, message, { loops: subLoops });
                return { status: 'error', jobId: job.id, message };
            }
            const data = JSON.parse(raw);
            const content = useOpenAi
                ? openAiMessageToAnthropicContent(data.choices?.[0]?.message || {})
                : (Array.isArray(data.content) ? data.content : []);

            // When the next iteration will go back to an OpenAI-format provider,
            // re-encode the assistant turn (and tool results below) into the
            // OpenAI shape; otherwise subMessages would carry Anthropic-shaped
            // content blocks (tool_use / tool_result) into a request the
            // OpenAI provider cannot parse, triggering the same
            // "content or tool_calls must be set" 400.
            if (useOpenAi) {
                toOpenAiMessage({ role: 'assistant', content }).forEach(m => subMessages.push(m));
            } else {
                subMessages.push({ role: 'assistant', content });
            }
            const text = extractAssistantText(content);
            if (text) {
                subResult = text;
                appendAgentJobMessage(job.id, 'assistant', text, { loop: subLoops });
            }

            const toolUses = content.filter(b => b.type === 'tool_use');
            if (!toolUses.length) break;
            appendAgentJobToolResult(job.id, 'tool_uses_requested', toolUses.map(tu => ({
                id: tu.id,
                name: tu.name,
                input: tu.input
            })), { loop: subLoops });

            const results = await executeWorkbenchToolBatch(session, toolUses, {
                agentId: childAgentId,
                parentAgentId,
                inheritedPermissions,
                parentJobId: job.id,
                depth: depth + 1
            });
            appendAgentJobToolResult(job.id, 'tool_results', results, { loop: subLoops });
            if (useOpenAi) {
                toOpenAiMessage({ role: 'user', content: results }).forEach(m => subMessages.push(m));
            } else {
                subMessages.push({ role: 'user', content: results });
            }
        } catch (e) {
            failAgentJob(job.id, e, { loops: subLoops });
            return { status: 'error', jobId: job.id, message: `Sub-agent error: ${e.message}` };
        }
    }
    completeAgentJob(job.id, subResult || '(no text output)', { loops: subLoops });
    return {
        status: 'ok',
        jobId: job.id,
        task,
        agentId: childAgentId,
        parentAgentId,
        scope,
        depth,
        inheritedPermissions,
        result: subResult || '(no text output)'
    };
}

function normalizeTeamRunAgents(args = {}) {
    const includeInput = Array.isArray(args.team_roles) && args.team_roles.length
        ? args.team_roles
        : Array.isArray(args.agent_ids) && args.agent_ids.length
            ? args.agent_ids
            : null;
    const excludeInput = [
        ...(Array.isArray(args.exclude_team_roles) ? args.exclude_team_roles : []),
        ...(Array.isArray(args.exclude_agent_ids) ? args.exclude_agent_ids : [])
    ];
    const excluded = new Set(excludeInput.map(String).filter(Boolean));
    const allTeamAgents = Array.from(TEAM_AGENT_IDS).sort();
    const selected = includeInput
        ? includeInput.map(String).filter(id => TEAM_AGENT_IDS.has(id) && !excluded.has(id))
        : allTeamAgents.filter(id => !excluded.has(id));
    return {
        allTeamAgents,
        excludedAgents: Array.from(excluded).filter(id => allTeamAgents.includes(id)),
        selectedAgents: selected.map(id => ({ id, agent: getAgent(id) }))
    };
}

async function executeTeamRun(session, args, toolContext = {}) {
    const goal = String(args.goal || '').trim();
    if (!goal) return { status: 'error', message: 'No goal provided for team run.' };
    const { allTeamAgents, excludedAgents, selectedAgents } = normalizeTeamRunAgents(args);
    if (!selectedAgents.length) {
        return {
            status: 'blocked',
            message: 'No team agents selected. Use team_roles/agent_ids to include agents, or remove the agents from exclude_team_roles/exclude_agent_ids.',
            allTeamAgents,
            excludedAgents
        };
    }

    const parentAgentId = resolveAgentId(args.parent_agent_id || session?.agentId || 'build', 'build');
    const taskByAgent = args.task_by_agent && typeof args.task_by_agent === 'object' ? args.task_by_agent : {};
    const defaultTask = String(args.task || '').trim() || goal;
    const makeTask = agent => {
        const custom = taskByAgent[agent.id] || taskByAgent[agent.role] || taskByAgent[agent.id.toLowerCase()];
        return custom
            ? `${goal}\n\nYour focused assignment: ${custom}`
            : `${goal}\n\nYour focused assignment as ${agent.role}: apply your role goal, report concrete findings, and stop before any mutation that is not covered by an approved Workbench plan.`;
    };

    const runAgent = async ({ id, agent }) => executeSubAgent(session, {
        agent_id: id,
        parent_agent_id: parentAgentId,
        parent_job_id: args.parent_job_id,
        depth: args.depth ?? toolContext.depth ?? 0,
        scope: args.scope || agent.scopes?.[0],
        task: makeTask(agent)
    }, toolContext);

    const startedAt = new Date().toISOString();
    const results = args.parallel === false
        ? []
        : await Promise.all(selectedAgents.map(async ({ id, agent }) => ({ id, role: agent.role, result: await runAgent({ id, agent }) })));

    if (args.parallel === false) {
        for (const { id, agent } of selectedAgents) {
            results.push({ id, role: agent.role, result: await runAgent({ id, agent }) });
        }
    }

    return {
        status: 'ok',
        goal,
        startedAt,
        completedAt: new Date().toISOString(),
        parallel: args.parallel !== false,
        allTeamAgents,
        excludedAgents,
        selectedAgents: selectedAgents.map(({ id, agent }) => ({ id, role: agent.role, scope: agent.scopes?.[0] || 'project' })),
        results
    };
}

function summarizeMutationArgs(toolName, args = {}) {
    const summary = {};
    const pathFields = ['path', 'file_path', 'source', 'destination'];
    for (const field of pathFields) {
        if (args[field]) summary[field] = toDisplayPath(resolveAnyPath(args[field]));
    }
    if (args.command) summary.command = String(args.command).slice(0, 500);
    if (args.content !== undefined) summary.contentBytes = Buffer.byteLength(String(args.content), 'utf8');
    if (args.find !== undefined) summary.findBytes = Buffer.byteLength(String(args.find), 'utf8');
    if (args.replace !== undefined) summary.replaceBytes = Buffer.byteLength(String(args.replace), 'utf8');
    if (args.url) summary.url = String(args.url).slice(0, 500);
    if (args.enable_mcp !== undefined) summary.enableMcp = args.enable_mcp === true;
    if (toolName?.startsWith('computer_')) summary.computerAction = toolName;
    return summary;
}

function recordMutation(session, toolName, args, result) {
    if (!session) return;
    const at = new Date().toISOString();
    if (!Array.isArray(session.mutationLog)) session.mutationLog = [];
    session.mutationLog.push({
        at,
        toolName,
        planId: session.plan?.id || null,
        args: summarizeMutationArgs(toolName, args),
        status: result?.status || (result?.blocked ? 'blocked' : 'ok'),
        error: result?.error || null
    });
    if (session.mutationLog.length > 100) {
        session.mutationLog = session.mutationLog.slice(-100);
    }
    session.updatedAt = at;
}

async function executeWorkbenchTool(session, toolUse, toolContext = {}) {
    const name = toolUse.name;
    const args = toolUse.input || {};
    const mutating = isMutatingWorkbenchTool(name, args);
    const agentBlocked = requireAgentPermission(session, name, args, toolContext);
    if (agentBlocked) return agentBlocked;
    const blocked = requireApproval(session, name, args);
    if (blocked) return blocked;

    let result;
    try {
        if (name === 'august__list_directory' || name === 'workbench_list_directory') result = listDirectory(args);
        else if (name === 'august__search_files' || name === 'workbench_search_files') result = searchFiles(args);
        else if (name === 'august__diagnose_proxy' || name === 'workbench_diagnose_proxy') result = diagnoseProxy(args);
        else if (name === 'august__describe_environment' || name === 'workbench_describe_environment') result = describeWorkbenchEnvironment(session);
        else if (name === 'august__list_proxy_capabilities' || name === 'workbench_list_proxy_capabilities') result = listProxyCapabilities();
        else if (name === 'august__list_agent_registry' || name === 'workbench_list_agent_registry') result = listAgentRegistry(args.parent_agent_id || session?.agentId || 'build');
        else if (name === 'august__list_agent_jobs') result = listAgentJobs({ status: args.status || 'all', sessionId: args.session_id, scope: args.scope, limit: args.limit });
        else if (name === 'august__get_agent_job') {
            const job = getAgentJob(args.id);
            result = job || { status: 'not_found', id: args.id };
        }
        else if (name === 'august__get_activity' || name === 'workbench_get_activity') result = getWorkbenchActivity(args);
        else if (name === 'august__submit_plan' || name === 'workbench_submit_plan') result = submitPlan(session, args);
        else if (name === 'august__replace_text' || name === 'workbench_replace_text') result = replaceText(args);
        else if (name === 'august__run_command' || name === 'workbench_run_command') result = await runCommand(args);
        else if (name === 'august__spawn_subagent' || name === 'workbench_spawn_subagent') result = await executeSubAgent(session, args, toolContext);
        else if (name === 'august__run_team' || name === 'workbench_run_team') result = await executeTeamRun(session, args, toolContext);
        else if (name === 'august__generate_session_title') {
            const firstUserMsg = session.messages?.find(m => m.role === 'user');
            if (!firstUserMsg) throw new Error('No user messages to generate a title from.');
            await generateSessionTitle(session, firstUserMsg.content, null);
            result = { title: session.title || '' };
        }
        else if (name === 'august__update_todos' || name === 'workbench_update_todos') {
            session.todos = Array.isArray(args.todos) ? args.todos.map((item, index) => ({
                id: item.id || `todo_${index + 1}`,
                content: item.content,
                status: item.status || 'pending'
            })) : [];
            saveSessions();
            result = { status: 'todos_updated', count: session.todos.length };
        }
        else if (name.startsWith('computer_')) result = await hostAgent.execute(name, args);
        else if (name === 'august__load_skill' || name === 'workbench_load_skill') {
            const toolName = name.startsWith('workbench_') ? 'august__load_skill' : name;
            const currentAgent = resolveAgentId(toolContext.agentId || session?.agentId || 'build', 'build');
            const requestedOwner = String(args.agent_id || '').trim();
            if (requestedOwner && requestedOwner !== currentAgent && !canCrossLoadTeamSkills(currentAgent)) {
                result = {
                    status: 'blocked',
                    message: `Team skill owner mismatch. Agent ${currentAgent} cannot load a skill owned by ${requestedOwner}.`
                };
            } else {
                const scopedArgs = { ...args };
                if (!scopedArgs.agent_id && currentAgent !== 'build') scopedArgs.agent_id = currentAgent;
                result = await executeAugustToolCall(toolName, scopedArgs, true);
            }
        }
        else if (isMcpToolName(name)) result = await executeMcpToolCall(name, args);
        else if (isAugustToolName(name)) result = await executeAugustToolCall(name, args, true);
        else if (name.startsWith('workbench_') && isAugustToolName(name.replace('workbench_', 'august__'))) {
            result = await executeAugustToolCall(name.replace('workbench_', 'august__'), args, true);
        }
        else if (isCoworkToolName(name)) result = await executeCoworkToolCall(name, args);
        else if (isManagedWebToolName(name)) result = await executeManagedWebTool(name, args);
        else throw new Error(`Unsupported workbench tool: ${name}`);
    } catch (e) {
        recordToolFailure({
            toolName: name,
            args,
            error: e,
            phase: 'workbench',
            provider: session?.provider,
            agentId: toolContext.agentId || session?.agentId
        });
        if (mutating) recordMutation(session, name, args, { status: 'error', error: e.message });
        throw e;
    }

    if (mutating) recordMutation(session, name, args, result);
    return result;
}

function toWorkbenchToolResultBlock(toolUse, result) {
    return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result, null, 2),
        is_error: !!result.blocked
    };
}

async function executeWorkbenchToolResult(session, toolUse, toolContext = {}) {
    try {
        const result = await executeWorkbenchTool(session, toolUse, toolContext);
        return toWorkbenchToolResultBlock(toolUse, result);
    } catch (e) {
        return {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `[Workbench Tool Error] ${e.message}`,
            is_error: true
        };
    }
}

async function executeWorkbenchToolBatch(session, toolUses, toolContext = {}) {
    const brainPolicy = getSessionBrainPolicy(session);
    const allowParallelReads = brainPolicy.executionPolicy.allowParallelReads === true;
    return executeToolBatch(
        toolUses,
        toolUse => executeWorkbenchToolResult(session, toolUse, toolContext),
        {
            parallel: allowParallelReads,
            canRunInParallel: isParallelSafeWorkbenchToolUse
        }
    );
}

function buildSystemPrompt(session) {
    const planLine = session.plan && session.approved
        ? `The user approved plan ${session.plan.id}. You may now perform mutations that are covered by that approved plan.`
        : 'No approved plan is active. All mutations are blocked.';

    const toolGuide = [
        '',
        '=== AVAILABLE TOOL CATEGORIES ===',
        '- august__*: List/read/search/write files, run commands, inspect proxy health/capabilities, semantic memory, specialists, supermemory, sub-agents, skills, plans (anywhere on system)',
        '- mcp__*: All tools from connected MCP servers (filesystem, minimax, fetch, custom servers)',
        '- WebSearch / WebFetch: Public web search and page fetching',
        '- august__find_skill_sources / august__preview_skill_import / august__import_skill: Discover, inspect, and save internet/GitHub skills into the shared proxy skill catalog',
        '- mcp__cowork__*: Cowork compatibility tools (directory access, skills, plugins, import capability links)',
        '- computer_*: Host desktop control — screenshot, mouse (move/click/scroll), keyboard (type/key), window list/focus, app launch, visible browser',
        'When the user asks what is wrong with the proxy, brain, tools, memory, or runtime, call august__diagnose_proxy before guessing.',
        'When path mapping, mounted roots, provider mode, approval state, or recent mutations matter, call august__describe_environment before guessing.',
        'Keep responses concise and report what you did or found.'
    ].join('\n');

    const activeAgent = getAgent(session.agentId || 'build');
    const agentGuide = [
        '',
        '=== AGENT REGISTRY ===',
        `Current agent: ${activeAgent.id} (${activeAgent.role}). Goal: ${activeAgent.goal}`,
        'When delegating, choose an agent intentionally: project_manager for planning/coordination, frontend_dev for React/Vite/Tailwind UI work, backend_dev for Node/API/tool/backend work, qa_tester for verification, documentation for docs, deployment for scoped deploy/build/release work, explore for read-only codebase investigation, plan for architecture/planning, general for bounded side work.',
        'To run a coordinated team, use august__run_team with team_roles/agent_ids for selected agents or exclude_team_roles/exclude_agent_ids to skip agents such as deployment.',
        'For a scoped deployment, prefer deployment with scope=frontend for frontend-only deploy or scope=backend for backend-only deploy. Team agents have access to the full August toolset, but edits, shell commands, memory writes, delegation, and deployment mutations still require an approved plan.',
        'Child agents inherit the parent permission policy. The most restrictive permission wins: deny beats ask; ask beats allow.',
        renderAgentContext()
    ].join('\n');

    const teamSkillGuide = renderTeamSkillsForSystem(activeAgent.id);

    const hardRule = [
        '',
        '=== HARD RULE: PLAN APPROVAL BEFORE MUTATION ===',
        'You can freely read files, search files, inspect directories, search/fetch the web, and use non-mutating discovery tools.',
        'When the user asks you to fetch or add a skill from GitHub or the internet, search or preview first. Then submit a concrete plan and wait for approval before importing.',
        'Any mutation anywhere on the system requires an explicit approved plan via august__submit_plan and user approval in the Workbench UI.',
        'A mutation means writing/editing/deleting/moving/creating files, running shell commands, changing memory, installing/importing/updating resources, launching background tasks, or using host computer controls that click/type/focus/launch/close/set clipboard.',
        'If a mutating tool is attempted without approval, the server will cancel it and return the approval-gate reminder.',
        'The proxy system directory is: ' + getProxyRoot(),
        planLine
    ].join('\n');

    // Build shared context blocks via context-builder (same as regular API path)
    const profile = getWorkbenchProfile(session);
    const model = profile._upstreamModel || profile.currentModel;
    const targetUrl = profile.targetUrl;
    const brainPlan = getSessionBrainPolicy(session);
    const basePrompt = buildSystemPromptText(null, {
        includeMiniMaxContract: true,
        includeWindowsContext: true,
        includeOriginalSystem: false,
        model,
        targetUrl,
        clientId: 'workbench-ui',
        memoryQuery: brainPlan.memoryQuery
    });

    return [
        basePrompt,
        brainPlan.systemAdditions,
        hardRule,
        toolGuide,
        agentGuide,
        teamSkillGuide
    ].filter(Boolean).join('\n\n');
}

function extractAssistantText(content = []) {
    return content.filter(block => block.type === 'text').map(block => block.text || '').join('\n').trim();
}

function summarizeToolBlock(block) {
    if (!block) return '';
    if (block.type === 'tool_use') {
        return `[tool_use ${block.name || 'unknown'} ${JSON.stringify(block.input || {}).slice(0, 500)}]`;
    }
    if (block.type === 'tool_result') {
        return `[tool_result ${block.tool_use_id || ''} ${(block.content || '').slice(0, 900)}]`;
    }
    if (block.type === 'thinking') {
        return `[thinking omitted]`;
    }
    return String(block.text || block.content || '').trim();
}

function renderConversationTranscript(messages = [], maxChars = 24000) {
    const lines = [];
    for (const message of messages.slice(-40)) {
        let text = '';
        if (typeof message.content === 'string') {
            text = message.content;
        } else if (Array.isArray(message.content)) {
            text = message.content
                .map(summarizeToolBlock)
                .filter(Boolean)
                .join('\n');
        }
        if (!text) continue;
        lines.push(`${message.role.toUpperCase()}:\n${text}`);
    }
    const transcript = lines.join('\n\n');
    return transcript.length > maxChars
        ? transcript.slice(transcript.length - maxChars)
        : transcript;
}

function parseJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) {}
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch (_) {}
    return null;
}

function extractOpenAiText(data) {
    return String(data?.choices?.[0]?.message?.content || '').trim();
}

async function callWorkbenchTextOnlyModel(session, { system, user, maxTokens = 768 } = {}) {
    const profile = getWorkbenchProfile(session);
    const useOpenAi = profile.useOpenAiFormat;
    const model = profile._upstreamModel || profile.currentModel || 'claude-opus-4-6';
    const targetUrl = profile.targetUrl;
    if (!targetUrl) throw new Error('Provider target URL is missing.');

    if (useOpenAi) {
        const res = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {})
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: system || '' },
                    { role: 'user', content: user || '' }
                ],
                stream: false,
                max_tokens: maxTokens
            }),
            signal: AbortSignal.timeout(120000)
        });
        const raw = await res.text();
        if (!res.ok) throw new Error(`Workbench side model error ${res.status}: ${raw.slice(0, 500)}`);
        return extractOpenAiText(JSON.parse(raw));
    }

    const res = await fetch(targetUrl, {
        method: 'POST',
        headers: buildHeaders(profile.apiKey),
        body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system: system || '',
            messages: [{ role: 'user', content: user || '' }]
        }),
        signal: AbortSignal.timeout(120000)
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Workbench side model error ${res.status}: ${raw.slice(0, 500)}`);
    const data = JSON.parse(raw);
    return extractAssistantText(Array.isArray(data.content) ? data.content : []);
}

async function answerWorkbenchBtw({ sessionId, question, provider, agentId } = {}) {
    const session = getWorkbenchSession(sessionId);
    if (provider === 'claude' || provider === 'codex') session.provider = provider;
    if (agentId) session.agentId = resolveAgentId(agentId, session.agentId || 'build');
    const clean = String(question || '').trim();
    if (!clean) throw new Error('BTW question is required.');
    const transcript = renderConversationTranscript(session.messages, 26000);
    const answer = await callWorkbenchTextOnlyModel(session, {
        maxTokens: 900,
        system: [
            'You answer a /btw side question for August AI Workbench.',
            'The main agent may still be working. This side answer is ephemeral and must not use tools or mutate state.',
            'Use the provided conversation transcript and answer directly. If the answer is not in context, say what is missing.',
            'Keep the answer concise and useful.'
        ].join('\n'),
        user: [
            'Conversation transcript:',
            transcript || '(no prior Workbench conversation yet)',
            '',
            '/btw side question:',
            clean
        ].join('\n')
    });
    return {
        status: 'ok',
        question: clean,
        answer: answer || '(no response)',
        generatedAt: new Date().toISOString(),
        session: summarizeSession(session)
    };
}

async function evaluateWorkbenchGoal(session) {
    if (!session.goal || session.goal.status !== 'active') return { met: true, reason: 'No active goal.' };
    const transcript = renderConversationTranscript(session.messages, 30000);
    const response = await callWorkbenchTextOnlyModel(session, {
        maxTokens: 300,
        system: [
            'You are the /goal evaluator for August AI Workbench.',
            'Decide whether the active goal is fully met using only the transcript.',
            'Return strict JSON only: {"met": true|false, "reason": "short reason"}.',
            'A goal is met only when the user-visible requested outcome is completed or a real blocker requires user input or approval.'
        ].join('\n'),
        user: [
            'Active goal:',
            session.goal.condition,
            '',
            'Transcript:',
            transcript || '(empty)'
        ].join('\n')
    });
    const parsed = parseJsonObject(response) || {};
    return {
        met: parsed.met === true,
        reason: String(parsed.reason || response || 'Goal evaluator did not provide a reason.').slice(0, 900)
    };
}

function buildHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (apiKey) {
        headers['x-api-key'] = apiKey;
        headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
}

async function callWorkbenchModel(session) {
    // Transport follows the provider's apiMode, not the session.provider hint.
    // opencode-zen/kilo/deepseek/etc. are openai_chat even when the UI session
    // is 'claude'-shaped — sending Anthropic format to them 404s.
    const useOpenAi = (() => {
        try { return getWorkbenchProfile(session).useOpenAiFormat; } catch { return session.provider === 'codex'; }
    })();
    return useOpenAi ? callOpenAiWorkbenchModel(session) : callAnthropicWorkbenchModel(session);
}

async function callWorkbenchModelStream(session, emit) {
    const useOpenAi = (() => {
        try { return getWorkbenchProfile(session).useOpenAiFormat; } catch { return session.provider === 'codex'; }
    })();
    if (useOpenAi) {
        await callOpenAiWorkbenchModelStream(session, emit);
    } else {
        await callAnthropicWorkbenchModelStream(session, emit);
    }
}

async function callAnthropicWorkbenchModel(session) {
    const profile = getWorkbenchProfile(session);
    if (!profile.targetUrl) throw new Error('Workbench provider target URL is missing.');
    const model = profile._upstreamModel || profile.currentModel || 'claude-opus-4-6';

    const events = [];
    let loops = 0;
    while (loops < getWorkbenchMaxToolLoops()) {
        loops++;
        const brainPolicy = getSessionBrainPolicy(session);
        const modelEntry = modelCatalog.get(model);
        const effectiveEffort = resolveEffectiveEffort(undefined, session, modelEntry);
        const body = {
            model,
            max_tokens: brainPolicy.executionPolicy.maxTokens,
            system: buildSystemPrompt(session),
            messages: session.messages,
            tools: toolDefinitions(session)
        };
        if (modelEntry && modelEntry.supportsThinking) {
            const budget = effortToThinkingBudget(
                effectiveEffort,
                modelEntry.thinkingBudgetMax || 0,
                brainPolicy.executionPolicy.maxTokens
            );
            if (budget > 0) body.thinking = { type: 'enabled', budget_tokens: budget };
        } else {
            body.system = `${effortToPromptInstruction(effectiveEffort)}\n\n${body.system}`;
        }
        const response = await fetch(profile.targetUrl, {
            method: 'POST',
            headers: buildHeaders(profile.apiKey),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(300000)
        });
        const raw = await response.text();
        if (!response.ok) throw new Error(`Workbench upstream error ${response.status}: ${raw.slice(0, 500)}`);
        const data = JSON.parse(raw);
        const content = Array.isArray(data.content) ? data.content : [];
        session.messages.push({ role: 'assistant', content });
        extractAndSyncTodos(session);

        content.forEach(block => {
            if (block.type === 'text') events.push({ type: 'text', content: block.text });
            else if (block.type === 'thinking') events.push({ type: 'thinking', content: block.thinking });
            else if (block.type === 'tool_use') events.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        });

        const toolUses = content.filter(block => block.type === 'tool_use');
        if (!toolUses.length) {
            session.updatedAt = new Date().toISOString();
            return { session: summarizeSession(session), assistant: extractAssistantText(content), content, events };
        }

        const results = await executeWorkbenchToolBatch(session, toolUses);
        results.forEach(r => events.push({ type: 'tool_result', id: r.tool_use_id, content: r.content, is_error: r.is_error }));
        session.messages.push({ role: 'user', content: results });
    }

    session.updatedAt = new Date().toISOString();
    return {
        session: summarizeSession(session),
        assistant: 'Workbench halted. Review the current plan or send a narrower request.',
        content: [],
        events
    };
}

// Convert a single Anthropic-shaped session message into one or more
// OpenAI-shaped chat messages. Returns [] for assistant turns that have no
// text and no tool_use blocks, so strict OpenAI-compatible providers (e.g.
// DeepSeek) do not see an assistant turn with `content: null` and no
// `tool_calls` (the "content or tool_calls must be set" 400).
function toOpenAiMessage(message) {
    if (message.role === 'user' && typeof message.content === 'string') {
        return [{ role: 'user', content: message.content }];
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
        const text = extractAssistantText(message.content);
        const toolUses = message.content.filter(block => block.type === 'tool_use');
        if (!text && !toolUses.length) return []; // drop empty assistant turns
        return [{
            role: 'assistant',
            content: text || null,
            tool_calls: toolUses.length ? toolUses.map(toolUse => ({
                id: toolUse.id,
                type: 'function',
                function: {
                    name: toolUse.name,
                    arguments: JSON.stringify(toolUse.input || {})
                }
            })) : undefined
        }];
    }
    if (message.role === 'user' && Array.isArray(message.content)) {
        return message.content
            .filter(block => block.type === 'tool_result')
            .map(block => ({
                role: 'tool',
                tool_call_id: block.tool_use_id,
                content: block.content || ''
            }));
    }
    return [];
}

function toOpenAiMessages(messages) {
    return messages.flatMap(toOpenAiMessage);
}

function openAiMessageToAnthropicContent(message = {}) {
    const content = [];
    // Capture reasoning/thinking content from OpenAI-compatible providers.
    // DeepSeek exposes it as `reasoning_content`; other providers use
    // `thinking` or `reasoning`. Persisted as a `thinking` block so the
    // frontend can render it; the next round-trip via `toOpenAiMessage`
    // drops it (providers don't consume thinking in history).
    const reasoning = message.reasoning_content ?? message.thinking ?? message.reasoning;
    if (reasoning) content.push({ type: 'thinking', thinking: String(reasoning) });
    if (message.content) content.push({ type: 'text', text: String(message.content) });
    (message.tool_calls || []).forEach(toolCall => {
        let input = {};
        try { input = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) { input = {}; }
        content.push({
            type: 'tool_use',
            id: toolCall.id || newId('toolu'),
            name: toolCall.function?.name,
            input
        });
    });
    return content;
}

async function callOpenAiWorkbenchModel(session) {
    const profile = getWorkbenchProfile(session);
    if (!profile.targetUrl) throw new Error('Workbench provider target URL is missing.');
    const model = profile._upstreamModel || profile.currentModel || 'gpt-4o';

    const events = [];
    let loops = 0;
    while (loops < getWorkbenchMaxToolLoops()) {
        loops++;
        const brainPolicy = getSessionBrainPolicy(session);
        const modelEntry = modelCatalog.get(model);
        const effectiveEffort = resolveEffectiveEffort(undefined, session, modelEntry);
        const openAiEffort = modelEntry && modelEntry.supportsReasoning
            ? effortToOpenAiReasoningEffort(effectiveEffort)
            : null;
        const body = {
            model,
            messages: [
                { role: 'system', content: buildSystemPrompt(session) },
                ...toOpenAiMessages(session.messages)
            ],
            tools: openAiToolDefinitions(session),
            tool_choice: 'auto',
            stream: false,
            max_tokens: brainPolicy.executionPolicy.maxTokens
        };
        if (openAiEffort) body.reasoning_effort = openAiEffort;
        const response = await fetch(profile.targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {})
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(300000)
        });
        const raw = await response.text();
        if (!response.ok) throw new Error(`Workbench upstream error ${response.status}: ${raw.slice(0, 500)}`);
        const data = JSON.parse(raw);
        const message = data.choices?.[0]?.message || {};
        const content = openAiMessageToAnthropicContent(message);
        // Skip persisting an empty assistant turn — strict OpenAI-compatible
        // providers (e.g. DeepSeek) reject assistant messages with
        // `content: null` and no `tool_calls`. Empty `content` here means the
        // upstream returned no `message.content` and no `message.tool_calls`.
        if (content.length) {
            session.messages.push({ role: 'assistant', content });
        }
        extractAndSyncTodos(session);

        content.forEach(block => {
            if (block.type === 'text') events.push({ type: 'text', content: block.text });
            else if (block.type === 'thinking') events.push({ type: 'thinking', content: block.thinking });
            else if (block.type === 'tool_use') events.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        });

        const toolUses = content.filter(block => block.type === 'tool_use');
        if (!toolUses.length) {
            session.updatedAt = new Date().toISOString();
            return { session: summarizeSession(session), assistant: extractAssistantText(content), content, events };
        }

        const results = await executeWorkbenchToolBatch(session, toolUses);
        results.forEach(r => events.push({ type: 'tool_result', id: r.tool_use_id, content: r.content, is_error: r.is_error }));
        session.messages.push({ role: 'user', content: results });
    }

    session.updatedAt = new Date().toISOString();
    return {
        session: summarizeSession(session),
        assistant: 'Workbench halted. Review the current plan or send a narrower request.',
        content: [],
        events
    };
}

async function sendWorkbenchMessage({ sessionId, message, provider, agentId } = {}) {
    const session = getWorkbenchSession(sessionId);
    if (provider === 'claude' || provider === 'codex') session.provider = provider;
    if (agentId) session.agentId = resolveAgentId(agentId, session.agentId || 'build');
    const text = String(message || '').trim();
    if (!text) throw new Error('Message is required.');
    session.messages.push({ role: 'user', content: text });
    session.updatedAt = new Date().toISOString();
    return callWorkbenchModel(session);
}

function parseWorkbenchSlashCommand(text) {
    const match = String(text || '').trim().match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    return {
        command: match[1].toLowerCase(),
        arg: String(match[2] || '').trim()
    };
}

function appendGoalContinueMessage(session, evaluation) {
    session.messages.push({
        role: 'user',
        content: [
            `/goal is still active: ${session.goal.condition}`,
            `Evaluator: ${evaluation.reason || 'Goal not fully met yet.'}`,
            'Continue autonomously toward the goal. Read/search/inspect as needed, use approved mutations only when allowed, and report concrete progress.'
        ].join('\n')
    });
    session.updatedAt = new Date().toISOString();
}

async function continueGoalUntilReached(session, emit) {
    while (session.goal && session.goal.status === 'active') {
        const evaluation = await evaluateWorkbenchGoal(session);
        const now = new Date().toISOString();
        session.goal.turns = Number(session.goal.turns || 0) + 1;
        session.goal.lastReason = evaluation.reason;
        session.goal.lastMet = evaluation.met === true;
        session.goal.updatedAt = now;

        if (evaluation.met) {
            session.goal.status = 'achieved';
            session.goal.achievedAt = now;
            session.lastGoal = session.goal;
            session.goal = null;
            session.updatedAt = now;
            safeEmit(emit, 'goal', { goal: null, lastGoal: summarizeGoal(session.lastGoal), event: 'achieved' });
            return;
        }

        safeEmit(emit, 'goal', { goal: summarizeGoal(session.goal), lastGoal: summarizeGoal(session.lastGoal), event: 'continue' });
        appendGoalContinueMessage(session, evaluation);
        await callWorkbenchModelStream(session, emit);
    }
}

async function handleGoalCommand(session, arg, emit) {
    const lower = String(arg || '').trim().toLowerCase();
    if (!arg || lower === 'status') {
        const current = summarizeGoal(session.goal);
        const last = summarizeGoal(session.lastGoal);
        safeEmit(emit, 'goal', { goal: current, lastGoal: last, event: current ? 'status' : 'idle' });
        safeEmit(emit, 'text', {
            content: current
                ? `Active goal: ${current.condition}\nStatus: ${current.lastReason || 'running'}`
                : (last ? `No active goal. Last goal (${last.status}): ${last.condition}` : 'No active goal.')
        });
        return;
    }

    if (GOAL_CLEAR_ALIASES.has(lower)) {
        const last = clearWorkbenchGoal(session, 'Goal cleared by the user.');
        safeEmit(emit, 'goal', { goal: null, lastGoal: last, event: 'cleared' });
        safeEmit(emit, 'text', { content: 'Goal cleared.' });
        return;
    }

    const goal = setWorkbenchGoal(session, arg);
    safeEmit(emit, 'goal', { goal, lastGoal: summarizeGoal(session.lastGoal), event: 'started' });
    session.messages.push({
        role: 'user',
        content: [
            `/goal ${goal.condition}`,
            'Work toward this goal and continue until the goal evaluator says it is reached. If user approval or information is required, clearly ask for it.'
        ].join('\n')
    });
    session.updatedAt = new Date().toISOString();
    await callWorkbenchModelStream(session, emit);
    await continueGoalUntilReached(session, emit);
}

function getWorkbenchGoalStatus(sessionId) {
    const session = getWorkbenchSession(sessionId);
    return {
        goal: summarizeGoal(session.goal),
        lastGoal: summarizeGoal(session.lastGoal),
        session: summarizeSession(session)
    };
}

function updateWorkbenchGoal({ sessionId, action, condition } = {}) {
    const session = getWorkbenchSession(sessionId);
    const normalized = String(action || '').toLowerCase();
    if (normalized === 'clear') {
        return { goal: null, lastGoal: clearWorkbenchGoal(session, 'Goal cleared by the user.'), session: summarizeSession(session) };
    }
    if (normalized === 'set') {
        return { goal: setWorkbenchGoal(session, condition), lastGoal: summarizeGoal(session.lastGoal), session: summarizeSession(session) };
    }
    return getWorkbenchGoalStatus(sessionId);
}

/* ── SSE Streaming versions ── */

function safeEmit(emit, type, data) {
    try { emit(type, data); } catch (_) { throw new Error('SSE connection closed'); }
}

async function parseAnthropicStream(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', eventType = '', eventData = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) eventData = line.slice(6).trim();
            else if (line === '' && eventType && eventData) {
                if (eventData !== '[DONE]') { try { onEvent(eventType, JSON.parse(eventData)); } catch (_) {} }
                eventType = ''; eventData = '';
            }
        }
    }
    if (eventType && eventData && eventData !== '[DONE]') { try { onEvent(eventType, JSON.parse(eventData)); } catch (_) {} }
}

async function parseOpenAiStream(response, onData) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6).trim();
            if (payload === '[DONE]') { onData('[DONE]', null); continue; }
            try { onData('chunk', JSON.parse(payload)); } catch (_) {}
        }
    }
}

async function callAnthropicWorkbenchModelStream(session, emit) {
    const profile = getWorkbenchProfile(session);
    if (!profile.targetUrl) throw new Error('Workbench provider target URL is missing.');
    const model = profile._upstreamModel || profile.currentModel || 'claude-opus-4-6';

    let loops = 0;
    while (loops < getWorkbenchMaxToolLoops()) {
        loops++;
        const brainPolicy = getSessionBrainPolicy(session);
        const modelEntry = modelCatalog.get(model);
        const effectiveEffort = resolveEffectiveEffort(undefined, session, modelEntry);
        const body = {
            model,
            max_tokens: brainPolicy.executionPolicy.maxTokens,
            system: buildSystemPrompt(session),
            messages: session.messages,
            tools: toolDefinitions(session),
            stream: true
        };
        if (modelEntry && modelEntry.supportsThinking) {
            const budget = effortToThinkingBudget(
                effectiveEffort,
                modelEntry.thinkingBudgetMax || 0,
                brainPolicy.executionPolicy.maxTokens
            );
            if (budget > 0) body.thinking = { type: 'enabled', budget_tokens: budget };
        } else {
            body.system = `${effortToPromptInstruction(effectiveEffort)}\n\n${body.system}`;
        }
        const response = await fetch(profile.targetUrl, {
            method: 'POST',
            headers: buildHeaders(profile.apiKey),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(300000)
        });
        if (!response.ok) {
            const raw = await response.text();
            throw new Error(`Workbench upstream error ${response.status}: ${raw.slice(0, 500)}`);
        }

        const blocks = {};

        await parseAnthropicStream(response, (eventType, data) => {
            switch (eventType) {
                case 'content_block_start': {
                    const block = { ...data.content_block, index: data.index };
                    blocks[data.index] = block;
                    if (block.type === 'tool_use') {
                        safeEmit(emit, 'tool_use', { id: block.id, name: block.name, input: block.input || {} });
                    }
                    break;
                }
                case 'content_block_delta': {
                    const block = blocks[data.index];
                    if (!block) break;
                    if (data.delta.type === 'thinking_delta') {
                        block.thinking = (block.thinking || '') + (data.delta.thinking || '');
                        safeEmit(emit, 'thinking', { content: data.delta.thinking || '' });
                    } else if (data.delta.type === 'text_delta') {
                        block.text = (block.text || '') + (data.delta.text || '');
                        if (data.delta.text) safeEmit(emit, 'text', { content: data.delta.text });
                    } else if (data.delta.type === 'input_json_delta') {
                        block._inputPart = (block._inputPart || '') + (data.delta.partial_json || '');
                    }
                    break;
                }
                case 'content_block_stop': {
                    const block = blocks[data.index];
                    if (block && block.type === 'tool_use' && block._inputPart) {
                        try { block.input = JSON.parse(block._inputPart); } catch (_) {}
                        delete block._inputPart;
                    }
                    break;
                }
                case 'message_stop': {
                    break;
                }
            }
        });

        const content = Object.values(blocks).sort((a, b) => (a.index || 0) - (b.index || 0));
        for (const b of content) { delete b.index; delete b._inputPart; }
        session.messages.push({ role: 'assistant', content });
        extractAndSyncTodos(session);

        const toolUses = content.filter(b => b.type === 'tool_use');
        if (!toolUses.length) {
            session.updatedAt = new Date().toISOString();
            return;
        }

        const toolResults = await executeWorkbenchToolBatch(session, toolUses);
        toolResults.forEach(result => safeEmit(emit, 'tool_result', {
            id: result.tool_use_id,
            content: result.content,
            is_error: result.is_error
        }));
        session.messages.push({ role: 'user', content: toolResults });
    }

    session.updatedAt = new Date().toISOString();
    safeEmit(emit, 'text', { content: 'Workbench stopped after the maximum tool loop count.' });
}

async function callOpenAiWorkbenchModelStream(session, emit) {
    const profile = getWorkbenchProfile(session);
    if (!profile.targetUrl) throw new Error('Workbench provider target URL is missing.');
    const model = profile._upstreamModel || profile.currentModel || 'gpt-4o';

    let loops = 0;
    while (loops < getWorkbenchMaxToolLoops()) {
        loops++;
        const brainPolicy = getSessionBrainPolicy(session);
        const modelEntry = modelCatalog.get(model);
        const effectiveEffort = resolveEffectiveEffort(undefined, session, modelEntry);
        const openAiEffort = modelEntry && modelEntry.supportsReasoning
            ? effortToOpenAiReasoningEffort(effectiveEffort)
            : null;
        const body = {
            model,
            messages: [
                { role: 'system', content: buildSystemPrompt(session) },
                ...toOpenAiMessages(session.messages)
            ],
            tools: openAiToolDefinitions(session),
            tool_choice: 'auto',
            stream: true,
            max_tokens: brainPolicy.executionPolicy.maxTokens
        };
        if (openAiEffort) body.reasoning_effort = openAiEffort;
        const response = await fetch(profile.targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {})
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(300000)
        });
        if (!response.ok) {
            const raw = await response.text();
            throw new Error(`Workbench upstream error ${response.status}: ${raw.slice(0, 500)}`);
        }

        let textBuffer = '';
        let thinkingBuffer = '';
        const toolCallAccum = {};

        await parseOpenAiStream(response, (eventType, data) => {
            if (eventType === '[DONE]') return;
            const choice = data.choices?.[0];
            if (!choice) return;
            const delta = choice.delta || {};

            // Capture reasoning/thinking deltas in real time. DeepSeek exposes
            // this as `reasoning_content`; other providers use `thinking` or
            // `reasoning`. Emit each delta so the frontend shows live thinking,
            // and buffer the full text for the persisted content block. Text
            // deltas are emitted live as well so the answer streams in-place.
            const reasoningDelta = delta.reasoning_content ?? delta.thinking ?? delta.reasoning;
            if (reasoningDelta) {
                thinkingBuffer += reasoningDelta;
                safeEmit(emit, 'thinking', { content: reasoningDelta });
            }

            if (delta.content) {
                textBuffer += delta.content;
                safeEmit(emit, 'text', { content: delta.content });
            }

            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    if (!toolCallAccum[idx]) toolCallAccum[idx] = {};
                    if (tc.id) toolCallAccum[idx].id = tc.id;
                    if (tc.function?.name) toolCallAccum[idx].name = tc.function.name;
                    if (tc.function?.arguments) {
                        toolCallAccum[idx].args = (toolCallAccum[idx].args || '') + tc.function.arguments;
                    }
                }
            }

            if (choice.finish_reason) {
                const indices = Object.keys(toolCallAccum).sort((a, b) => Number(a) - Number(b));
                for (const i of indices) {
                    const tc = toolCallAccum[i];
                    let input = {};
                    try { input = JSON.parse(tc.args || '{}'); } catch (_) {}
                    safeEmit(emit, 'tool_use', { id: tc.id || newId('toolu'), name: tc.name, input });
                }
            }
        });

        const content = [];
        if (thinkingBuffer) content.push({ type: 'thinking', thinking: thinkingBuffer });
        if (textBuffer) content.push({ type: 'text', text: textBuffer });

        const toolUses = [];
        const indices = Object.keys(toolCallAccum).sort((a, b) => Number(a) - Number(b));
        for (const i of indices) {
            const tc = toolCallAccum[i];
            let input = {};
            try { input = JSON.parse(tc.args || '{}'); } catch (_) {}
            const tu = { type: 'tool_use', id: tc.id || newId('toolu'), name: tc.name, input };
            content.push(tu);
            toolUses.push(tu);
        }

        // Skip persisting an empty assistant turn — strict OpenAI-compatible
        // providers (e.g. DeepSeek) reject assistant messages with
        // `content: null` and no `tool_calls`. If nothing was streamed and
        // there are no tool calls, end this iteration cleanly.
        if (!content.length) {
            session.updatedAt = new Date().toISOString();
            return;
        }
        session.messages.push({ role: 'assistant', content });
        extractAndSyncTodos(session);

        if (!toolUses.length) {
            session.updatedAt = new Date().toISOString();
            return;
        }

        const toolResults = await executeWorkbenchToolBatch(session, toolUses);
        toolResults.forEach(result => safeEmit(emit, 'tool_result', {
            id: result.tool_use_id,
            content: result.content,
            is_error: result.is_error
        }));
        session.messages.push({ role: 'user', content: toolResults });
    }

    session.updatedAt = new Date().toISOString();
    safeEmit(emit, 'text', { content: 'Workbench stopped after the maximum tool loop count.' });
}

async function sendWorkbenchMessageStream({ sessionId, message, provider, agentId, effort } = {}, emit) {
    const session = getWorkbenchSession(sessionId);
    if (provider === 'claude' || provider === 'codex') session.provider = provider;
    if (agentId) session.agentId = resolveAgentId(agentId, session.agentId || 'build');
    // Persist the user's effort choice on the session so subsequent turns in
    // this session (/btw, /goal, goal continuation) reuse the same setting.
    const normalizedIncoming = normalizeEffort(effort);
    if (normalizedIncoming) session.effort = normalizedIncoming;
    const text = String(message || '').trim();
    if (!text) throw new Error('Message is required.');

    const slash = parseWorkbenchSlashCommand(text);
    if (slash?.command === 'goal') {
        await handleGoalCommand(session, slash.arg, emit);
        safeEmit(emit, 'session', summarizeSession(session));
        return;
    }

    if (slash?.command === 'btw') {
        const result = await answerWorkbenchBtw({ sessionId: session.id, question: slash.arg, provider: session.provider, agentId: session.agentId });
        safeEmit(emit, 'btw', result);
        safeEmit(emit, 'text', { content: result.answer });
        safeEmit(emit, 'session', summarizeSession(session));
        return;
    }

    session.messages.push({ role: 'user', content: text });
    session.updatedAt = new Date().toISOString();

    if (session.messages.filter(m => m.role === 'user').length === 1 && !session.title) {
        generateSessionTitle(session, text, emit).catch(e => console.warn('[Workbench] title gen err:', e.message));
    }

    // Emit the assembled prompt so the UI can show a collapsible "PROMPT"
    // disclosure. Carries the system prompt + the current user message;
    // large enough to be informative but small enough to be readable.
    try {
        const sysPrompt = buildSystemPrompt(session);
        const promptPayload = {
            content: sysPrompt + '\n\n[user]\n' + text,
            systemPrompt: sysPrompt,
            userMessage: text,
            tokens: (sysPrompt.length + text.length) / 4,
        };
        safeEmit(emit, 'prompt', promptPayload);
    } catch (err) {
        // Non-fatal: if prompt assembly fails, the turn still proceeds.
        console.warn('[Workbench] prompt emit failed:', err.message);
    }

    await callWorkbenchModelStream(session, emit);
    await continueGoalUntilReached(session, emit);

    // Background auto-memory extraction
    try {
        const lastAssistant = session.messages.filter(m => m.role === 'assistant').pop();
        if (lastAssistant) {
            const cfg = getWorkbenchProfile(session);
            extractAndSaveMemories(session.messages, lastAssistant, cfg, cfg._upstreamModel || cfg.currentModel, 'workbench')
                .catch(e => console.warn('[Auto-Memory] Workbench extraction failed:', e.message));
        }
    } catch (_) {}

    saveSessions();
    safeEmit(emit, 'session', summarizeSession(session));
}

function approveWorkbenchPlan(sessionId) {
    const session = getWorkbenchSession(sessionId);
    if (!session.plan) throw new Error('No submitted plan is waiting for approval.');
    session.approved = true;
    session.approvedAt = new Date().toISOString();
    session.updatedAt = session.approvedAt;
    saveSessions();
    return summarizeSession(session);
}

function resetWorkbenchSession(sessionId, provider, agentId = 'build') {
    if (sessionId) {
        sessions.delete(sessionId);
        saveSessions();
    }
    return createWorkbenchSession({ provider, agentId });
}

function deleteWorkbenchSession(sessionId) {
    if (sessionId && sessions.has(sessionId)) {
        sessions.delete(sessionId);
        saveSessions();
        return true;
    }
    return false;
}

async function generateSessionTitle(session, firstMessage, emit) {
    try {
        const profile = getWorkbenchProfile(session);
        if (!profile.targetUrl || !profile.apiKey) return;
        const prompt = `Summarize this request as a short title:\n\n<request>${firstMessage}</request>\n\nOutput only the title, nothing else, no quotes.`;

        const isOpenAi = profile.useOpenAiFormat;
        const body = {
            model: profile._upstreamModel || profile.currentModel || (isOpenAi ? 'gpt-4o-mini' : 'claude-3-haiku-20240307'),
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 300
        };

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${profile.apiKey}`
        };
        if (!isOpenAi) {
            headers['x-api-key'] = profile.apiKey;
            headers['anthropic-version'] = '2023-06-01';
        }

        const fetchFn = typeof fetch !== 'undefined' ? fetch : require('node-fetch');
        const res = await fetchFn(profile.targetUrl, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!res.ok) return;
        const data = await res.json();
        let title = '';
        if (isOpenAi && data.choices && data.choices[0]?.message?.content) {
            title = data.choices[0].message.content.trim();
        } else if (!isOpenAi && data.content && Array.isArray(data.content)) {
            for (const block of data.content) {
                if (block.text) { title = block.text.trim(); break; }
            }
            if (!title) {
                for (const block of data.content) {
                    if (block.thinking) { title = block.thinking.trim(); break; }
                }
            }
        }
        if (title) {
            session.title = title.replace(/^["']|["']$/g, '');
            saveSessions();
            if (emit) {
                safeEmit(emit, 'session', summarizeSession(session));
            }
        }
    } catch(e) {
        console.warn('[Workbench] Failed to generate session title:', e.message);
    }
}

module.exports = {
    WORKSPACE_ROOT,
    getWorkspaceRoot,
    getProjectRoot,
    getContainerProjectRoot,
    getProxyRoot,
    getHostProjectRoots,
    answerWorkbenchBtw,
    approveWorkbenchPlan,
    clearWorkbenchGoal,
    createWorkbenchSession,
    deleteWorkbenchSession,
    executeWorkbenchToolBatch,
    executeWorkbenchTool,
    generateSessionTitle,
    getSessionBrainPolicy,
    getWorkbenchGoalStatus,
    getWorkbenchSession,
    listWorkbenchSessions,
    listAgentRegistry,
    listProxyCapabilities,
    resetWorkbenchSession,
    resolveAnyPath,
    toDisplayPath,
    sendWorkbenchMessage,
    sendWorkbenchMessageStream,
    setWorkbenchGoal,
    summarizeGoal,
    summarizeSession,
    updateWorkbenchGoal,
    extractAndSyncTodos
};
