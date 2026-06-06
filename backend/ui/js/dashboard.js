/* ── Overview / Traffic ── */
function buildActivityRenderKey(data) {
    if (!Array.isArray(data) || data.length === 0) return 'empty';
    const first = data[0] || {};
    return [data.length, first.time, first.type, first.detail].join('|');
}

function buildRequestsRenderKey(data) {
    const firstCompleted = data?.completed?.[0] || {};
    const pendingIds = (data?.pending || []).map(item => `${item.reqId || 'pending'}:${item.status || ''}:${Math.floor((item.elapsedMs || 0) / 1000)}`).join(',');
    return [data?.completed?.length || 0, firstCompleted.reqId || '', firstCompleted.status || '', firstCompleted.durationMs || 0, firstCompleted.totalTokens || 0, pendingIds].join('|');
}

function buildStatsRenderKey(stats) {
    return [stats?.pendingRequests || 0, stats?.totalRequests || 0, stats?.totalInputTokens || 0, stats?.totalOutputTokens || 0, stats?.mostUsedModel || '', stats?.mostUsedCount || 0].join('|');
}

function buildInspectorRenderKey(data) {
    if (!Array.isArray(data) || data.length === 0) return 'empty';
    return data.map(item => [item.reqId, item.status, item.finishReason || '', item.toolCalls?.length || 0, item.thinking?.length || 0, item.inputTokens || 0, item.outputTokens || 0, item.durationMs || 0, item.responseBody ? prettyJson(item.responseBody).length : 0, item.error ? '1' : '0'].join(':')).join('|');
}

async function loadRequests() {
    try {
        const [reqRes, statsRes] = await Promise.all([fetch('/ui/requests?' + getPeriodQueryString(currentPeriod), { cache: 'no-store' }), fetch('/ui/stats?' + getPeriodQueryString(currentPeriod), { cache: 'no-store' })]);
        if (!reqRes.ok) throw new Error('Requests HTTP ' + reqRes.status);
        if (!statsRes.ok) throw new Error('Stats HTTP ' + statsRes.status);
        const data = await reqRes.json();
        const stats = await statsRes.json();
        renderStats(stats);
        renderPending(data.pending || []);
        renderCompleted(data.completed || []);
        updateLiveProfileAliases(data.pending || [], data.completed || []);
        updateDebugStamp('requests', `${stats.pendingRequests} pending`);
    } catch (e) { reportLiveError('requests', e); }
}

function renderStats(stats) {
    latestStatsSnapshot = stats;
    document.getElementById('statusPending').innerText = formatExactNumber(stats.pendingRequests);
    document.getElementById('statusTotal').innerText = formatExactNumber(stats.totalRequests);
    document.getElementById('statusInputTokens').innerText = formatExactNumber(stats.totalInputTokens);
    document.getElementById('statusOutputTokens').innerText = formatExactNumber(stats.totalOutputTokens);
    rerenderCostSummary();
    const mostUsedEl = document.getElementById('statusMostUsedModel');
    const mostUsedCountEl = document.getElementById('statusMostUsedCount');
    if (stats.mostUsedModel) { mostUsedEl.innerText = stats.mostUsedModel.split('/').pop(); mostUsedEl.title = stats.mostUsedModel; mostUsedCountEl.innerText = stats.mostUsedCount + ' request' + (stats.mostUsedCount !== 1 ? 's' : ''); }
    else { mostUsedEl.innerText = '--'; mostUsedEl.title = '--'; mostUsedCountEl.innerText = '0 requests'; }
}

function updateLiveProfileAliases(pending, completed) {
    const claudeEntries = [...(pending || []), ...(completed || [])].filter(item => item && item.clientType === 'claude' && item.model).sort((a, b) => { const aTime = Number(a.timestamp || 0) || Date.parse(a.date || '') || 0; const bTime = Number(b.timestamp || 0) || Date.parse(b.date || '') || 0; return bTime - aTime; });
    const latestClaudeModel = claudeEntries[0]?.model || '--';
    const aliasEl = document.getElementById('claudeStatusAlias');
    if (aliasEl) {
        const configuredAlias = getClaudePublicAliasValue();
        const liveLabel = latestClaudeModel && latestClaudeModel !== '--' && latestClaudeModel !== configuredAlias ? `${configuredAlias} (live: ${latestClaudeModel})` : configuredAlias;
        aliasEl.innerText = 'Public alias: ' + liveLabel;
        aliasEl.title = liveLabel;
    }
}

