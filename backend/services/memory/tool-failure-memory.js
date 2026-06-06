const fs = require('fs');
const path = require('path');

const DEFAULT_FAILURE_FILE = path.join(__dirname, '..', '..', 'data', 'august_tool_failures.json');
const MAX_FAILURES = 300;

const IGNORED_PATTERNS = [
    /WORKBENCH APPROVAL GATE/i,
    /AGENT PERMISSION GUARD/i,
    /user approval/i,
    /approval/i
];

function getFailureMemoryFile() {
    return process.env.AUGUST_TOOL_FAILURE_FILE || DEFAULT_FAILURE_FILE;
}

function readFailureMemory() {
    const filePath = getFailureMemoryFile();
    if (!fs.existsSync(filePath)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function writeFailureMemory(entries) {
    const filePath = getFailureMemoryFile();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(entries.slice(-MAX_FAILURES), null, 2));
}

function normalizeError(error) {
    const text = error instanceof Error ? error.message : String(error || '');
    return text
        .replace(/C:\\Users\\[^\\\s]+/gi, 'C:\\Users\\<user>')
        .replace(/[A-Fa-f0-9]{24,}/g, '<hex>')
        .replace(/\b\d{4,}\b/g, '<num>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
}

function shouldIgnoreFailure(error) {
    const text = normalizeError(error);
    return !text || IGNORED_PATTERNS.some(pattern => pattern.test(text));
}

function argsShape(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
    return Object.keys(args).sort();
}

function classifyEnvironment(extra = {}) {
    return [
        extra.provider || '',
        extra.agentId || '',
        extra.phase || '',
        process.platform === 'win32' ? 'windows' : process.platform
    ].filter(Boolean).join('|') || 'unknown';
}

function buildFailureSignature({ toolName, args, error, environment } = {}) {
    const normalizedTool = String(toolName || 'unknown').trim();
    const normalizedError = normalizeError(error).toLowerCase();
    const shape = argsShape(args).join(',');
    const env = String(environment || 'unknown').toLowerCase();
    return `${normalizedTool}|${normalizedError}|${shape}|${env}`;
}

function defaultFixForFailure(toolName, error, args = {}) {
    const name = String(toolName || '');
    const message = normalizeError(error).toLowerCase();
    if (/webfetch|web_fetch|workspace__web_fetch/i.test(name) && args.prompt && !args.url) {
        return 'Map stale prompt input to url before validation and execution.';
    }
    if (/websearch|web_search|workspace__web_search/i.test(name) && args.prompt && !args.query) {
        return 'Map stale prompt input to query before validation and execution.';
    }
    if (/not recognized|command not found|cannot find path/i.test(message)) {
        return 'Run a small diagnostic first, verify the path or command exists, then retry with the corrected PowerShell command.';
    }
    if (/missing required argument|missing required parameter|required parameter/i.test(message)) {
        return 'Compare the tool call against the current schema and retry with every required argument present.';
    }
    if (/json/i.test(message) && /argument|parse|valid/i.test(message)) {
        return 'Retry with strict JSON arguments only; do not include comments or prose in the argument payload.';
    }
    return '';
}

function recordToolFailure({ toolName, args = {}, error, successfulFix = '', environment, phase, provider, agentId } = {}) {
    if (shouldIgnoreFailure(error)) return null;
    const env = environment || classifyEnvironment({ phase, provider, agentId });
    const signature = buildFailureSignature({ toolName, args, error, environment: env });
    const entries = readFailureMemory();
    const now = new Date().toISOString();
    const existing = entries.find(entry => entry.signature === signature);
    const normalizedError = normalizeError(error);
    const fix = successfulFix || defaultFixForFailure(toolName, normalizedError, args);

    if (existing) {
        existing.count = Number(existing.count || 0) + 1;
        existing.lastSeen = now;
        existing.lastArgsShape = argsShape(args);
        if (fix && !existing.successfulFix) existing.successfulFix = fix;
        writeFailureMemory(entries);
        return existing;
    }

    const entry = {
        signature,
        tool: String(toolName || 'unknown'),
        errorPattern: normalizedError,
        lastArgsShape: argsShape(args),
        successfulFix: fix,
        environment: env,
        status: 'active',
        count: 1,
        firstSeen: now,
        lastSeen: now
    };
    entries.push(entry);
    writeFailureMemory(entries);
    return entry;
}

function scoreFailure(entry, { toolName, error, args } = {}) {
    let score = 0;
    const tool = String(toolName || '').toLowerCase();
    if (tool && String(entry.tool || '').toLowerCase() === tool) score += 4;
    const normalizedError = normalizeError(error).toLowerCase();
    if (normalizedError && String(entry.errorPattern || '').toLowerCase().includes(normalizedError.slice(0, 60))) score += 3;
    const shape = argsShape(args);
    if (shape.length && Array.isArray(entry.lastArgsShape)) {
        const overlap = shape.filter(key => entry.lastArgsShape.includes(key)).length;
        score += overlap;
    }
    score += Math.min(Number(entry.count || 0), 5) / 5;
    return score;
}

function recallToolFailures({ toolName, error, args = {}, limit = 5 } = {}) {
    return readFailureMemory()
        .filter(entry => entry.status !== 'archived' && entry.status !== 'rejected')
        .map(entry => ({ ...entry, score: scoreFailure(entry, { toolName, error, args }) }))
        .filter(entry => entry.score > 0 || !toolName)
        .sort((a, b) => b.score - a.score || new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0))
        .slice(0, limit);
}

function formatFailureHints(entries) {
    const active = (entries || []).filter(entry => entry && (entry.successfulFix || entry.errorPattern));
    if (!active.length) return '';
    return [
        'Known tool failure corrections:',
        ...active.map(entry => {
            const fix = entry.successfulFix || 'Inspect the current schema, run a smaller diagnostic, and retry.';
            return `- ${entry.tool}: ${entry.errorPattern} -> ${fix}`;
        })
    ].join('\n');
}

function clearFailureMemory() {
    writeFailureMemory([]);
}

module.exports = {
    buildFailureSignature,
    clearFailureMemory,
    defaultFixForFailure,
    formatFailureHints,
    getFailureMemoryFile,
    normalizeError,
    readFailureMemory,
    recallToolFailures,
    recordToolFailure,
    shouldIgnoreFailure,
    writeFailureMemory
};
