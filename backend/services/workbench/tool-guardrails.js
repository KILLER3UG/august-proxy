const crypto = require('crypto');

/**
 * Parameters hash — deterministic fingerprint for tool call identity.
 */
function hashParams(toolName, args) {
    const normal = {};
    if (args && typeof args === 'object') {
        const keys = Object.keys(args).sort();
        for (const k of keys) {
            const v = args[k];
            if (k === 'confirmed' || k === 'bypassConfirmation') continue;
            if (typeof v === 'string') normal[k] = v.slice(0, 200);
            else if (v !== undefined && v !== null) normal[k] = v;
        }
    }
    return crypto.createHash('md5').update(JSON.stringify([toolName, normal])).digest('hex').slice(0, 12);
}

class ToolCallTracker {
    constructor() {
        this.reset();
    }

    /**
     * Called when the model produces a text-only response (no tool calls).
     * This ends the current tool-call sequence.
     */
    markTextResponse() {
        this.sequenceEnded = true;
    }

    /**
     * Before executing a tool, call check() to see if guardrails fire.
     *
     * Returns:
     *   { allowed: true } — proceed normally
     *   { allowed: true, warning: '...' } — proceed with a warning
     *   { allowed: false, reason: '...' } — block execution, inject this as the result
     */
    check(toolName, args) {
        // Start of a new sequence? Reset tracking.
        if (this.sequenceEnded) {
            this.reset();
        }

        const hash = hashParams(toolName, args);
        const now = Date.now();

        // Track this call
        this.calls.push({ toolName, hash, args, time: now });

        // Count: identical tool + identical params
        const identicalCalls = this.calls.filter(c => c.toolName === toolName && c.hash === hash);
        const sameToolCalls = this.calls.filter(c => c.toolName === toolName);

        // Track failures separately
        const toolFailures = this.failures.filter(f => f.toolName === toolName);
        const totalFailures = this.failures.filter(f => f.toolName === toolName && hashParams(f.toolName, f.args) === hash);

        // Guardrail 1: Identical call loop (same tool, same params — stuck in a loop)
        if (identicalCalls.length >= 6) {
            return {
                allowed: false,
                reason: `[Guardrail: Loop Blocked] You've called ${toolName} with identical parameters ${identicalCalls.length} times in a row. This appears to be stuck in a loop. Please re-read the previous results and take a different approach. You may need to read the file first, or adjust your parameters.`
            };
        }
        if (identicalCalls.length >= 3) {
            return {
                allowed: true,
                warning: `[Guardrail: Loop Warning] You've called ${toolName} with the same parameters ${identicalCalls.length} times. If this doesn't resolve your task, you're in a loop. Consider a different approach.`
            };
        }

        // Guardrail 2: Same-tool failure loop (tool keeps erroring)
        if (toolFailures.length >= 8) {
            return {
                allowed: false,
                reason: `[Guardrail: Failure Blocked] ${toolName} has errored ${toolFailures.length} times this turn. Something fundamental is wrong. Re-think your approach before trying again.`
            };
        }
        if (toolFailures.length >= 4) {
            return {
                allowed: true,
                warning: `[Guardrail: Failure Warning] ${toolName} has errored ${toolFailures.length} times. Check your parameters or file paths.`
            };
        }

        return { allowed: true };
    }

    /**
     * Report a tool execution failure.
     */
    recordFailure(toolName, args, error) {
        this.failures.push({ toolName, args, error, time: Date.now() });
    }

    /**
     * Reset per-sequence state (called when text-only response appears).
     */
    reset() {
        this.calls = [];
        this.failures = [];
        this.sequenceEnded = false;
    }
}

// Singleton — one tracker per proxy process
const tracker = new ToolCallTracker();

module.exports = {
    tracker,
    hashParams
};