function renderPending(pending) {
    const pendingSection = document.getElementById('pendingSection');
    const pendingList = document.getElementById('pendingList');
    if (pending.length > 0) {
        pendingSection.classList.remove('hidden');
        pendingList.innerHTML = pending.map(r => `<div class="flex items-center gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 rounded-lg px-3 py-2"><span class="inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse"></span><span class="text-xs font-bold ${r.clientType === 'claude' ? 'text-purple-700' : 'text-blue-700'}">${r.clientType.toUpperCase()}</span><span class="text-xs text-slate-600 dark:text-slate-300">${r.endpoint}</span><span class="text-xs text-slate-400 dark:text-slate-500 ml-auto font-mono">${r.elapsedMs}ms</span></div>`).join('');
    } else { pendingSection.classList.add('hidden'); }
}

function renderCompleted(completed) {
    const tbody = document.getElementById('requestTable');
    if (completed.length === 0) { tbody.innerHTML = '<tr><td colspan="8" class="py-8 text-center text-slate-400 dark:text-slate-500 text-sm">No requests yet</td></tr>'; return; }
    tbody.innerHTML = completed.slice(0, 50).map(r => {
        const isClaude = r.clientType === 'claude';
        const badgeColor = isClaude ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300';
        const statusIcon = r.status === 'success' || r.status === 'completed' ? '✅' : '❌';
        const endpointShort = r.endpoint.replace('/v1/', '');
        const errorTooltip = r.error ? `title="${r.error.replace(/"/g, '&quot;')}"` : '';
        const inTokens = r.inputTokens || 0; const outTokens = r.outputTokens || 0;
        const tokenText = (inTokens > 0 || outTokens > 0) ? `<span class="text-indigo-600 dark:text-indigo-400">${formatTokenCount(inTokens)}</span> <span class="text-slate-400 dark:text-slate-500 text-[10px]">/</span> <span class="text-emerald-600 dark:text-emerald-400">${formatTokenCount(outTokens)}</span>` : '- / -';
        const typeColors = { 'Chat': 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800', 'System': 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700', 'Tool Use': 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800', 'Multi-turn': 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800', 'unknown': 'bg-slate-50 dark:bg-slate-800 text-slate-400 dark:text-slate-500 border border-slate-200 dark:border-slate-700' };
        const typeColor = typeColors[r.requestType] || typeColors['unknown'];
        const typeLabel = r.requestType || 'unknown';
        return `<tr class="border-b border-slate-50 dark:border-slate-800 hover-row" ${errorTooltip}><td class="py-2.5 text-xs text-slate-500 dark:text-slate-400 font-mono">${r.time}</td><td class="py-2.5"><span class="text-[10px] font-bold px-2 py-0.5 rounded-md ${badgeColor}">${r.clientType.toUpperCase()}</span></td><td class="py-2.5"><span class="text-[10px] font-medium px-1.5 py-0.5 rounded ${typeColor}">${typeLabel}</span></td><td class="py-2.5 text-xs text-slate-600 dark:text-slate-300">${endpointShort}</td><td class="py-2.5 text-xs text-slate-500 dark:text-slate-400 truncate max-w-[120px]" title="${r.model}">${r.model}</td><td class="py-2.5 text-xs font-mono text-right" title="Total: ${r.totalTokens || 0}">${tokenText}</td><td class="py-2.5 text-xs text-slate-500 dark:text-slate-400 font-mono text-right">${r.durationMs}ms</td><td class="py-2.5 text-xs text-center">${statusIcon}</td></tr>`;
    }).join('');
}

