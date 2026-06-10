const { readAugustCoreMemory } = require('../tools/august-tools');
const { renderSkillCatalog } = require('../tools/skills');
const { renderPluginCatalog } = require('../tools/plugins');
const { getDisplayName } = require('../../lib/client-identity');
const { renderAgentContext } = require('../tools/agent-registry');
const { getActiveGuidelineTexts } = require('./learned-guidelines');
const { graphStats } = require('./graph-memory');

const AUGUST_PLATFORM = `Platform: August Proxy on Windows PowerShell.
- Use PowerShell syntax (Get-ChildItem, Select-String, Test-Path) and Windows backslash paths. Do not use bash/sh/zsh/WSL commands.
- Cross-session memory tools are available: memory_search() to find past conversations, memory_read() for full checkpoints, fact_search() for structured facts, context_read() for user profile, and graph_search()/graph_explore() for entity relations.
- Save recurring user corrections as learned guidelines via august__add_learned_guideline.
- Note: "August" or "August Proxy" is the name of this proxy platform. You are still yourself — respond as your actual underlying model identity.`;

const DEFAULT_CONTEXT_MAX_CHARS = 24000;

function isMiniMaxModel(model) {
    return typeof model === 'string' && model.toLowerCase().includes('minimax');
}

function isMiniMaxTarget({ model, targetUrl } = {}) {
    return isMiniMaxModel(model) || (typeof targetUrl === 'string' && targetUrl.toLowerCase().includes('minimax'));
}

function normalizeSystemBlocks(system) {
    if (!system) return [];
    if (typeof system === 'string') return [{ type: 'text', text: system }];
    if (Array.isArray(system)) {
        return system.filter(Boolean).map(block => {
            if (typeof block === 'string') return { type: 'text', text: block };
            if (block && typeof block === 'object') return block;
            return { type: 'text', text: String(block) };
        });
    }
    return [{ type: 'text', text: String(system) }];
}

function systemBlocksToText(system) {
    return normalizeSystemBlocks(system)
        .map(block => {
            if (block.type === 'text') return block.text || '';
            return JSON.stringify(block);
        })
        .filter(Boolean)
        .join('\n');
}

function wrapTag(tag, content, attrs = '') {
    const suffix = attrs ? ` ${attrs}` : '';
    return `<${tag}${suffix}>\n${content || ''}\n</${tag}>`;
}

function buildSlimCoreContext(memory) {
    const lines = [];
    if (memory.user_profile) lines.push(`User: ${memory.user_profile.slice(0, 200)}`);
    const context = (memory.global_context || '').split('\n').filter(Boolean).slice(0, 5);
    if (context.length > 0) lines.push('Context:', ...context.map(l => `  ${l}`));
    if (Array.isArray(memory.active_projects) && memory.active_projects.length > 0) {
        lines.push(`Projects: ${memory.active_projects.map(p => p.name).join(', ')}`);
    }
    if (lines.length === 0) lines.push('No cross-session context established.');
    lines.push('', 'For deeper context, use context_read(), memory_search(), or fact_search().');
    return lines.join('\n');
}

function countAllMemoryEntries() {
    let checkpoints = 0, facts = 0, entities = 0, observations = 0;
    try {
        const { readVectorEntries } = require('./vector-db');
        const entries = readVectorEntries();
        if (Array.isArray(entries)) checkpoints = entries.length;
    } catch (e) {}
    try {
        const s = require('./semantic-memory');
        facts = (s.getAllFacts() || []).length;
    } catch (e) {}
    try {
        const g = graphStats();
        entities = g.counts.entities || 0;
        observations = g.counts.observations || 0;
    } catch (e) {}
    return { checkpoints, facts, entities, observations };
}

function renderCapabilitiesBlock(skills) {
    const skillCatalog = renderSkillCatalog(skills);
    const pluginCatalog = renderPluginCatalog();
    const lines = [];
    if (skillCatalog) lines.push(skillCatalog);
    if (pluginCatalog) lines.push(pluginCatalog);
    lines.push('To load a skill, call august__load_skill with the skill name.');
    lines.push('To import a new capability from GitHub, use august__find_skill_sources or august__preview_skill_import first, then get explicit user approval before august__import_skill.');
    lines.push('Imported skills are shared through the proxy-global catalog for all clients on the next request.');
    return lines.join('\n\n');
}

