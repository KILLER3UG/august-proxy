const { getSystemStats } = require('../../lib/system-stats');
const { getConfig, getProfile } = require('../../lib/config');
const { getCapabilityHealth } = require('./health');
const { getBrainDiagnostics } = require('../memory/brain-diagnostics');
const { getMcpServerStatus } = require('../tools/mcp-client');
const { getStats, getRequestLog, getPendingRequests } = require('../../lib/logger');

const DIAGNOSE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let latestReport = null;
let schedulerHandle = null;

function startScheduler() {
    runDiagnostic();
    schedulerHandle = setInterval(runDiagnostic, DIAGNOSE_INTERVAL_MS);
    console.log('[ProxyAI] Scheduler started (every 4h)');
}

function stopScheduler() {
    if (schedulerHandle) {
        clearInterval(schedulerHandle);
        schedulerHandle = null;
    }
}

function getReport() {
    return latestReport;
}

async function runDiagnostic() {
    try {
        const startedAt = new Date().toISOString();
        const categories = [];

        // ── Category 1: Provider Health ──
        const providerChecks = await runProviderChecks();
        categories.push({ name: 'Provider Health', checks: providerChecks });

        // ── Category 2: System Health ──
        const systemChecks = runSystemChecks();
        categories.push({ name: 'System Health', checks: systemChecks });

        // ── Category 3: Request Health ──
        const requestChecks = runRequestChecks();
        categories.push({ name: 'Request Health', checks: requestChecks });

        // ── Category 4: MCP Health ──
        const mcpChecks = await runMCPChecks();
        categories.push({ name: 'MCP Health', checks: mcpChecks });

        // ── Category 5: Memory Health ──
        const memoryChecks = await runMemoryChecks();
        categories.push({ name: 'Memory Health', checks: memoryChecks });

        // ── Category 6: Config Health ──
        const configChecks = runConfigChecks();
        categories.push({ name: 'Config Health', checks: configChecks });

        // ── Summary ──
        let total = 0, ok = 0, warn = 0, error = 0;
        categories.forEach(cat => {
            cat.checks.forEach(check => {
                total++;
                if (check.status === 'ok') ok++;
                else if (check.status === 'warn') warn++;
                else error++;
            });
            cat.count = cat.checks.length;
            cat.ok = cat.checks.filter(c => c.status === 'ok').length;
            cat.warn = cat.checks.filter(c => c.status === 'warn').length;
            cat.error = cat.checks.filter(c => c.status === 'error').length;
        });

        latestReport = {
            generatedAt: startedAt,
            lastRun: startedAt,
            nextRun: new Date(Date.now() + DIAGNOSE_INTERVAL_MS).toISOString(),
            summary: { total, ok, warn, error },
            categories,
            systemStats: getSystemStats()
        };
        console.log(`[ProxyAI] Diagnostic complete: ${ok}/${total} ok, ${warn} warn, ${error} error`);
    } catch (e) {
        console.error('[ProxyAI] Diagnostic failed:', e.message);
        latestReport = {
            generatedAt: new Date().toISOString(),
            lastRun: new Date().toISOString(),
            nextRun: new Date(Date.now() + DIAGNOSE_INTERVAL_MS).toISOString(),
            summary: { total: 0, ok: 0, warn: 0, error: 1 },
            categories: [],
            error: e.message
        };
    }
    return latestReport;
}

async function runProviderChecks() {
    const checks = [];
    const claude = getProfile('claude') || {};
    const codex = getProfile('codex') || {};
    const config = getConfig();
    const autoProv = config.automationProvider || {};

    checks.push({
        name: 'Claude target URL',
        status: claude.targetUrl ? 'ok' : 'warn',
        message: claude.targetUrl || 'Not configured'
    });
    const claudeKeyOk = claude.apiKey && !claude.apiKey.startsWith('${env:');
    checks.push({
        name: 'Claude API key',
        status: claudeKeyOk ? 'ok' : 'warn',
        message: claudeKeyOk ? 'Resolved' : 'Missing or placeholder'
    });
    checks.push({
        name: 'Codex target URL',
        status: codex.targetUrl ? 'ok' : 'warn',
        message: codex.targetUrl || 'Not configured (falls back to Claude)'
    });
    const codexKeyOk = !codex.apiKey || (codex.apiKey && !codex.apiKey.startsWith('${env:'));
    checks.push({
        name: 'Codex API key',
        status: codexKeyOk ? 'ok' : 'warn',
        message: codexKeyOk ? 'Resolved' : 'Placeholder not resolved'
    });
    const autoUrlOk = autoProv.url ? 'ok' : 'skip';
    if (autoUrlOk === 'ok') {
        const autoKeyOk = !autoProv.apiKey || (autoProv.apiKey && !autoProv.apiKey.startsWith('${env:'));
        checks.push({
            name: 'Automation Provider URL',
            status: 'ok',
            message: autoProv.url
        });
        checks.push({
            name: 'Automation Provider key',
            status: autoKeyOk ? 'ok' : 'warn',
            message: autoKeyOk ? 'Resolved' : 'Placeholder not resolved'
        });
    } else {
        checks.push({
            name: 'Automation Provider',
            status: 'skip',
            message: 'Not configured'
        });
    }
    return checks;
}

