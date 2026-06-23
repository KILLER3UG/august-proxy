const { getConfig } = require('../../lib/config');
const { formatFailureHints, recallToolFailures } = require('./tool-failure-memory');

const DEFAULT_FEATURES = {
    enabled: true,
    adaptivePolicy: true,
    failureLearning: true,
    graphMemory: true,
    agentJobs: true,
    hierarchicalAgents: true,
    adapterParallelTools: true,
    parallelReadTools: true,
    reviewLearnedGuidelines: true,
    maxAgentDepth: 4,
    maxWorkbenchToolLoops: 100
};

function getBrainConfig() {
    const cfg = getConfig();
    return {
        ...DEFAULT_FEATURES,
        ...(cfg.brainOrchestrator && typeof cfg.brainOrchestrator === 'object' ? cfg.brainOrchestrator : {})
    };
}

function extractTextFromMessages(messages = []) {
    return (messages || []).slice(-8).map(message => {
        if (typeof message.content === 'string') return message.content;
        if (Array.isArray(message.content)) {
            return message.content.map(block => {
                if (block?.type === 'text') return block.text || '';
                if (block?.type === 'tool_result') return block.content || '';
                if (block?.type === 'tool_use') return `${block.name || ''} ${JSON.stringify(block.input || {})}`;
                return '';
            }).join('\n');
        }
        return '';
    }).filter(Boolean).join('\n');
}

function classifyTask(text) {
    const value = String(text || '').toLowerCase();
    if (/fix|bug|error|failed|failing|crash|debug|diagnose|trace/.test(value)) return 'debug';
    if (/implement|edit|write|change|refactor|patch|create|delete|move|install/.test(value)) return 'code_edit';
    if (/search|research|latest|web|fetch|lookup|source/.test(value)) return 'research';
    if (/remember|memory|recall|what did|last conversation|brain|jarvis/.test(value)) return 'memory_question';
    if (/plan|architecture|design|review|compare|evaluate/.test(value)) return 'planning';
    if (/run command|terminal|powershell|restart|docker|launch/.test(value)) return 'system_control';
    return 'chat';
}

function riskForTask(taskType) {
    if (taskType === 'code_edit' || taskType === 'system_control') return 'approval_required';
    return 'read_only';
}

function policyForTask(taskType, brainConfig) {
    const base = {
        mode: 'normal',
        maxTokens: 2048,
        memoryDepth: 'standard',
        allowParallelReads: brainConfig.parallelReadTools === true,
        allowSubagents: false,
        requirePlan: false,
        requireApproval: false,
        failureRetryLimit: 2
    };

    if (taskType === 'debug') {
        return { ...base, mode: 'debug', maxTokens: 4096, memoryDepth: 'deep', allowSubagents: true, failureRetryLimit: 3 };
    }
    if (taskType === 'code_edit') {
        return { ...base, mode: 'build', maxTokens: 4096, memoryDepth: 'deep', allowSubagents: true, requirePlan: true, requireApproval: true };
    }
    if (taskType === 'research') {
        return { ...base, mode: 'research', maxTokens: 4096, memoryDepth: 'targeted', allowSubagents: true };
    }
    if (taskType === 'memory_question') {
        return { ...base, mode: 'recall', maxTokens: 3072, memoryDepth: 'deep' };
    }
    if (taskType === 'planning') {
        return { ...base, mode: 'plan', maxTokens: 4096, memoryDepth: 'deep', allowSubagents: true };
    }
    if (taskType === 'system_control') {
        return { ...base, mode: 'system-control', maxTokens: 3072, memoryDepth: 'standard', requirePlan: true, requireApproval: true };
    }
    return base;
}

function inferMemoryQuery(text, taskType) {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    if (taskType === 'chat') return '';
    return compact.slice(-500);
}

function buildBrainSystemAdditions({ taskType, riskLevel, executionPolicy, failureHints }) {
    const lines = [
        '<brain_orchestrator>',
        `Task type: ${taskType}`,
        `Risk level: ${riskLevel}`,
        `Mode: ${executionPolicy.mode}`,
        `Memory depth: ${executionPolicy.memoryDepth}`,
        `Parallel read-only tools: ${executionPolicy.allowParallelReads ? 'allowed' : 'disabled'}`,
        `Plan required: ${executionPolicy.requirePlan ? 'yes' : 'no'}`,
        `Approval required for mutation: ${executionPolicy.requireApproval ? 'yes' : 'no'}`,
        failureHints ? `\n${failureHints}` : '',
        '</brain_orchestrator>'
    ];
    return lines.filter(Boolean).join('\n');
}

function planBrainTurn({ messages = [], provider = 'claude', model = '', session = null, requestKind = 'workbench' } = {}) {
    const brainConfig = getBrainConfig();
    const text = extractTextFromMessages(messages);
    const taskType = classifyTask(text);
    const riskLevel = riskForTask(taskType);
    const executionPolicy = policyForTask(taskType, brainConfig);
    const memoryQuery = inferMemoryQuery(text, taskType);
    const failureHints = brainConfig.failureLearning
        ? formatFailureHints(recallToolFailures({ limit: 4 }))
        : '';

    return {
        enabled: brainConfig.enabled !== false,
        provider,
        model,
        requestKind,
        sessionId: session?.id || null,
        taskType,
        riskLevel,
        memoryQuery,
        executionPolicy,
        failureHints,
        systemAdditions: buildBrainSystemAdditions({ taskType, riskLevel, executionPolicy, failureHints })
    };
}