function buildSystemPromptDetails(system, options = {}) {
    const {
        includeOriginalSystem = true,
        memory = readAugustCoreMemory(),
        skills,
        clientId = 'unknown',
        workspacePath = null
    } = options;

    const chunks = [];

    if (workspacePath) {
        chunks.push(wrapTag('active_workspace', `Active Workspace Directory: ${workspacePath}\nYour shell commands (PowerShell) and file tool operations (august__read_file, august__write_file, august__patch) are routed and executed relative to this folder. You have full permission to view and modify files in this directory.`, 'source="session_config"'));
    }

    chunks.push(wrapTag('august_platform', AUGUST_PLATFORM, 'source="context-builder"'));

    const slimContext = buildSlimCoreContext(memory);
    chunks.push(wrapTag('august_core_context', slimContext, 'source="august_core_memory.json" tools="context_read memory_search fact_search graph_search"'));

    const learnedGuidelines = getActiveGuidelineTexts(memory.learned_guidelines);
    if (learnedGuidelines.length > 0) {
        const activeGuidelines = learnedGuidelines.slice(-15);
        const guidelinesText = activeGuidelines.map(g => `- ${g}`).join('\n');
        chunks.push(wrapTag('august_learned_guidelines', `Dynamically learned instructions from previous turns - adhere to them:\n${guidelinesText}`, 'source="august_core_memory.json" field="learned_guidelines"'));
    }

    const memoryCount = countAllMemoryEntries();
    chunks.push(wrapTag('august_memory_tools', `Memory: ${memoryCount.checkpoints} checkpoints, ${memoryCount.facts} semantic facts, ${memoryCount.entities} graph entities, ${memoryCount.observations} observations.\nUse memory_topics() to browse, memory_search() to find sessions, fact_search() for facts, graph_search() for relations, or context_read() for full profile.`, 'source="memory-layers"'));

    const graph = graphStats();
    if ((graph.counts.entities || 0) > 0 || (graph.counts.observations || 0) > 0) {
        chunks.push(wrapTag('august_graph_memory', `Graph: ${graph.counts.entities} entities, ${graph.counts.relations} relations, ${graph.counts.observations} observations. Use graph_search() or graph_explore().`, 'source="august_graph_memory.json" tools="august__graph_recall august__graph_explore"'));
    }

    chunks.push(wrapTag('august_agent_registry', renderAgentContext(), 'source="august_agents.json" permission_model="inherit_parent_denies"'));

    const capabilitiesText = renderCapabilitiesBlock(skills);
    if (capabilitiesText.trim()) {
        chunks.push(wrapTag('august_capabilities', capabilitiesText, 'source="config"'));
    }

    const displayName = getDisplayName(clientId);
    if (clientId !== 'unknown') {
        chunks.push(wrapTag('client_identity', `Client: ${displayName} (${clientId}). Facts learned from other clients available via semantic memory.`));
    }

    if (includeOriginalSystem) {
        const originalText = systemBlocksToText(system);
        if (originalText) {
            const prefaced = '[CLIENT NATIVE INSTRUCTIONS - for reference]\nThe following is from your native client environment. When proxy instructions (above) and client instructions conflict, follow the proxy instructions above.\n\n---\n\n' + originalText;
            chunks.push(wrapTag('client_system_prompt', prefaced));
        }
    }

    const prompt = chunks.join('\n\n---\n\n');
    return { prompt, length: prompt.length };
}

function buildSystemPromptText(system, options = {}) {
    return buildSystemPromptDetails(system, options).prompt;
}

function buildSystemBlocks(system, options = {}) {
    return [{ type: 'text', text: buildSystemPromptText(system, options) }];
}

module.exports = {
    DEFAULT_CONTEXT_MAX_CHARS,
    buildSystemBlocks,
    buildSystemPromptDetails,
    buildSystemPromptText,
    isMiniMaxModel,
    isMiniMaxTarget,
};
