const fs = require('fs');
const path = require('path');
const { dataPath } = require('../../lib/data-paths');

const AGENTS_FILE = dataPath('august_agents.json');

const EDIT_TOOLS = new Set([
    'august__write_file',
    'august__write_file',
    'august__replace_text',
    'apply_patch',
    'write',
    'edit'
]);

const SHELL_TOOLS = new Set([
    'august__bash',
    'august__run_command',
    'terminal_execute',
    'terminal_submit_command'
]);

const DELEGATE_TOOLS = new Set([
    'august__spawn_subagent',
    'august__spawn_subagent'
]);

// Task 9: New permission categories.
const SYSTEM_TOOLS = new Set([
    'august__system_info',
    'august__system_exec',
    'august__system_process',
    'august__system_env',
    'august__system_network',
    'august__filesystem_list',
    'august__filesystem_read',
    'august__filesystem_write',
    'august__filesystem_copy',
    'august__filesystem_move',
    'august__filesystem_delete'
]);

const AUGUST_API_TOOLS = new Set([
    'august__self_snapshot',
    'august__sessions_manage',
    'august__settings_update',
    'august__providers_manage',
    'august__aliases_manage',
    'august__models_select',
    'august__tools_manage',
    'august__agents_manage',
    'august__rollback_undo'
]);

const UI_TOOLS = new Set([
    'august__ui_control'
]);

const MEMORY_WRITE_TOOLS = new Set([
    'august__memory_manage',
    'august__remember',
    'august__forget',
    'august__learn_subagent',
    'august__set_learned_guideline_status',
    'august__graph_observe',
    'august__graph_link',
    'august__graph_index_memory'
]);

const COMPUTER_POLICY_TOOLS = new Set([
    'august__app_policy'
]);

const TEAM_AGENT_IDS = new Set([
    'project_manager',
    'frontend_dev',
    'backend_dev',
    'qa_tester',
    'documentation',
    'deployment'
]);

const FULL_TEAM_PERMISSIONS = {
    read: 'allow',
    search: 'allow',
    web: 'allow',
    edit: 'allow',
    shell: 'allow',
    memory_write: 'allow',
    delegate: 'allow',
    system: 'allow',
    august_api: 'allow',
    ui: 'allow'
};

const FULL_TEAM_TOOLS = [
    'read',
    'search',
    'web',
    'edit',
    'shell',
    'memory',
    'delegate',
    'mcp',
    'cowork',
    'computer'
];