function runSystemChecks() {
    const stats = getSystemStats();
    const checks = [];
    checks.push({
        name: 'Uptime',
        status: stats.uptime > 60 ? 'ok' : 'warn',
        message: stats.uptimeHuman
    });
    checks.push({
        name: 'Memory usage',
        status: stats.memory.usagePercent < 80 ? 'ok' : (stats.memory.usagePercent < 90 ? 'warn' : 'error'),
        message: stats.memory.usagePercent + '% (' + stats.memory.rss + 'MB RSS / ' + stats.memory.totalSystem + 'MB total)'
    });
    const nodeMajor = parseInt(process.version.replace('v', '').split('.')[0], 10);
    checks.push({
        name: 'Node.js version',
        status: nodeMajor >= 18 ? 'ok' : 'warn',
        message: process.version
    });
    checks.push({
        name: 'Platform',
        status: 'ok',
        message: process.platform + ' ' + process.arch
    });
    return checks;
}

function runRequestChecks() {
    const checks = [];
    const stats = getStats('all');
    const pending = getPendingRequests();
    const requests = getRequestLog() || [];
    const recent = requests.slice(0, 100);
    const recentReqs = recent.filter(r => r.status !== 'unknown');
    const errorCount = recentReqs.filter(r => r.status === 'error').length;
    const totalRecent = recentReqs.length;
    const errorRate = totalRecent > 0 ? (errorCount / totalRecent) * 100 : 0;
    const avgDuration = totalRecent > 0
        ? Math.round(recentReqs.reduce((sum, r) => sum + (r.durationMs || 0), 0) / totalRecent)
        : 0;

    checks.push({
        name: 'Error rate',
        status: errorRate < 10 ? 'ok' : (errorRate < 25 ? 'warn' : 'error'),
        message: totalRecent > 0 ? errorRate.toFixed(1) + '% (' + errorCount + '/' + totalRecent + ')' : 'No recent requests'
    });
    checks.push({
        name: 'Average latency',
        status: avgDuration < 30000 ? 'ok' : 'warn',
        message: avgDuration > 0 ? avgDuration + 'ms' : 'N/A'
    });
    const stalePending = Array.isArray(pending) ? pending.filter(p => (p.elapsedMs || 0) > 600000) : [];
    checks.push({
        name: 'Stale pending requests',
        status: stalePending.length === 0 ? 'ok' : 'warn',
        message: stalePending.length > 0 ? stalePending.length + ' request(s) pending > 10 min' : 'None'
    });
    const recentActivity = requests.filter(r => {
        const age = r.date ? Date.now() - new Date(r.date).getTime() : Infinity;
        return age < 3600000;
    });
    checks.push({
        name: 'Recent activity',
        status: recentActivity.length > 0 ? 'ok' : 'warn',
        message: recentActivity.length + ' request(s) in last hour'
    });
    return checks;
}

async function runMCPChecks() {
    const checks = [];
    try {
        const servers = await getMcpServerStatus();
        if (!Array.isArray(servers) || servers.length === 0) {
            checks.push({ name: 'MCP servers configured', status: 'skip', message: 'No MCP servers' });
            return checks;
        }
        const enabledServers = servers.filter(s => s.enabled !== false);
        const running = enabledServers.filter(s => s.status === 'running');
        const errors = enabledServers.filter(s => s.status === 'error');
        checks.push({
            name: 'Enabled servers running',
            status: errors.length === 0 && running.length === enabledServers.length ? 'ok' : (errors.length > 0 ? 'error' : 'warn'),
            message: running.length + '/' + enabledServers.length + ' running' + (errors.length > 0 ? ', ' + errors.length + ' error(s)' : '')
        });
        if (errors.length > 0) {
            errors.forEach(s => {
                checks.push({
                    name: 'Server: ' + s.name,
                    status: 'error',
                    message: s.error || 'Unknown error'
                });
            });
        }
        const zeroTools = enabledServers.filter(s => (s.toolCount || 0) === 0);
        checks.push({
            name: 'Tools per server',
            status: zeroTools.length === 0 ? 'ok' : 'warn',
            message: zeroTools.length > 0 ? zeroTools.length + ' server(s) with 0 tools' : 'All servers have tools'
        });
    } catch (e) {
        checks.push({ name: 'MCP check', status: 'error', message: e.message });
    }
    return checks;
}

