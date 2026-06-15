const fs = require('fs');
const path = require('path');

const { getConfig, getProfile } = require('../../lib/config');
const { dataPath } = require('../../lib/data-paths');
const { CORE_MEMORY_FILE, readAugustCoreMemory } = require('./core-memory');
const semanticMemory = require('./semantic-memory');
const { getSupermemorySettings } = require('./supermemory');
const { readVectorEntries } = require('./vector-db');
const { graphStats } = require('./graph-memory');
const { listAgentJobs, getAgentJobsFile } = require('../tools/agent-jobs');

const AUTO_MEMORY_DEBUG_PATH = path.join(__dirname, 'debug.txt');

function statusRank(status) {
    if (status === 'error') return 3;
    if (status === 'warn') return 2;
    return 1;
}

function summarizeChecks(checks) {
    const counts = checks.reduce((acc, check) => {
        acc[check.status] = (acc[check.status] || 0) + 1;
        return acc;
    }, {});
    const overall = checks.some(check => check.status === 'error')
        ? 'error'
        : checks.some(check => check.status === 'warn')
            ? 'warn'
            : 'ok';
    return { overall, counts };
}

function hasUsableSecret(value) {
    if (!value) return false;
    return !/^\$\{env:[^}]+\}$/i.test(String(value));
}

function looksLikeProviderAlias(model) {
    const value = String(model || '').trim().toLowerCase();
    return value.startsWith('claude-') || value.startsWith('gpt-');
}

function getFileInfo(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return {
            exists: true,
            path: filePath,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString()
        };
    } catch (e) {
        return {
            exists: false,
            path: filePath,
            error: e.message
        };
    }
}