const DEFAULT_AGENTS = {
    build: {
        id: 'build',
        role: 'Primary Builder',
        mode: 'primary',
        goal: 'Implement approved changes using the full proxy toolset.',
        scopes: ['project'],
        memory_enabled: true,
        allow_delegation: true,
        permissions: {
            read: 'allow',
            search: 'allow',
            web: 'allow',
            edit: 'ask',
            shell: 'ask',
            memory_write: 'ask',
            delegate: 'ask',
            system: 'ask',
            august_api: 'ask',
            ui: 'ask'
        },
        tools: ['read', 'search', 'web', 'edit', 'shell', 'memory', 'delegate', 'system', 'august_api', 'ui']
    },
    project_manager: {
        id: 'project_manager',
        role: 'Project Manager',
        mode: 'primary',
        goal: 'Plan, route, coordinate, and execute approved work using the full proxy toolset.',
        scopes: ['project', 'frontend', 'backend', 'qa', 'docs', 'deploy'],
        memory_enabled: true,
        allow_delegation: true,
        can_cross_load_team_skills: true,
        permissions: FULL_TEAM_PERMISSIONS,
        tools: FULL_TEAM_TOOLS
    },
    frontend_dev: {
        id: 'frontend_dev',
        role: 'Frontend Developer',
        mode: 'subagent',
        goal: 'Handle React, TypeScript, Vite, Tailwind, UI components, browser behavior, and frontend tests.',
        scopes: ['frontend'],
        memory_enabled: true,
        allow_delegation: true,
        permissions: FULL_TEAM_PERMISSIONS,
        tools: FULL_TEAM_TOOLS
    },
    backend_dev: {
        id: 'backend_dev',
        role: 'Backend Developer',
        mode: 'subagent',
        goal: 'Handle Node services, provider adapters, tool registries, workbench backend logic, API routes, and backend tests.',
        scopes: ['backend'],
        memory_enabled: true,
        allow_delegation: true,
        permissions: FULL_TEAM_PERMISSIONS,
        tools: FULL_TEAM_TOOLS
    },
    qa_tester: {
        id: 'qa_tester',
        role: 'QA Tester',
        mode: 'subagent',
        goal: 'Review behavior, write or run verification steps, inspect tests, and report concrete evidence of pass/fail results.',
        scopes: ['qa'],
        memory_enabled: true,
        allow_delegation: true,
        permissions: FULL_TEAM_PERMISSIONS,
        tools: FULL_TEAM_TOOLS
    },
    documentation: {
        id: 'documentation',
        role: 'Documentation Writer',
        mode: 'subagent',
        goal: 'Update README, docs, setup guides, API notes, and user-facing change summaries.',
        scopes: ['docs'],
        memory_enabled: true,
        allow_delegation: true,
        permissions: FULL_TEAM_PERMISSIONS,
        tools: FULL_TEAM_TOOLS
    },
    deployment: {
        id: 'deployment',
        role: 'Deployment Engineer',
        mode: 'subagent',
        goal: 'Prepare and execute approved build, preview, release, Docker, or deployment steps for a scoped target.',
        scopes: ['deploy', 'frontend', 'backend'],
        memory_enabled: true,
        allow_delegation: true,
        permissions: FULL_TEAM_PERMISSIONS,
        tools: FULL_TEAM_TOOLS
    },
    plan: {
        id: 'plan',
        role: 'Read-Only Planner',
        mode: 'primary',
        goal: 'Explore, reason, and produce plans without mutating files or running risky commands.',
        memory_enabled: true,
        allow_delegation: true,
        permissions: {
            read: 'allow',
            search: 'allow',
            web: 'allow',
            edit: 'deny',
            shell: 'ask',
            memory_write: 'deny',
            delegate: 'ask'
        },
        tools: ['read', 'search', 'web', 'delegate']
    },
    explore: {
        id: 'explore',
        role: 'Codebase Explorer',
        mode: 'subagent',
        goal: 'Answer focused codebase questions quickly using read/search tools.',
        memory_enabled: true,
        allow_delegation: false,
        permissions: {
            read: 'allow',
            search: 'allow',
            web: 'allow',
            edit: 'deny',
            shell: 'ask',
            memory_write: 'deny',
            delegate: 'deny'
        },
        tools: ['read', 'search', 'web']
    },
    general: {
        id: 'general',
        role: 'General Subagent',
        mode: 'subagent',
        goal: 'Handle bounded research, analysis, and multi-step side tasks without editing files.',
        memory_enabled: true,
        allow_delegation: false,
        permissions: {
            read: 'allow',
            search: 'allow',
            web: 'allow',
            edit: 'deny',
            shell: 'ask',
            memory_write: 'deny',
            delegate: 'deny'
        },
        tools: ['read', 'search', 'web', 'memory']
    },
    coordinator: {
        id: 'coordinator',
        role: 'Subagent Coordinator',
        mode: 'subagent',
        goal: 'Break a complex approved task into smaller read-only or approval-gated child jobs and consolidate the findings.',
        memory_enabled: true,
        allow_delegation: true,
        permissions: {
            read: 'allow',
            search: 'allow',
            web: 'allow',
            edit: 'deny',
            shell: 'ask',
            memory_write: 'deny',
            delegate: 'ask'
        },
        tools: ['read', 'search', 'web', 'delegate']
    }
};

function readCustomAgents() {
    if (!fs.existsSync(AGENTS_FILE)) return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
        return {};
    }
}

function writeCustomAgents(agents) {
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents || {}, null, 2));
}

function getAgents() {
    const custom = readCustomAgents();
    return Object.values({
        ...DEFAULT_AGENTS,
        ...Object.fromEntries(Object.entries(custom).map(([id, agent]) => [id, { ...DEFAULT_AGENTS[id], ...agent, id }]))
    });
}

function getAgent(id = 'build') {
    return getAgents().find(agent => agent.id === id) || DEFAULT_AGENTS.build;
}

function canCrossLoadTeamSkills(agentId = 'build') {
    return getAgent(agentId).can_cross_load_team_skills === true;
}

