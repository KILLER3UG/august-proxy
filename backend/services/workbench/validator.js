// ── Tool call argument validator ──
// Validates tool call arguments against the tool's JSON schema BEFORE execution.
// When invalid, returns a structured error message that can be fed back to the
// model as a tool result, triggering M2.7's self-correction loop.

function recordValidationFailure(toolName, args, error) {
    try {
        const { recordToolFailure } = require('../memory/tool-failure-memory');
        recordToolFailure({ toolName, args, error, phase: 'validation' });
    } catch (e) {
        // Failure learning is advisory and must never block validation.
    }
}

function validationFailure(toolName, args, error) {
    recordValidationFailure(toolName, args, error);
    return { valid: false, error };
}

function validateToolArguments(toolCall, toolDefinitions, messages = []) {
    const toolName = toolCall?.function?.name;
    if (!toolName) return { valid: false, error: 'Tool call is missing a function name.' };

    const tool = toolDefinitions?.find(t =>
        (t.function?.name || t.name) === toolName
    );
    if (!tool) return { valid: true }; // unknown tool — can't validate, pass through

    const schema = tool.function?.parameters || tool.input_schema;
    if (!schema) return { valid: true }; // no schema to validate against

    let args;
    try {
        args = JSON.parse(toolCall.function?.arguments || '{}');
    } catch (e) {
        return validationFailure(
            toolName,
            {},
            `Tool arguments for '${toolName}' are not valid JSON: ${e.message}. ` +
            `Arguments received: ${toolCall.function?.arguments}`
        );
    }

    // Compatibility shim for stale WebFetch/WebSearch tool schemas seen by some
    // third-party Claude clients. If the model sends `prompt` instead of the
    // proxy's canonical `url` / `query`, normalize it before schema checks.
    if (toolName === 'WebFetch' || toolName === 'web_fetch' || toolName === 'mcp__workspace__web_fetch') {
        if ((args.url === undefined || args.url === null || args.url === '') && typeof args.prompt === 'string' && args.prompt.trim()) {
            args.url = args.prompt.trim();
        }
    }
    if (toolName === 'WebSearch' || toolName === 'web_search' || toolName === 'mcp__workspace__web_search') {
        if ((args.query === undefined || args.query === null || args.query === '') && typeof args.prompt === 'string' && args.prompt.trim()) {
            args.query = args.prompt.trim();
        }
    }

    // ── The Proxy Execution Gate (Plan check) ──
    // Block code generation / file writes if a plan hasn't been formally established
    const mutatingTools = [
        'StrReplaceEditTool', 'BashTool',
        'mcp__filesystem__write_file', 'mcp__filesystem__create_directory', 
        'mcp__filesystem__move_file', 'mcp__filesystem__edit_file',
        'mcp__bash__execute_command', 'mcp__google_drive__write_file'
    ];
    if (mutatingTools.includes(toolName)) {
        // Check if plan.md exists anywhere in the conversation history
        const hasPlanned = messages.some(m => {
            if (typeof m.content === 'string') return m.content.toLowerCase().includes('plan.md');
            if (Array.isArray(m.content)) {
                return m.content.some(c => 
                    (typeof c.text === 'string' && c.text.toLowerCase().includes('plan.md')) ||
                    (c.type === 'tool_result' && typeof c.content === 'string' && c.content.toLowerCase().includes('plan.md')) ||
                    (c.type === 'tool_use' && JSON.stringify(c.input || {}).toLowerCase().includes('plan.md'))
                );
            }
            return false;
        });

        if (!hasPlanned) {
            return validationFailure(
                toolName,
                args,
                `PROXY GATE BLOCKED EXECUTION: You attempted to use a mutating tool ('${toolName}') without first establishing a plan.md file. You MUST read or write plan.md to solidify your architecture before executing code changes. This is a hard rule.`
            );
        }
    }

    // Check required fields from the schema
    const required = schema.required || [];
    const missing = required.filter(field => !(field in args));
    if (missing.length > 0) {
        const paramDescriptions = schema.properties
            ? missing.map(f => {
                const def = schema.properties[f];
                return `'${f}' (${def?.type || 'any'}${def?.description ? ': ' + def.description : ''})`;
            }).join(', ')
            : missing.join(', ');
        return validationFailure(
            toolName,
            args,
            `Missing required argument(s) for '${toolName}': ${paramDescriptions}. ` +
            `All required fields: ${required.join(', ')}.`
        );
    }

    // Check for unknown properties if schema has additionalProperties: false
    if (schema.additionalProperties === false && schema.properties) {
        const allowed = Object.keys(schema.properties);
        const unknown = Object.keys(args).filter(k => !allowed.includes(k));
        if (unknown.length > 0) {
            return validationFailure(
                toolName,
                args,
                `Unknown argument(s) for '${toolName}': ${unknown.join(', ')}. ` +
                `Allowed fields: ${allowed.join(', ')}.`
            );
        }
    }

    return { valid: true };
}

function buildValidationErrorToolMessage(toolCallId, toolName, errorMsg) {
    return {
        role: 'tool',
        tool_call_id: toolCallId,
        content: `[Validation Error] Tool call to '${toolName}' was rejected before execution:\n` +
                 `${errorMsg}\n\n` +
                 `[Proxy Self-Heal]: Fix the tool call arguments and retry. ` +
                 `Read the schema description above carefully. Do NOT stop.`
    };
}

module.exports = { validateToolArguments, buildValidationErrorToolMessage };