async function loadActivity() {
    try {
        const res = await fetch('/ui/activity', { cache: 'no-store' });
        if (!res.ok) throw new Error('Activity HTTP ' + res.status);
        const data = await res.json();
        renderActivity(data);
        updateDebugStamp('activity', `${data.length} rows`);
    } catch (e) { reportLiveError('activity', e); }
}

function renderActivity(data) {
    const container = document.getElementById('activityList');
    if (data.length === 0) { container.innerHTML = '<div class="text-slate-400 dark:text-slate-500 text-sm italic">Waiting for model activity...</div>'; return; }
    const typeColors = { SEARCH: 'text-orange-600 bg-orange-50', READ: 'text-cyan-600 bg-cyan-50 dark:bg-cyan-900/20', AGENT: 'text-purple-600 bg-purple-50 dark:bg-purple-900/20', COMPACT: 'text-amber-600 bg-amber-50 dark:bg-amber-900/20' };
    container.innerHTML = data.slice(0, 30).map(item => { const color = typeColors[item.type] || 'text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900'; return `<div class="flex items-center gap-2 text-xs py-1 border-b border-slate-50 last:border-0"><span class="font-bold px-1.5 py-0.5 rounded ${color}">${item.type}</span><span class="text-slate-600 dark:text-slate-300 flex-1 truncate">${item.detail}</span><span class="text-slate-300 dark:text-slate-500 font-mono text-[10px]">${item.time}</span></div>`; }).join('');
}

/* ── Request Inspector ── */
async function loadInspector() {
    try {
        const res = await fetch('/ui/details?' + getPeriodQueryString(currentPeriod), { cache: 'no-store' });
        if (!res.ok) throw new Error('Inspector HTTP ' + res.status);
        const data = await res.json();
        lastInspectorRenderKey = buildInspectorRenderKey(data);
        inspectorData = data;
        renderInspector();
        updateDebugStamp('inspector', `${data.length} rows`);
    } catch (e) { reportLiveError('inspector', e); }
}

