const { getConfig, getProfile } = require('../../lib/config');
const { buildSystemPromptDetails, DEFAULT_CONTEXT_MAX_CHARS } = require('../memory/context-builder');
const { getCompatibilityStatus } = require('./compatibility');
const { getMcpServersForUi } = require('../tools/mcp-registry');
const { getMcpServerStatus } = require('../tools/mcp-client');
const { getPlugins } = require('../tools/plugins');
const { getSkills } = require('../tools/skills');
const { getBrainDiagnostics } = require('../memory/brain-diagnostics');

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
    return !/^\$\{env:[^}]+\}$/.test(String(value));
}

function getCapabilityHealth() {
    const config = getConfig();
    const claude = getProfile('claude') || {};
    const codex = getProfile('codex') || {};
    const mcpServers = getMcpServersForUi();
    const mcpStatus = getMcpServerStatus();
    const statusByName = new Map(mcpStatus.map(item => [item.name, item]));
    const plugins = getPlugins();
    const skills = getSkills();
    const compatibility = getCompatibilityStatus();
    const brain = getBrainDiagnostics();
    const contextMaxChars = Number(config.memoryContextMaxChars || DEFAULT_CONTEXT_MAX_CHARS);
    const promptDetails = buildSystemPromptDetails(null, {
        model: claude._upstreamModel || claude.currentModel,
        targetUrl: claude.targetUrl,
        includeWindowsContext: false,
        contextMaxChars
    });

    const checks = [];
    [
        ['claude', claude],
        ['codex', codex]
    ].forEach(([name, profile]) => {
        checks.push({
            id: `profile-${name}`,
            area: 'providers',
            label: `${name} profile`,
            status: profile.targetUrl && hasUsableSecret(profile.apiKey) ? 'ok' : 'warn',
            detail: profile.targetUrl
                ? `${profile.currentModel || 'unknown model'} through ${profile.targetUrl}`
                : 'Missing target URL.',
            action: hasUsableSecret(profile.apiKey) ? '' : 'Check the API key environment variable before live calls.'
        });
    });

    mcpServers.forEach(server => {
        const live = statusByName.get(server.name);
        const status = server.enabled === false
            ? 'warn'
            : live?.status === 'error'
                ? 'error'
                : 'ok';
        checks.push({
            id: `mcp-${server.name}`,
            area: 'mcp',
            label: `${server.name} MCP`,
            status,
            detail: server.enabled === false
                ? 'Configured but disabled.'
                : live?.error || `${live?.toolCount || 0} tools visible.`,
            action: server.enabled === false ? 'Enable it from MCP & Skills when needed.' : ''
        });
    });

    const brainContext = promptDetails?.globalContext;
    checks.push({
        id: 'august-brain',
        area: 'memory',
        label: 'August Brain injection',
        status: brainContext?.compacted ? 'warn' : 'ok',
        detail: brainContext?.compacted
            ? `Compacted ${brainContext.fullLength} to ${brainContext.finalLength} chars.`
            : brainContext ? `${brainContext.finalLength} chars injected.` : 'Not initialized yet.',
        action: brainContext?.compacted ? 'Review lifecycle pins or raise the Brain Limit if needed.' : ''
    });

    brain.checks
        .filter(check => ['semantic-memory', 'vector-memory', 'supermemory-config', 'auto-memory-log'].includes(check.id))
        .forEach(check => checks.push(check));

    checks.push({
        id: 'plugins',
        area: 'plugins',
        label: 'Proxy plugins',
        status: plugins.some(plugin => plugin.enabled === false) ? 'warn' : 'ok',
        detail: `${plugins.filter(plugin => plugin.enabled !== false).length}/${plugins.length} enabled, ${skills.length} skills available.`,
        action: plugins.length ? 'Use the plugin catalog controls to update or disable imports.' : 'Import capability links from MCP & Skills.'
    });

    const summary = summarizeChecks(checks);
    return {
        generatedAt: new Date().toISOString(),
        summary,
        cards: [
            { label: 'Overall', value: summary.overall, status: summary.overall },
            { label: 'Enabled MCP', value: mcpServers.filter(server => server.enabled !== false).length, status: 'ok' },
            { label: 'Proxy Plugins', value: plugins.length, status: plugins.length ? 'ok' : 'warn' },
            { label: 'Brain Limit', value: contextMaxChars, status: promptDetails?.globalContext?.compacted ? 'warn' : 'ok' },
            { label: 'Vector DB', value: brain.counts.vectorEntries, status: brain.counts.vectorEntries ? 'ok' : 'warn' },
            { label: 'Semantic Facts', value: brain.counts.semanticFacts, status: brain.counts.semanticFacts ? 'ok' : 'warn' }
        ],
        checks: checks.sort((a, b) => statusRank(b.status) - statusRank(a.status) || a.label.localeCompare(b.label)),
        compatibility,
        brain
    };
}

module.exports = {
    getCapabilityHealth
};