async function runMemoryChecks() {
    const checks = [];
    try {
        const brain = await getBrainDiagnostics();
        const files = brain.files || {};
        const counts = brain.counts || {};
        checks.push({
            name: 'Core memory',
            status: files.core && files.core.exists ? 'ok' : 'error',
            message: files.core && files.core.exists ? (files.core.sizeBytes || 0) + ' bytes' : 'Missing'
        });
        checks.push({
            name: 'Vector DB entries',
            status: (counts.vectorEntries || 0) > 0 ? 'ok' : 'warn',
            message: (counts.vectorEntries || 0) + ' entries'
        });
        checks.push({
            name: 'Semantic facts',
            status: (counts.semanticFacts || 0) > 0 ? 'ok' : 'warn',
            message: (counts.semanticFacts || 0) + ' facts'
        });
        checks.push({
            name: 'Graph entities',
            status: (counts.graphEntities || 0) > 0 ? 'ok' : 'warn',
            message: (counts.graphEntities || 0) + ' entities'
        });
    } catch (e) {
        checks.push({ name: 'Memory check', status: 'error', message: e.message });
    }
    return checks;
}

function runConfigChecks() {
    const checks = [];
    const config = getConfig();
    const claude = config.claude || {};
    const codex = config.codex || {};

    const claudeEffort = claude.thinkingEffort || '';
    const codexEffort = codex.thinkingEffort || '';
    const validEfforts = ['', 'low', 'medium', 'high', 'max'];
    checks.push({
        name: 'Claude thinking effort',
        status: validEfforts.includes(claudeEffort) ? 'ok' : 'warn',
        message: claudeEffort || 'Not set (let client decide)'
    });
    checks.push({
        name: 'Codex thinking effort',
        status: validEfforts.includes(codexEffort) ? 'ok' : 'warn',
        message: codexEffort || 'Not set (let client decide)'
    });
    const memLimit = config.memoryContextMaxChars || 24000;
    checks.push({
        name: 'Memory context limit',
        status: memLimit >= 8000 && memLimit <= 24000 ? 'ok' : 'warn',
        message: memLimit.toLocaleString() + ' chars'
    });
    return checks;
}

async function runAIAnalysis() {
    const config = getConfig();
    const autoProv = config.automationProvider || {};

    if (!autoProv.url || !autoProv.model) {
        return {
            analysis: 'Automation provider not configured. Go to Provider Settings → Automation Provider to set one up.',
            generatedAt: new Date().toISOString(),
            model: null
        };
    }

    // Run fresh diagnostic
    await runDiagnostic();
    const report = latestReport;
    if (!report) {
        return {
            analysis: 'Diagnostic data not available yet.',
            generatedAt: new Date().toISOString(),
            model: null
        };
    }

    const systemStats = report.systemStats || {};
    const categories = report.categories || [];
    const summary = report.summary || {};

    const prompt = `You are a proxy diagnostic AI. Analyze this proxy health report and provide:
1. A brief summary of overall health
2. Each issue found (status=warn or error) with severity
3. Specific, actionable recommendations
4. Any performance concerns

Report:
- Total checks: ${summary.total} (ok=${summary.ok}, warn=${summary.warn}, error=${summary.error})
- Uptime: ${systemStats.uptimeHuman || 'N/A'}
- Memory: ${systemStats.memory ? systemStats.memory.usagePercent + '% used (' + systemStats.memory.rss + 'MB)' : 'N/A'}
- Node: ${systemStats.nodeVersion || 'N/A'}

${categories.map(cat => `--- ${cat.name} ---\n${cat.checks.map(c => `[${c.status.toUpperCase()}] ${c.name}: ${c.message}`).join('\n')}`).join('\n\n')}

Format your response with markdown headings, bullet points, and severity labels (**HIGH**, **MEDIUM**, **LOW**).`;

    const payload = {
        model: autoProv.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: autoProv.maxTokens || 4096
    };
    const headers = { 'Content-Type': 'application/json' };
    if (autoProv.apiKey) headers['Authorization'] = 'Bearer ' + autoProv.apiKey;

    try {
        const response = await fetch(autoProv.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(120000)
        });
        if (!response.ok) {
            const errText = await response.text().catch(() => 'Unknown error');
            return {
                analysis: 'AI Analysis failed: HTTP ' + response.status + ' — ' + errText,
                generatedAt: new Date().toISOString(),
                model: autoProv.model
            };
        }
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || data.content?.[0]?.text || 'No response from model';
        const usage = data.usage || {};

        // Store in report
        if (latestReport) {
            latestReport.aiAnalysis = {
                analysis: content,
                generatedAt: new Date().toISOString(),
                model: autoProv.model,
                tokensUsed: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 }
            };
        }

        return {
            analysis: content,
            generatedAt: new Date().toISOString(),
            model: autoProv.model,
            tokensUsed: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 }
        };
    } catch (e) {
        return {
            analysis: 'AI Analysis failed: ' + e.message,
            generatedAt: new Date().toISOString(),
            model: autoProv.model
        };
    }
}

module.exports = { startScheduler, stopScheduler, getReport, runDiagnostic, runAIAnalysis };