function renderInspector() {
    const container = document.getElementById('inspectorList');
    if (inspectorData.length === 0) { container.innerHTML = '<div class="text-slate-400 dark:text-slate-500 text-sm italic">Requests will appear here...</div>'; return; }
    container.innerHTML = inspectorData.map(item => {
        const isExpanded = item.reqId === expandedReqId;
        const statusColor = item.status === 'error' ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300' : item.status === 'completed' ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300' : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300';
        const statusLabel = item.status === 'error' ? 'ERROR' : item.status === 'completed' ? 'OK' : 'PENDING';
        const responsePanels = extractResponsePanels(item.responseBody);
        const toolInteractions = extractToolInteractions(item);
        const toolInteractionPanels = renderToolInteractionPanels(toolInteractions);
        const structuredThinkingPanels = responsePanels.filter(panel => panel.tone === 'indigo');
        const hasThinking = (item.thinking && item.thinking.length > 0) || structuredThinkingPanels.length > 0;
        const hasTools = item.toolCalls && item.toolCalls.length > 0;
        const hasResponsePanels = responsePanels.length > 0;
        const hasToolInteractions = toolInteractions.length > 0;
        const finishBadge = item.finishReason ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-600 text-slate-600 dark:text-slate-300 ml-2">finish: ${item.finishReason}</span>` : '';
        let detailHtml = '';
        if (isExpanded) {
            detailHtml = `<div class="mt-3 space-y-3 border-t border-slate-100 dark:border-slate-700 pt-3">`;
            if (hasTools) { detailHtml += `<div class="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-3"><p class="text-[10px] font-bold text-orange-700 dark:text-orange-300 uppercase mb-1">🔧 Tool Calls</p>${item.toolCalls.map(tc => `<div class="mb-2"><p class="text-xs font-bold text-orange-800 dark:text-orange-300">${escapeHtml(tc.name)} <span class="text-[10px] text-slate-500 dark:text-slate-400 font-normal">(${tc.id})</span></p><pre class="text-[10px] text-orange-900 dark:text-orange-200 bg-white dark:bg-slate-800 rounded p-2 mt-1 overflow-x-auto">${escapeHtml(prettyJson(tc.arguments))}</pre></div>`).join('')}</div>`; }
            if (hasToolInteractions) { detailHtml += toolInteractionPanels; }
            if (hasResponsePanels) { detailHtml += responsePanels.map(renderResponsePanel).join(''); }
            if (item.error) { detailHtml += `<div class="bg-red-50 dark:bg-red-900/20 rounded-lg p-3"><p class="text-[10px] font-bold text-red-700 dark:text-red-300 uppercase mb-1">❌ Error</p><pre class="text-xs text-red-800 dark:text-red-200 whitespace-pre-wrap font-mono">${escapeHtml(item.error)}</pre></div>`; }
            detailHtml += `<details class="text-xs"><summary class="cursor-pointer text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 font-medium">View Raw Request / Response</summary><div class="mt-2 space-y-2"><div><p class="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">Request</p><pre class="text-[10px] bg-slate-100 dark:bg-slate-700 rounded p-2 overflow-x-auto">${escapeHtml(prettyJson(item.requestBody))}</pre></div><div><p class="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">Response</p><pre class="text-[10px] bg-slate-100 dark:bg-slate-700 rounded p-2 overflow-x-auto">${escapeHtml(prettyJson(item.responseBody))}</pre></div></div></details>`;
            detailHtml += `</div>`;
        }
        return `<div class="border border-slate-200 dark:border-slate-700 rounded-lg p-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700 dark:bg-slate-900 transition" onclick="toggleInspector('${item.reqId}')"><div class="flex items-center justify-between"><div class="flex items-center gap-2"><span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${statusColor}">${statusLabel}</span><span class="text-xs font-mono text-slate-600 dark:text-slate-300">${item.timestamp}</span>${hasThinking ? '<span class="text-[10px] text-indigo-600">🤔</span>' : ''}${hasTools ? '<span class="text-[10px] text-orange-600">🔧</span>' : ''}${hasToolInteractions ? '<span class="text-[10px] text-emerald-600">📁</span>' : ''}${hasResponsePanels ? '<span class="text-[10px] text-slate-500 dark:text-slate-300">💬</span>' : ''}${item.error ? '<span class="text-[10px] text-red-600">❌</span>' : ''}</div>${finishBadge}</div>${detailHtml}</div>`;
    }).join('');
}

function toggleInspector(reqId) { expandedReqId = expandedReqId === reqId ? null : reqId; renderInspector(); }

/* ── Thinking ── */
async function loadThinking() {
    try {
        const res = await fetch('/ui/details?' + getPeriodQueryString(currentPeriod), { cache: 'no-store' });
        if (!res.ok) throw new Error('Thinking HTTP ' + res.status);
        const data = await res.json();
        thinkingData = data.filter(item => { const responsePanels = extractResponsePanels(item.responseBody); return Boolean(extractThinkingSummary(item, responsePanels)); });
        lastThinkingRenderKey = buildInspectorRenderKey(thinkingData);
        renderThinking();
    } catch (e) { reportLiveError('thinking', e); }
}

