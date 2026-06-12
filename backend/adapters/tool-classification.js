const { isProxyManagedLocalToolName } = require('./proxy-tools');

function getToolNameFromOpenAiTool(tool) {
    return tool?.name || tool?.function?.name;
}

function getToolNameFromAnthropicTool(tool) {
    return tool?.name;
}

function isManagedProxyToolName(name, managedLocalToolNames = new Set()) {
    if (!name) return false;
    if (!isProxyManagedLocalToolName(name)) return false;
    if (managedLocalToolNames && managedLocalToolNames.size > 0 && !managedLocalToolNames.has(name)) {
        return false;
    }
    return true;
}

function isClientOwnedToolName(name, clientToolNames = new Set()) {
    return !!name && clientToolNames.has(name);
}

function classifyOpenAiToolCalls(toolCalls, managedLocalToolNames = new Set(), clientToolNames = new Set()) {
    const calls = Array.isArray(toolCalls) ? toolCalls.filter(Boolean) : [];
    const managedToolCalls = [];
    const clientOrUnknownToolCalls = [];

    for (const toolCall of calls) {
        const name = getToolNameFromOpenAiTool(toolCall);
        if (isManagedProxyToolName(name, managedLocalToolNames) && !isClientOwnedToolName(name, clientToolNames)) {
            managedToolCalls.push(toolCall);
        } else {
            clientOrUnknownToolCalls.push(toolCall);
        }
    }

    return {
        toolCalls: calls,
        managedToolCalls,
        clientOrUnknownToolCalls,
        hasManaged: managedToolCalls.length > 0,
        hasClientOrUnknown: clientOrUnknownToolCalls.length > 0,
        canExecuteManaged: managedToolCalls.length > 0 && clientOrUnknownToolCalls.length === 0
    };
}

function classifyAnthropicToolUses(toolUses, managedLocalToolNames = new Set(), clientToolNames = new Set()) {
    const uses = Array.isArray(toolUses) ? toolUses.filter(Boolean) : [];
    const managedToolUses = [];
    const clientOrUnknownToolUses = [];

    for (const toolUse of uses) {
        const name = getToolNameFromAnthropicTool(toolUse);
        if (isManagedProxyToolName(name, managedLocalToolNames) && !isClientOwnedToolName(name, clientToolNames)) {
            managedToolUses.push(toolUse);
        } else {
            clientOrUnknownToolUses.push(toolUse);
        }
    }

    return {
        toolUses: uses,
        managedToolUses,
        clientOrUnknownToolUses,
        hasManaged: managedToolUses.length > 0,
        hasClientOrUnknown: clientOrUnknownToolUses.length > 0,
        canExecuteManaged: managedToolUses.length > 0 && clientOrUnknownToolUses.length === 0
    };
}

module.exports = {
    getToolNameFromOpenAiTool,
    getToolNameFromAnthropicTool,
    classifyOpenAiToolCalls,
    classifyAnthropicToolUses
};
