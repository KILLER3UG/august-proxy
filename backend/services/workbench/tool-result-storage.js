const fs = require('fs');
const path = require('path');

const STORAGE_DIR = path.join(__dirname, '..', '..', '..', 'data', 'tool-results');
const DEFAULT_RESULT_MAX_CHARS = 50000;
const BASH_RESULT_MAX_CHARS = 30000;
const TURN_BUDGET_MAX_CHARS = 200000;

// ── Initialization ──
if (!fs.existsSync(STORAGE_DIR)) {
    try { fs.mkdirSync(STORAGE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

// ── Per-turn budget tracker ──
const turnBudget = { total: 0, idle: true };

function resetTurnBudget() {
    turnBudget.total = 0;
    turnBudget.idle = false;
}

function markTurnComplete() {
    turnBudget.idle = true;
}

function getTurnBudget() {
    return { total: turnBudget.total, remaining: TURN_BUDGET_MAX_CHARS - turnBudget.total };
}

/**
 * Given a tool result string, decide whether to spill it to disk.
 * Returns { content, spilled } where content is either the original
 * or a preview + file-reference, and spilled indicates whether
 * persistence was applied.
 */
function maybePersistResult(toolName, resultText, toolUseId) {
    if (!resultText || typeof resultText !== 'string') {
        return { content: resultText, spilled: false };
    }

    const maxChars = toolName === 'august__bash' ? BASH_RESULT_MAX_CHARS : DEFAULT_RESULT_MAX_CHARS;

    // Initialize turn budget if needed (first tool in a turn)
    if (turnBudget.idle) {
        resetTurnBudget();
    }

    let spillReason = null;

    // Reason 1: individual result exceeds per-tool threshold
    if (resultText.length > maxChars) {
        spillReason = 'per-tool threshold';
    }

    // Reason 2: aggregate turn budget would be exceeded
    if (!spillReason && (turnBudget.total + resultText.length) > TURN_BUDGET_MAX_CHARS) {
        spillReason = 'turn budget exceeded';
    }

    if (!spillReason) {
        turnBudget.total += resultText.length;
        return { content: resultText, spilled: false };
    }

    // Spill to disk
    const storagePath = path.join(STORAGE_DIR, `${toolUseId}.txt`);
    try {
        fs.writeFileSync(storagePath, resultText, 'utf8');
    } catch (e) {
        // If write fails, return original content
        return { content: resultText, spilled: false };
    }

    turnBudget.total += maxChars; // count the preview size toward budget

    const preview = resultText.slice(0, 5000);
    const truncated = resultText.length > 5000;

    const persistedContent = [
        '<persisted-output>',
        `Full output spilled to disk: data/tool-results/${toolUseId}.txt (${resultText.length} chars)`,
        `Use august__read_file to view the complete output.`,
        '</persisted-output>',
        '',
        truncated ? preview + '\n... (truncated, see persisted file for full output)' : preview
    ].join('\n');

    return { content: persistedContent, spilled: true, path: storagePath, originalSize: resultText.length };
}

/**
 * Clean up old persisted results (older than 1 hour).
 */
function cleanOldResults(maxAgeMs = 3600000) {
    try {
        if (!fs.existsSync(STORAGE_DIR)) return;
        const now = Date.now();
        for (const file of fs.readdirSync(STORAGE_DIR)) {
            const filePath = path.join(STORAGE_DIR, file);
            try {
                const stat = fs.statSync(filePath);
                if (now - stat.mtimeMs > maxAgeMs) {
                    fs.unlinkSync(filePath);
                }
            } catch (e) { /* ignore */ }
        }
    } catch (e) { /* ignore */ }
}

module.exports = {
    maybePersistResult,
    resetTurnBudget,
    markTurnComplete,
    getTurnBudget,
    cleanOldResults
};