function renderThinking() {
    const container = document.getElementById('thinkingList');
    if (!container) return;
    if (thinkingData.length === 0) { container.innerHTML = '<div class="text-slate-400 dark:text-slate-500 text-sm italic">Thinking traces will appear here...</div>'; return; }
    container.innerHTML = thinkingData.map(item => {
        const responsePanels = extractResponsePanels(item.responseBody);
        const requestText = extractRequestMessageSummary(item.requestBody);
        const thinkingText = extractThinkingSummary(item, responsePanels);
        const isExpanded = item.reqId === expandedThinkingReqId;
        const statusColor = item.status === 'error' ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300' : item.status === 'completed' ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300' : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300';
        const statusLabel = item.status === 'error' ? 'ERROR' : item.status === 'completed' ? 'OK' : 'PENDING';
        let detailHtml = '';
        if (isExpanded) {
            detailHtml = `<div class="mt-3 space-y-3 border-t border-slate-100 dark:border-slate-700 pt-3">`;
            detailHtml += renderThinkingTraceCard(item, responsePanels);
            detailHtml += `<details class="text-xs"><summary class="cursor-pointer text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 font-medium">View Raw Request / Response</summary><div class="mt-2 space-y-2"><div><p class="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">Request</p><pre class="text-[10px] bg-slate-100 dark:bg-slate-700 rounded p-2 overflow-x-auto">${escapeHtml(prettyJson(item.requestBody))}</pre></div><div><p class="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">Response</p><pre class="text-[10px] bg-slate-100 dark:bg-slate-700 rounded p-2 overflow-x-auto">${escapeHtml(prettyJson(item.responseBody))}</pre></div></div></details>`;
            detailHtml += `</div>`;
        }
        return `<div class="border border-slate-200 dark:border-slate-700 rounded-lg p-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700 dark:bg-slate-900 transition" onclick="toggleThinking('${item.reqId}')"><div class="flex items-center justify-between gap-3"><div class="flex items-center gap-2 min-w-0"><span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${statusColor}">${statusLabel}</span><span class="text-xs font-mono text-slate-600 dark:text-slate-300">${item.timestamp}</span><span class="text-[10px] text-indigo-600">🤔</span></div>${item.finishReason ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-600 text-slate-600 dark:text-slate-300">finish: ${item.finishReason}</span>` : ''}</div>${detailHtml}</div>`;
    }).join('');
}

function toggleThinking(reqId) { expandedThinkingReqId = expandedThinkingReqId === reqId ? null : reqId; renderThinking(); }

/* ── Health ── */
function mcpStatusClass(status) {
    if (status === 'running') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
    if (status === 'starting') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
    if (status === 'error') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
    return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
}

function renderTinyBadge(label, classes) { return `<span class="rounded-full px-2 py-0.5 text-[10px] font-semibold ${classes}">${escapeHtml(label)}</span>`; }

function healthStatusClass(status) {
    if (status === 'ok') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
    if (status === 'warn') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
}

async function loadHealthUI() {
    const cards = document.getElementById('healthCards');
    const checks = document.getElementById('healthChecks');
    if (!cards || !checks) return;
    try {
        const res = await fetch('/ui/health', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        healthState = await res.json();
        renderHealthUI();
    } catch (e) { checks.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`; }
}

function renderHealthUI() {
    if (!healthState) return;
    const cards = document.getElementById('healthCards');
    const checks = document.getElementById('healthChecks');
    const generated = document.getElementById('healthGeneratedAt');
    if (generated) generated.textContent = `Last checked: ${new Date(healthState.generatedAt).toLocaleTimeString()}`;
    cards.innerHTML = (healthState.cards || []).map(card => `<div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"><p class="text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">${escapeHtml(card.label)}</p><div class="mt-3 flex items-center justify-between gap-3"><p class="metric-value text-xl font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(String(card.value))}</p>${renderTinyBadge(card.status || 'ok', healthStatusClass(card.status || 'ok'))}</div></div>`).join('');
    checks.innerHTML = (healthState.checks || []).map(check => `<div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"><div class="flex flex-wrap items-center gap-2"><h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(check.label)}</h3>${renderTinyBadge(check.status || 'ok', healthStatusClass(check.status || 'ok'))}${renderTinyBadge(check.area || 'system', 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300')}</div><p class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">${escapeHtml(check.detail || '')}</p>${check.action ? `<p class="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-600 dark:bg-slate-950 dark:text-slate-300">${escapeHtml(check.action)}</p>` : ''}</div>`).join('');
}

/* ── Conversations ── */
function buildConversationsRenderKey(data) {
    const clients = Object.keys(data || {});
    if (clients.length === 0) return 'empty';
    const parts = [];
    for (const client of clients.sort()) {
        const entries = data[client] || [];
        const first = entries[0] || {};
        parts.push(`${client}:${entries.length}:${first.reqId}:${first.status}:${first.durationMs}`);
    }
    return parts.join('|');
}

