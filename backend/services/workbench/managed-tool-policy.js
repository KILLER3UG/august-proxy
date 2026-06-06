const MUTATING_NAME_PATTERN = /write|edit|create|move|rename|delete|remove|install|import|save|set|update|add|forget|remember|bash|command|run|spawn|launch|click|type|focus|clipboard_set|patch|observe|link|index|store|learn/i;
const SAFE_NAME_PATTERN = /read|list|search|fetch|get|describe|diagnose|status|recall|review|scan|preview|find|entities/i;

const SAFE_AUGUST_TOOLS = new Set([
    'august__read_file',
    'august__search_past_conversations',
    'august__recall',
    'august__list_facts',
    'august__review_learned_guidelines',
    'august__graph_recall',
    'august__graph_entities',
    'august__list_agent_jobs',
    'august__get_agent_job',
    'august__find_skill_sources',
    'august__preview_skill_import',
    'august__load_skill',
    'august__scan_brain'
]);

function isSupermemoryRead(args = {}) {
    return ['search', 'list'].includes(String(args.action || '').toLowerCase());
}

function isManagedToolParallelSafe(toolName, args = {}) {
    const name = String(toolName || '');
    if (!name) return false;
    if (name === 'WebSearch' || name === 'WebFetch' || name === 'web_search' || name === 'web_fetch') return true;
    if (name === 'mcp__workspace__web_search' || name === 'mcp__workspace__web_fetch') return true;
    if (name === 'august__supermemory') return isSupermemoryRead(args);
    if (SAFE_AUGUST_TOOLS.has(name)) return true;
    if (name.startsWith('august__')) return false;
    if (name.startsWith('computer_')) return /screenshot|position|screen_size|list_windows|clipboard_get/i.test(name);
    if (name.startsWith('mcp__') || name.startsWith('cowork_') || name.startsWith('mcp__cowork__')) {
        if (MUTATING_NAME_PATTERN.test(name)) return false;
        return SAFE_NAME_PATTERN.test(name);
    }
    if (MUTATING_NAME_PATTERN.test(name)) return false;
    return SAFE_NAME_PATTERN.test(name);
}

function parseOpenAiToolArgs(toolCall) {
    try {
        return JSON.parse(toolCall?.function?.arguments || '{}');
    } catch (_err) {
        return {};
    }
}

function isOpenAiToolCallParallelSafe(toolCall) {
    return isManagedToolParallelSafe(toolCall?.function?.name, parseOpenAiToolArgs(toolCall));
}

function isAnthropicToolUseParallelSafe(toolUse) {
    return isManagedToolParallelSafe(toolUse?.name, toolUse?.input || {});
}

module.exports = {
    isAnthropicToolUseParallelSafe,
    isManagedToolParallelSafe,
    isOpenAiToolCallParallelSafe,
    parseOpenAiToolArgs
};
