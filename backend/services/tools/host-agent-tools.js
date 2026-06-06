const hostAgent = require('../../lib/host-agent');

const HOST_AGENT_TOOL_NAMES = new Set([
    'computer_screenshot', 'computer_mouse_move', 'computer_mouse_click',
    'computer_mouse_double_click', 'computer_mouse_right_click',
    'computer_mouse_position', 'computer_screen_size',
    'computer_type', 'computer_key',
    'computer_list_windows', 'computer_focus_window', 'computer_launch',
    'computer_open_browser', 'computer_close_browser',
    'computer_clipboard_get', 'computer_clipboard_set'
]);

function isHostAgentToolName(name) {
    return typeof name === 'string' && HOST_AGENT_TOOL_NAMES.has(name);
}

// Tools that are read-only and need no confirmation
// Must stay aligned with SAFE_COMPUTER_TOOLS in workbench.js:370
const READ_ONLY_HOST_AGENT_TOOLS = new Set([
    'computer_screenshot', 'computer_screen_size', 'computer_mouse_move',
    'computer_mouse_position', 'computer_list_windows', 'computer_clipboard_get'
]);

function requiresHostAgentConfirmation(toolName) {
    return isHostAgentToolName(toolName) && !READ_ONLY_HOST_AGENT_TOOLS.has(toolName);
}

// Toggle state — controlled by UI and REST API
let _enabled = true;

function setHostAgentEnabled(state) {
    _enabled = state;
}

function isHostAgentEnabled() {
    return _enabled;
}

function getHostAgentAnthropicToolDefinitions() {
    if (!_enabled) return [];
    return hostAgent.toolDefinitions();
}

function getHostAgentOpenAiToolDefinitions() {
    if (!_enabled) return [];
    return hostAgent.toolDefinitions().map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema
        }
    }));
}

module.exports = {
    HOST_AGENT_TOOL_NAMES,
    isHostAgentToolName,
    requiresHostAgentConfirmation,
    setHostAgentEnabled,
    isHostAgentEnabled,
    getHostAgentAnthropicToolDefinitions,
    getHostAgentOpenAiToolDefinitions
};