async function loadConversations() {
    try {
        const res = await fetch('/ui/conversations?' + getPeriodQueryString(currentPeriod), { cache: 'no-store' });
        if (!res.ok) throw new Error('Conversations HTTP ' + res.status);
        const data = await res.json();
        const key = buildConversationsRenderKey(data);
        if (key === lastConversationsRenderKey) return;
        lastConversationsRenderKey = key;
        renderConversations(data);
        updateDebugStamp('conversations', `${Object.keys(data).length} clients`);
    } catch (e) { reportLiveError('conversations', e); }
}

function extractConversationMessages(entry) {
    const msgs = [];
    if (entry.details?.messages) {
        for (const m of entry.details.messages) {
            if (m.role === 'system') continue;
            let content = '';
            if (typeof m.content === 'string') content = m.content;
            else if (Array.isArray(m.content)) content = m.content.map(c => c.type === 'text' ? c.text : c.type === 'tool_use' ? `[Tool use: ${c.name}]` : c.type === 'tool_result' ? `[Tool result]` : `[${c.type}]`).filter(Boolean).join('\n');
            else if (m.content) content = JSON.stringify(m.content);
            if (m.role && content) msgs.push({ role: m.role, content: truncateConversationText(content, 600) });
        }
    }
    const res = entry.details?.response;
    if (res) {
        const resContent = res.content || (res.choices?.[0]?.message?.content);
        if (resContent) {
            let text = '';
            if (typeof resContent === 'string') text = resContent;
            else if (Array.isArray(resContent)) text = resContent.map(c => c.type === 'text' ? c.text : c.type === 'thinking' ? `[Thinking: ${(c.thinking || '').substring(0, 100)}...]` : c.type === 'tool_use' ? `[Tool call: ${c.name}]` : `[${c.type}]`).filter(Boolean).join('\n');
            if (text) msgs.push({ role: 'assistant', content: truncateConversationText(text, 800) });
        }
        if (entry.details?.thinking) msgs.push({ role: 'thinking', content: truncateConversationText(entry.details.thinking, 400) });
    }
    return msgs;
}

function truncateConversationText(text, maxLen) {
    if (!text || text.length <= maxLen) return text || '';
    return text.substring(0, maxLen) + '...';
}

function renderConversations(data) {
    const container = document.getElementById('conversationGroups');
    const countEl = document.getElementById('conversationCount');
    if (!container) return;
    const clients = Object.keys(data || {});
    const totalEntries = clients.reduce((sum, c) => sum + (data[c]?.length || 0), 0);
    if (countEl) countEl.textContent = `${totalEntries} exchanges`;
    if (clients.length === 0) { container.innerHTML = '<div class="text-slate-400 dark:text-slate-500 text-sm italic">No conversations yet</div>'; return; }
    container.innerHTML = clients.sort().map(client => {
        const entries = data[client] || [];
        const clientLabel = client.toUpperCase();
        const badgeColor = client === 'claude' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' : client === 'codex' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300';
        return `<div class="rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div class="px-4 py-3 border-b border-slate-100 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/50 flex items-center justify-between">
                <div class="flex items-center gap-2">
                    <span class="text-[11px] font-bold px-2 py-0.5 rounded-md ${badgeColor}">${clientLabel}</span>
                    <span class="text-xs text-slate-500 dark:text-slate-400">${entries.length} request${entries.length !== 1 ? 's' : ''}</span>
                </div>
                <span class="text-[10px] text-slate-400 dark:text-slate-500 font-mono">newest first</span>
            </div>
            <div class="divide-y divide-slate-100 dark:divide-slate-800">
                ${entries.map(entry => renderConversationEntry(entry, client)).join('')}
            </div>
        </div>`;
    }).join('');
}