function classifyTool(toolName, args) {
    const name = String(toolName || '').replace(/^workbench_/, 'august__');
    const a = args || {};
    if (DELEGATE_TOOLS.has(name) || /spawn_subagent|delegate/i.test(name)) return 'delegate';

    // Task 9: args-aware classification for new tools.
    if (UI_TOOLS.has(name)) {
        // ui_control mutating actions → ui; navigate/refresh → read
        if (a && (a.action === 'navigate' || a.action === 'refresh')) return 'read';
        return 'ui';
    }
    if (name === 'august__map_intent' || name === 'august__self_snapshot') return 'read';
    if (name === 'august__system_network') {
        // GET = read; non-GET = shell
        const method = String(a.method || 'GET').toUpperCase();
        return method === 'GET' ? 'read' : 'shell';
    }
    if (name === 'august__system_info') return 'read';
    if (SYSTEM_TOOLS.has(name)) {
        // Read-only filesystem ops = read; mutating = edit/shell
        if (name === 'august__filesystem_list' || name === 'august__filesystem_read') return 'read';
        if (name === 'august__filesystem_write' || name === 'august__filesystem_copy' ||
            name === 'august__filesystem_move' || name === 'august__filesystem_delete') return 'edit';
        // shell/process/env mutations
        return 'shell';
    }
    if (MEMORY_WRITE_TOOLS.has(name) || /remember|forget|memory_write|import_skill|learn/i.test(name)) return 'memory_write';
    if (AUGUST_API_TOOLS.has(name)) return 'august_api';
    if (COMPUTER_POLICY_TOOLS.has(name)) return 'edit';
    if (EDIT_TOOLS.has(name) || /write|edit|patch|delete|rename|move/i.test(name)) return 'edit';
    if (SHELL_TOOLS.has(name) || /bash|command|terminal|spawn|run/i.test(name)) return 'shell';
    if (/search|grep|glob|list/i.test(name)) return 'search';
    if (/web|fetch|browser/i.test(name)) return 'web';
    return 'read';
}

function mergeAction(parentAction, childAction) {
    if (parentAction === 'deny' || childAction === 'deny') return 'deny';
    if (parentAction === 'ask' || childAction === 'ask') return 'ask';
    return 'allow';
}

function deriveChildAgentPermissions(parentAgentId, childAgentId) {
    const parent = getAgent(parentAgentId);
    const child = getAgent(childAgentId);
    const permissions = {};
    const keys = new Set([
        ...Object.keys(parent.permissions || {}),
        ...Object.keys(child.permissions || {})
    ]);
    for (const key of keys) {
        permissions[key] = mergeAction(parent.permissions?.[key] || 'ask', child.permissions?.[key] || 'ask');
    }
    if (child.mode !== 'subagent') permissions.delegate = 'deny';
    if (parent.permissions?.edit === 'deny') permissions.edit = 'deny';
    if (parent.permissions?.memory_write === 'deny') permissions.memory_write = 'deny';
    return permissions;
}

function evaluateAgentTool(agentId, toolName, args, inheritedPermissions) {
    const permissions = inheritedPermissions || getAgent(agentId).permissions || {};
    const category = classifyTool(toolName, args);
    return {
        agent: agentId,
        tool: toolName,
        category,
        action: permissions[category] || 'ask'
    };
}

function renderAgentContext() {
    return getAgents()
        .map(agent => {
            const perms = Object.entries(agent.permissions || {})
                .map(([key, value]) => `${key}:${value}`)
                .join(', ');
            const scopes = Array.isArray(agent.scopes) ? agent.scopes.join(', ') : 'project';
            return `- ${agent.id} (${agent.mode}): ${agent.role}. Scopes: ${scopes}. Goal: ${agent.goal}. Permissions: ${perms}`;
        })
        .join('\n');
}

function saveAgent(agent) {
    if (!agent || !agent.id) throw new Error('agent.id is required');
    const custom = readCustomAgents();
    custom[agent.id] = {
        ...(custom[agent.id] || {}),
        ...agent,
        id: agent.id
    };
    writeCustomAgents(custom);
    return getAgent(agent.id);
}

module.exports = {
    AGENTS_FILE,
    DEFAULT_AGENTS,
    FULL_TEAM_PERMISSIONS,
    FULL_TEAM_TOOLS,
    TEAM_AGENT_IDS,
    canCrossLoadTeamSkills,
    classifyTool,
    deriveChildAgentPermissions,
    evaluateAgentTool,
    getAgent,
    getAgents,
    renderAgentContext,
    saveAgent,
    SYSTEM_TOOLS,
    AUGUST_API_TOOLS,
    UI_TOOLS,
    COMPUTER_POLICY_TOOLS,
    MEMORY_WRITE_TOOLS
};
