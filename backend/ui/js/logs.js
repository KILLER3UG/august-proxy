/* ── Logs Tab ── */
let logFilter = 'all';
let logData = null;

const LOG_TYPE_STYLES = {
    AGENT: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
    WEB: 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300',
    BASH: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
    AUGUST: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
    COWORK: 'bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300',
    SEARCH: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300',
    READ: 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300',
    COMPACT: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300',
    ERROR: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
    PENDING: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300',
    SUCCESS: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
};

function escLogHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadLogsUI() {
    try {
        const res = await fetch('/ui/logs');
        if (!res.ok) {
            document.getElementById('logList').innerHTML = '<div class="p-5 text-amber-500 dark:text-amber-400 text-sm">Logs endpoint not available (HTTP ' + res.status + '). Try restarting the proxy server.</div>';
            return;
        }
        logData = await res.json();
        if (logData && logData.error) {
            document.getElementById('logList').innerHTML = '<div class="p-5 text-amber-500 dark:text-amber-400 text-sm">Logs endpoint error: ' + escLogHtml(logData.error) + '. Try restarting the proxy server.</div>';
            return;
        }
        renderLogs();
    } catch (e) {
        document.getElementById('logList').innerHTML = '<div class="p-5 text-red-500 dark:text-red-400 text-sm">Failed to load logs: ' + escLogHtml(e.message) + '</div>';
    }
}

function switchLogFilter(filter) {
    logFilter = filter;
    document.querySelectorAll('.log-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    renderLogs();
}

function renderLogs() {
    const container = document.getElementById('logList');
    if (!container || !logData) return;

    const entries = buildLogEntries();
    const countEl = document.getElementById('logCount');
    if (countEl) countEl.textContent = entries.length + ' entries';

    if (entries.length === 0) {
        container.innerHTML = '<div class="p-5 text-slate-400 dark:text-slate-500 text-sm italic">No log entries for this filter.</div>';
        return;
    }

    container.innerHTML = entries.map((entry, idx) => renderLogEntry(entry, idx)).join('');
}

function buildLogEntries() {
    const entries = [];
    const { activity, requests, errors, pending, details, profiles } = logData || {};

    const detailsMap = {};
    if (Array.isArray(details)) {
        details.forEach(d => { if (d.reqId) detailsMap[d.reqId] = d; });
    }

    // Activity entries
    if (Array.isArray(activity)) {
        activity.forEach(a => {
            const type = (a.type || '').toUpperCase();
            let match = false;
            switch (logFilter) {
                case 'all': match = true; break;
                case 'agent': match = type === 'AGENT'; break;
                case 'tools': match = ['WEB', 'BASH', 'AUGUST', 'COWORK', 'SEARCH', 'READ'].includes(type); break;
                case 'system': match = type === 'COMPACT'; break;
                case 'errors': match = type === 'ERROR'; break;
            }
            if (match) {
                entries.push({
                    time: a.time || '--',
                    type: type,
                    summary: a.detail || '',
                    detail: '',
                    source: 'activity',
                    raw: a
                });
            }
        });
    }

    // Request entries (for agent tab or all)
    if (Array.isArray(requests) && (logFilter === 'all' || logFilter === 'agent')) {
        requests.forEach(r => {
            const detail = detailsMap[r.reqId];
            const effortInfo = extractThinkingEffort(detail, profiles, r.clientType);
            entries.push({
                time: r.time || '--',
                type: r.status === 'error' ? 'ERROR' : 'AGENT',
                summary: (r.model || 'unknown') + ' — ' + (r.status || 'unknown') + ' (' + (r.durationMs || '?') + 'ms)',
                detail: 'Tokens: ' + (r.inputTokens || 0) + ' in / ' + (r.outputTokens || 0) + ' out' + (effortInfo ? ' | ' + effortInfo : '') + (r.error ? ' | Error: ' + r.error : ''),
                source: 'request',
                raw: r
            });
        });
    }

    // Error entries
    if (Array.isArray(errors) && (logFilter === 'all' || logFilter === 'errors')) {
        errors.forEach(r => {
            entries.push({
                time: r.time || '--',
                type: 'ERROR',
                summary: (r.model || 'unknown') + ' — ' + (r.error || 'Unknown error'),
                detail: 'Duration: ' + (r.durationMs || '?') + 'ms | Tokens: ' + (r.inputTokens || 0) + ' in / ' + (r.outputTokens || 0) + ' out',
                source: 'error',
                raw: r
            });
        });
    }

    // Pending entries
    if (Array.isArray(pending) && (logFilter === 'all' || logFilter === 'agent')) {
        pending.forEach(p => {
            entries.push({
                time: '--',
                type: 'PENDING',
                summary: (p.model || 'unknown') + ' — in flight (' + (p.clientType || '?') + ')',
                detail: 'Endpoint: ' + (p.endpoint || '?'),
                source: 'pending',
                raw: p
            });
        });
    }

    // Sort by time descending (pending entries with '--' go to bottom)
    entries.sort((a, b) => {
        if (a.time === '--' && b.time === '--') return 0;
        if (a.time === '--') return 1;
        if (b.time === '--') return -1;
        return b.time.localeCompare(a.time);
    });

    return entries;
}

function extractThinkingEffort(detail, profiles, clientType) {
    if (!detail) return '';
    const parts = [];
    // Profile config (from the passed clientType, not detail.clientType which is often undefined)
    const profileName = clientType || '';
    const profileCfg = profiles && profiles[profileName];
    if (profileCfg && profileCfg.thinkingEffort) {
        parts.push('cfg=' + profileCfg.thinkingEffort);
    }
    // Request body — reasoning_effort (OpenAI format)
    const reqBody = detail.requestBody || {};
    if (reqBody.reasoning_effort) {
        parts.push('client=' + reqBody.reasoning_effort);
    }
    // Request body — thinking block (Anthropic format)
    if (reqBody.thinking) {
        const t = reqBody.thinking;
        if (typeof t === 'object' && t.budget_tokens) {
            parts.push('thinking(' + t.budget_tokens + ')');
        } else if (typeof t === 'string') {
            parts.push('thinking(' + t + ')');
        }
    }
    // Response body — Anthropic thinking content blocks
    const respBody = detail.responseBody || {};
    if (Array.isArray(respBody.content)) {
        const hasThinkingBlock = respBody.content.some(b => b.type === 'thinking');
        if (hasThinkingBlock) parts.push('upstream=thinking_block');
    }
    if (parts.length === 0) return '';
    return '🧠 ' + parts.join(' → ');
}

function renderLogEntry(entry, idx) {
    const typeStyle = LOG_TYPE_STYLES[entry.type] || 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400';
    const detailsHtml = entry.detail ? '<div class="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 font-mono">' + escLogHtml(entry.detail) + '</div>' : '';
    return '<div class="px-5 py-3 hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800/50 transition">' +
        '<div class="flex items-center gap-2 text-xs">' +
        '<span class="text-[10px] text-slate-400 dark:text-slate-500 font-mono shrink-0 w-14">' + escLogHtml(entry.time) + '</span>' +
        '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded ' + typeStyle + ' shrink-0">' + escLogHtml(entry.type) + '</span>' +
        '<span class="text-slate-700 dark:text-slate-300 flex-1 truncate">' + escLogHtml(entry.summary) + '</span>' +
        '</div>' +
        detailsHtml +
        '</div>';
}