function readRecentAutoMemoryLines(limit = 8) {
    try {
        if (!fs.existsSync(AUTO_MEMORY_DEBUG_PATH)) return [];
        const lines = fs.readFileSync(AUTO_MEMORY_DEBUG_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
        return lines.slice(-limit);
    } catch (e) {
        return [`debug log unavailable: ${e.message}`];
    }
}

function sanitizeDiagnosticLogLine(line) {
    let text = String(line || '');
    if (/Raw user message content:/i.test(text)) {
        return text.replace(/Raw user message content:[\s\S]*$/i, 'Raw user message content: [redacted for diagnostics]');
    }
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '[system-reminder removed]');
    text = text.replace(/\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS|PWD)[A-Z0-9_]*)=([^\\\s"',;}]+)/gi, '$1=[redacted]');
    text = text.replace(/("[^"]*(?:key|secret|token|password|pwd)[^"]*"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2');
    text = text.replace(/\\[rnt]/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function getBrainDiagnostics() {
    const config = getConfig();
    const claude = getProfile('claude') || {};
    const vectorEntries = readVectorEntries();
    const semanticFacts = semanticMemory.getAllFacts();
    const memory = readAugustCoreMemory();
    const checkpoints = Array.isArray(memory.conversation_checkpoints) ? memory.conversation_checkpoints : [];
    const supermemory = getSupermemorySettings();
    const graph = graphStats();
    const agentJobs = listAgentJobs({ status: 'all', limit: 100 });
    const autoMemoryLines = readRecentAutoMemoryLines().map(sanitizeDiagnosticLogLine);
    const checks = [];

    const coreInfo = getFileInfo(CORE_MEMORY_FILE);
    checks.push({
        id: 'core-memory-file',
        area: 'memory',
        label: 'August core memory file',
        status: coreInfo.exists ? 'ok' : 'error',
        detail: coreInfo.exists
            ? `${coreInfo.sizeBytes} bytes, ${checkpoints.length} checkpoints.`
            : coreInfo.error || 'Core memory file is missing.',
        action: coreInfo.exists ? '' : 'Create or restore august_core_memory.json.'
    });

    checks.push({
        id: 'semantic-memory',
        area: 'memory',
        label: 'Semantic memory',
        status: semanticFacts.length > 0 ? 'ok' : 'warn',
        detail: `${semanticFacts.length} active facts.`,
        action: semanticFacts.length > 0 ? '' : 'Use August normally or call august__remember for durable facts.'
    });

    checks.push({
        id: 'vector-memory',
        area: 'memory',
        label: 'Infinite vector DB',
        status: vectorEntries.length > 0 ? 'ok' : (checkpoints.length > 0 ? 'warn' : 'ok'),
        detail: `${vectorEntries.length} indexed entries; ${checkpoints.length} core checkpoints available.`,
        action: vectorEntries.length > 0 ? '' : 'Backfill vector entries from core checkpoints or wait for auto-memory fallback.'
    });

    const invalidVectors = vectorEntries.filter(entry => !Array.isArray(entry.embedding) || entry.embedding.length === 0);
    if (invalidVectors.length > 0) {
        checks.push({
            id: 'vector-shape',
            area: 'memory',
            label: 'Vector entry shape',
            status: 'warn',
            detail: `${invalidVectors.length} vector entries had missing embeddings before normalization.`,
            action: 'The local vector DB reader now normalizes missing embeddings on read.'
        });
    }

    checks.push({
        id: 'graph-memory',
        area: 'memory',
        label: 'Local graph memory',
        status: graph.counts.entities > 0 ? 'ok' : 'warn',
        detail: `${graph.counts.entities} entities, ${graph.counts.relations} relations, ${graph.counts.observations} observations.`,
        action: graph.counts.entities > 0 ? '' : 'Run august__graph_index_memory or use August normally to sync memory into the graph.'
    });

    checks.push({
        id: 'agent-jobs',
        area: 'agents',
        label: 'Durable agent jobs',
        status: 'ok',
        detail: `${agentJobs.count || 0} sub-agent jobs recorded.`,
        action: ''
    });

    checks.push({
        id: 'supermemory-config',
        area: 'supermemory',
        label: 'Supermemory API',
        status: supermemory.configured ? 'ok' : 'warn',
        detail: supermemory.configured
            ? `Configured at ${supermemory.baseUrl}.`
            : `Not configured; current base URL would be ${supermemory.baseUrl}.`,
        action: supermemory.configured ? '' : 'Set SUPERMEMORY_API_KEY or save a key from the August Brain tab.'
    });

    const targetUrl = String(claude.targetUrl || '');
    const upstreamModel = claude._upstreamModel || claude.currentModel;
    const dedicatedMemoryModel = config.memoryExtractionModel || config.memoryModel;
    checks.push({
        id: 'auto-memory-model',
        area: 'memory',
        label: 'Auto-memory extraction model',
        status: targetUrl.includes('minimax') && looksLikeProviderAlias(upstreamModel) && !dedicatedMemoryModel ? 'warn' : 'ok',
        detail: targetUrl.includes('minimax') && looksLikeProviderAlias(upstreamModel)
            ? `Profile exposes alias ${upstreamModel}; extraction uses ${dedicatedMemoryModel || upstreamModel || 'auto'}.`
            : `Extraction model source: ${upstreamModel || 'default'}.`,
        action: targetUrl.includes('minimax') && looksLikeProviderAlias(upstreamModel) && !dedicatedMemoryModel
            ? 'The extractor now resolves MiniMax-compatible memory model aliases automatically.'
            : ''
    });

    const recentAutoMemoryErrors = autoMemoryLines.filter(line => /ERROR|WARN|provider error|rate limit|empty content/i.test(line));
    checks.push({
        id: 'auto-memory-log',
        area: 'memory',
        label: 'Auto-memory recent log',
        status: recentAutoMemoryErrors.length > 0 ? 'warn' : 'ok',
        detail: recentAutoMemoryErrors.length > 0
            ? recentAutoMemoryErrors.slice(-2).join(' | ')
            : `${autoMemoryLines.length} recent log lines, no obvious warnings.`,
        action: recentAutoMemoryErrors.length > 0
            ? 'Review provider errors; local fallback keeps checkpoints searchable.'
            : ''
    });

    const summary = summarizeChecks(checks);
    return {
        generatedAt: new Date().toISOString(),
        summary,
        files: {
            core: coreInfo,
            semantic: getFileInfo(dataPath('august_semantic_memory.json')),
            vector: getFileInfo(dataPath('august_infinite_memory.json')),
            graph: getFileInfo(graph.file),
            agentJobs: getFileInfo(getAgentJobsFile())
        },
        counts: {
            coreCheckpoints: checkpoints.length,
            semanticFacts: semanticFacts.length,
            vectorEntries: vectorEntries.length,
            localFallbackVectors: vectorEntries.filter(entry => String(entry.embeddingSource || '').startsWith('local')).length,
            graphEntities: graph.counts.entities,
            graphRelations: graph.counts.relations,
            graphObservations: graph.counts.observations,
            agentJobs: agentJobs.count || 0
        },
        provider: {
            targetUrl: claude.targetUrl || '',
            publicModel: claude.currentModel || '',
            upstreamModel: claude._upstreamModel || '',
            apiKeyConfigured: hasUsableSecret(claude.apiKey)
        },
        supermemory: {
            configured: supermemory.configured,
            baseUrl: supermemory.baseUrl
        },
        recentAutoMemoryLog: autoMemoryLines,
        checks: checks.sort((a, b) => statusRank(b.status) - statusRank(a.status) || a.label.localeCompare(b.label))
    };
}

module.exports = {
    getBrainDiagnostics
};