function getWorkbenchMaxToolLoops() {
    const brainConfig = getBrainConfig();
    const value = Number(brainConfig.maxWorkbenchToolLoops || DEFAULT_FEATURES.maxWorkbenchToolLoops);
    return Number.isFinite(value) && value > 0 ? Math.min(value, 500) : DEFAULT_FEATURES.maxWorkbenchToolLoops;
}

/**
 * Source resolution for the Brain Settings page.
 *
 *   - 'persisted' — the user has saved a `cfg.brainOrchestrator` block;
 *                   return it verbatim.
 *   - 'session'   — the user hasn't persisted anything, but they have at
 *                   least one chat session. We run `planBrainTurn` on that
 *                   session's most-recent message and project its
 *                   `executionPolicy` onto the `DEFAULT_FEATURES` keys.
 *   - 'fallback'  — no persisted config and no session; return
 *                   `DEFAULT_FEATURES`.
 *
 * The returned `config` always contains the same keys as `DEFAULT_FEATURES`
 * so the form can render without conditionally checking each input.
 */
function getBrainConfigForSettings({ sessionId = null, plan = null } = {}) {
    const cfg = getConfig();
    const persisted = cfg.brainOrchestrator;
    if (persisted && typeof persisted === 'object' && Object.keys(persisted).length > 0) {
        return { source: 'persisted', config: { ...DEFAULT_FEATURES, ...persisted }, defaults: DEFAULT_FEATURES };
    }

    let sessionPlan = plan;
    if (!sessionPlan && sessionId) {
        sessionPlan = planBrainTurn({ session: { id: sessionId }, provider: 'claude', model: '', requestKind: 'settings' });
    }

    if (sessionPlan && sessionPlan.executionPolicy) {
        const p = sessionPlan.executionPolicy;
        const projected = {
            enabled: true,
            adaptivePolicy: true,
            failureLearning: p.failureRetryLimit > 0,
            graphMemory: p.memoryDepth !== 'targeted',
            agentJobs: true,
            hierarchicalAgents: !!p.allowSubagents,
            adapterParallelTools: true,
            parallelReadTools: !!p.allowParallelReads,
            reviewLearnedGuidelines: true,
            maxAgentDepth: Number(p.maxSubagentDepth) > 0 ? Number(p.maxSubagentDepth) : DEFAULT_FEATURES.maxAgentDepth,
            maxWorkbenchToolLoops: Number(p.maxTokens) > 0 ? Math.max(1, Math.min(100, Math.round(Number(p.maxTokens) / 1000))) : DEFAULT_FEATURES.maxWorkbenchToolLoops
        };
        return { source: 'session', config: projected, defaults: DEFAULT_FEATURES, sessionId };
    }

    return { source: 'fallback', config: { ...DEFAULT_FEATURES }, defaults: DEFAULT_FEATURES };
}

/**
 * Persist a partial brain-orchestrator config update. Unknown keys are
 * rejected (HTTP 400); numeric ranges are clamped. Returns the merged
 * config that ends up on disk.
 */
function saveBrainConfig(updates = {}) {
    const cfg = getConfig();
    if (!updates || typeof updates !== 'object') {
        throw new Error('updates must be an object');
    }
    const allowed = new Set(Object.keys(DEFAULT_FEATURES));
    const merged = { ...DEFAULT_FEATURES, ...(cfg.brainOrchestrator || {}) };

    for (const [key, value] of Object.entries(updates)) {
        if (!allowed.has(key)) {
            const err = new Error(`Unknown brain config key: ${key}`);
            err.code = 'EBRAIN_UNKNOWN_KEY';
            throw err;
        }
        if (typeof value === 'boolean') {
            merged[key] = !!value;
            continue;
        }
        if (typeof value === 'number') {
            if (key === 'maxAgentDepth') {
                merged[key] = Math.max(1, Math.min(5, Math.round(value)));
            } else if (key === 'maxWorkbenchToolLoops') {
                merged[key] = Math.max(1, Math.min(500, Math.round(value)));
            } else {
                merged[key] = value;
            }
            continue;
        }
        merged[key] = value;
    }

    cfg.brainOrchestrator = merged;
    const { saveConfig } = require('../../lib/config');
    saveConfig(cfg);
    return merged;
}

function resetBrainConfig() {
    const cfg = getConfig();
    if (cfg.brainOrchestrator) {
        delete cfg.brainOrchestrator;
        const { saveConfig } = require('../../lib/config');
        saveConfig(cfg);
    }
    return { ...DEFAULT_FEATURES };
}

module.exports = {
    classifyTask,
    DEFAULT_FEATURES,
    getBrainConfig,
    getBrainConfigForSettings,
    getWorkbenchMaxToolLoops,
    planBrainTurn,
    policyForTask,
    resetBrainConfig,
    saveBrainConfig
};
