const fs = require('fs');
const path = require('path');

const CORE_MEMORY_FILE = path.join(__dirname, '..', '..', '..', 'data', 'august_core_memory.json');

function getDefaultAugustCoreMemory() {
    return {
        user_profile: "No profile details recorded yet. Use august__core_memory_append to add details about the user.",
        global_context: "No cross-session context established.",
        active_projects: [],
        integrations: {},
        recent_events: [],
        conversation_checkpoints: [],
        learned_guidelines: []
    };
}

function normalizeAugustCoreMemory(raw) {
    const defaults = getDefaultAugustCoreMemory();
    const merged = {
        ...defaults,
        ...(raw && typeof raw === 'object' ? raw : {})
    };

    if (typeof merged.user_profile !== 'string') merged.user_profile = defaults.user_profile;
    if (typeof merged.global_context !== 'string') merged.global_context = defaults.global_context;
    if (!Array.isArray(merged.active_projects)) merged.active_projects = [];
    if (!merged.integrations || typeof merged.integrations !== 'object' || Array.isArray(merged.integrations)) merged.integrations = {};
    if (!Array.isArray(merged.recent_events)) merged.recent_events = [];
    if (!Array.isArray(merged.conversation_checkpoints)) merged.conversation_checkpoints = [];
    
    if (!raw || raw.learned_guidelines === undefined) {
        try {
            const semanticMemory = require('./semantic-memory');
            const rules = semanticMemory.getFactsByCategory('workflow_rule');
            if (rules && rules.length > 0) {
                merged.learned_guidelines = rules.map(f => f.value);
            } else {
                merged.learned_guidelines = [];
            }
        } catch (e) {
            merged.learned_guidelines = [];
        }
    } else {
        merged.learned_guidelines = Array.isArray(raw.learned_guidelines) ? raw.learned_guidelines : [];
    }

    merged.active_projects = merged.active_projects
        .filter(p => p && typeof p === 'object' && p.name);
    merged.recent_events = merged.recent_events
        .filter(e => e && typeof e === 'object' && e.summary);
    merged.conversation_checkpoints = merged.conversation_checkpoints
        .filter(c => c && typeof c === 'object' && c.summary);
    merged.learned_guidelines = merged.learned_guidelines
        .map(g => typeof g === 'string' ? g.trim() : String(g).trim())
        .filter(Boolean);

    return merged;
}

function readAugustCoreMemory() {
    if (!fs.existsSync(CORE_MEMORY_FILE)) {
        const defaultMemory = getDefaultAugustCoreMemory();
        fs.writeFileSync(CORE_MEMORY_FILE, JSON.stringify(defaultMemory, null, 2));
        return defaultMemory;
    }
    try {
        return normalizeAugustCoreMemory(JSON.parse(fs.readFileSync(CORE_MEMORY_FILE, 'utf8')));
    } catch (e) {
        return normalizeAugustCoreMemory({ error: "Failed to parse core memory." });
    }
}

function writeAugustCoreMemory(data) {
    fs.writeFileSync(CORE_MEMORY_FILE, JSON.stringify(normalizeAugustCoreMemory(data), null, 2));
}

function renderAugustCoreMemory(memoryInput) {
    const memory = normalizeAugustCoreMemory(memoryInput);
    const projects = memory.active_projects.length > 0
        ? memory.active_projects.map(p => {
            const status = p.status ? ` (${p.status})` : '';
            const summary = p.summary ? `: ${p.summary}` : '';
            return `- ${p.name}${status}${summary}`;
        }).join('\n')
        : '- none recorded';
    const integrations = Object.keys(memory.integrations).length > 0
        ? Object.entries(memory.integrations).map(([name, details]) => {
            if (!details || typeof details !== 'object') return `- ${name}`;
            const status = details.status ? ` (${details.status})` : '';
            const summary = details.summary ? `: ${details.summary}` : '';
            return `- ${name}${status}${summary}`;
        }).join('\n')
        : '- none recorded';
    const recentEvents = memory.recent_events.length > 0
        ? memory.recent_events.map(event => {
            const when = event.timestamp ? `[${event.timestamp}] ` : '';
            return `- ${when}${event.summary}`;
        }).join('\n')
        : '- none recorded';
    const checkpoints = memory.conversation_checkpoints.length > 0
        ? memory.conversation_checkpoints.map(cp => {
            const topic = cp.topic ? `${cp.topic}: ` : '';
            return `- ${topic}${cp.summary}`;
        }).join('\n')
        : '- none recorded';
    const learnedGuidelines = memory.learned_guidelines.length > 0
        ? memory.learned_guidelines.map(g => `- ${g}`).join('\n')
        : '- none recorded';

    return {
        user_profile: memory.user_profile,
        global_context: memory.global_context,
        active_projects: projects,
        integrations,
        recent_events: recentEvents,
        conversation_checkpoints: checkpoints,
        learned_guidelines: learnedGuidelines
    };
}

function upsertProject(memory, project) {
    const normalized = normalizeAugustCoreMemory(memory);
    const nextProject = {
        name: project.name,
        status: project.status || '',
        summary: project.summary || '',
        updated_at: new Date().toISOString()
    };
    const existingIndex = normalized.active_projects.findIndex(p => p.name === project.name);
    if (existingIndex >= 0) normalized.active_projects[existingIndex] = { ...normalized.active_projects[existingIndex], ...nextProject };
    else normalized.active_projects.push(nextProject);
    return normalized;
}

function upsertIntegration(memory, integration) {
    const normalized = normalizeAugustCoreMemory(memory);
    normalized.integrations[integration.name] = {
        status: integration.status || '',
        summary: integration.summary || '',
        updated_at: new Date().toISOString()
    };
    return normalized;
}

function appendRecentEvent(memory, event) {
    const normalized = normalizeAugustCoreMemory(memory);
    normalized.recent_events.push({
        summary: event.summary,
        timestamp: event.timestamp || new Date().toISOString(),
        source: event.source || ''
    });
    return normalized;
}

function appendCheckpoint(memory, checkpoint) {
    const normalized = normalizeAugustCoreMemory(memory);
    normalized.conversation_checkpoints.push({
        topic: checkpoint.topic || '',
        summary: checkpoint.summary,
        timestamp: checkpoint.timestamp || new Date().toISOString()
    });
    return normalized;
}

module.exports = {
    CORE_MEMORY_FILE,
    getDefaultAugustCoreMemory,
    normalizeAugustCoreMemory,
    readAugustCoreMemory,
    writeAugustCoreMemory,
    renderAugustCoreMemory,
    upsertProject,
    upsertIntegration,
    appendRecentEvent,
    appendCheckpoint
};