function renderConversationEntry(entry, client) {
    const msgs = extractConversationMessages(entry);
    const statusIcon = entry.status === 'success' || entry.status === 'completed' ? '✅' : '❌';
    const endpointShort = (entry.endpoint || '').replace('/v1/', '');
    const inTokens = entry.inputTokens || 0;
    const outTokens = entry.outputTokens || 0;
    const tokenText = (inTokens > 0 || outTokens > 0) ? `${formatTokenCount(inTokens)} / ${formatTokenCount(outTokens)}` : '-';
    const hasMessages = msgs.length > 0;
    const entryId = entry.reqId || 'entry_' + Math.random().toString(36).substr(2, 6);
    return `<div class="px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition">
        <div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-2">
            <span class="font-mono">${entry.time || ''}</span>
            <span class="text-slate-300 dark:text-slate-600">|</span>
            <span class="font-mono truncate max-w-[160px]" title="${entry.model || ''}">${entry.model || '--'}</span>
            <span class="text-slate-300 dark:text-slate-600">|</span>
            <span class="font-mono">${entry.durationMs}ms</span>
            <span class="text-slate-300 dark:text-slate-600">|</span>
            <span class="font-mono text-[10px] text-indigo-600 dark:text-indigo-400">${tokenText}</span>
            <span class="text-slate-300 dark:text-slate-600">|</span>
            <span class="text-[10px]">${endpointShort}</span>
            <span class="ml-auto">${statusIcon}</span>
        </div>
        ${hasMessages ? `<div class="space-y-1.5">
            ${msgs.map(m => {
                if (m.role === 'thinking') {
                    return `<div class="flex gap-2"><span class="text-[10px] text-indigo-500 dark:text-indigo-400 font-bold shrink-0 w-16">THINK</span><div class="text-[11px] text-indigo-600 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg px-3 py-1.5 flex-1">${escapeHtml(m.content)}</div></div>`;
                }
                const roleLabel = m.role === 'user' ? 'YOU' : 'AI';
                const roleColor = m.role === 'user' ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20' : 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20';
                return `<div class="flex gap-2"><span class="text-[10px] font-bold ${roleColor} rounded px-1.5 py-0.5 shrink-0 self-start">${roleLabel}</span><div class="text-[11px] text-slate-700 dark:text-slate-300 leading-relaxed flex-1 whitespace-pre-wrap">${escapeHtml(m.content)}</div></div>`;
            }).join('')}
        </div>` : `<div class="text-[11px] text-slate-400 dark:text-slate-500 italic">No message content captured</div>`}
        <details class="mt-1 text-[10px]">
            <summary class="cursor-pointer text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300">Raw JSON</summary>
            <pre class="mt-1 text-[10px] bg-slate-100 dark:bg-slate-800 rounded p-2 overflow-x-auto">${escapeHtml(prettyJson({ request: entry.details?.messages ? { messages: entry.details.messages } : null, response: entry.details?.response }))}</pre>
        </details>
    </div>`;
}

function extractThinkingSummary(item, responsePanels) {
    if (Array.isArray(responsePanels)) {
        const panel = responsePanels.find(p => p.tone === 'indigo' || (p.title && p.title.toLowerCase().includes('thinking')));
        if (panel && panel.content) return panel.content;
    }
    return '';
}

function extractRequestMessageSummary(requestBody) {
    const parsed = typeof requestBody === 'string' ? parseStructuredValue(requestBody) : requestBody;
    if (!parsed) return '';
    if (parsed.messages && Array.isArray(parsed.messages)) {
        const userMsgs = parsed.messages.filter(m => m.role === 'user');
        const msg = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1] : parsed.messages[0];
        if (msg) {
            if (typeof msg.content === 'string') return msg.content;
            if (Array.isArray(msg.content)) {
                const textBlock = msg.content.find(c => c.type === 'text');
                if (textBlock && textBlock.text) return textBlock.text;
                return msg.content.map(c => c.text || JSON.stringify(c)).join(' ');
            }
            return JSON.stringify(msg.content);
        }
    }
    if (parsed.prompt) return parsed.prompt;
    return '';
}
