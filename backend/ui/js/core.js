/* ── Sub-tab switching ── */
function switchSubTab(group, tabName, btn) {
    document.querySelectorAll(`.sub-tab-panel[data-tab-group="${group}"]`).forEach(p => p.classList.remove('active'));
    const target = document.querySelector(`.sub-tab-panel[data-tab-group="${group}"][data-tab="${tabName}"]`);
    if (target) target.classList.add('active');
    if (btn) {
        btn.closest('.sub-tabs').querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
    }
}

let allModels = [];
let currentPeriod = 'all';
let bookmarkList = [];
let inspectorData = [];
let thinkingData = [];
let expandedReqId = null;
let expandedThinkingReqId = null;
function getInitialDashboardSection() {
    const hash = (window.location.hash || '').replace(/^#/, '').toLowerCase();
    if (hash === 'august' || hash === 'august-console') return 'august';
    return localStorage.getItem('august-active-section') || 'overview';
}
let activeSection = getInitialDashboardSection();
let currentConfigState = {};
let latestStatsSnapshot = null;
let lastActivityRenderKey = '';
let lastRequestsRenderKey = '';
let lastStatsRenderKey = '';
let lastInspectorRenderKey = '';
let lastThinkingRenderKey = '';
let lastConversationsRenderKey = '';
let pollHandles = [];
let debugErrorCount = 0;
let liveStream = null;
let liveStreamGeneration = 0;
let _sseRetryTimeout = null;
let mcpServerListState = [];
let skillListState = [];
let pluginListState = [];
let compatibilityState = null;
let healthState = null;
let memoryItemState = [];
let workbenchSession = null;
const DEFAULT_MEMORY_CONTEXT_MAX_CHARS = 24000;
const MAX_MEMORY_CONTEXT_CHARS = 64000;

function sectionVisible(...sections) {
    return sections.includes(activeSection);
}

function updateDebugStamp(kind, message) {
    const idMap = { requests: 'debugRequestsAt', activity: 'debugActivityAt', inspector: 'debugInspectorAt', conversations: 'debugConversationsAt' };
    const el = document.getElementById(idMap[kind]);
    if (!el) return;
    const now = new Date();
    const stamp = now.toLocaleTimeString();
    el.innerText = message ? `${stamp} (${message})` : stamp;
}

function reportLiveError(scope, error) {
    debugErrorCount += 1;
    const countEl = document.getElementById('debugErrorCount');
    const errEl = document.getElementById('debugLastError');
    if (countEl) countEl.innerText = String(debugErrorCount);
    if (errEl) {
        errEl.classList.remove('hidden');
        errEl.innerText = `${scope}: ${error?.message || error || 'unknown error'}`;
    }
    console.error(`[UI ${scope}]`, error);
}

function clearProfileContextState(profile) {
    const field = document.getElementById(profile + 'ContextWindow');
    const status = document.getElementById(profile + 'StatusContext');
    if (field) field.value = '';
    if (status) status.innerText = '--';
    if (currentConfigState[profile]) {
        delete currentConfigState[profile].contextWindow;
        delete currentConfigState[profile].contextModelId;
    }
}

const DEFAULT_CLAUDE_PUBLIC_ALIAS = 'claude-opus-4-6';
const DEFAULT_REQUEST_LOG_LIMIT = 5000;
const DEFAULT_PENDING_TIMEOUT_MINUTES = 10;

/* ── Sidebar Collapse ── */
function toggleSidebar() {
    const isDesktop = window.innerWidth >= 1024;
    const layout = document.getElementById('appLayout');
    const sidebar = document.getElementById('appSidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (isDesktop) {
        /* Desktop: toggle collapsed icon strip */
        const collapsed = layout.classList.toggle('sidebar-collapsed');
        localStorage.setItem('august-sidebar-collapsed', collapsed);
    } else {
        /* Mobile: slide-over overlay */
        const opening = !sidebar.classList.contains('sidebar-open');
        sidebar.classList.toggle('sidebar-open', opening);
        backdrop?.classList.toggle('open', opening);
    }
}
function closeSidebarMobile() {
    document.getElementById('appSidebar')?.classList.remove('sidebar-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}
function initSidebar() {
    const collapsed = localStorage.getItem('august-sidebar-collapsed') === 'true';
    if (collapsed) {
        const layout = document.getElementById('appLayout');
        if (layout) layout.classList.add('sidebar-collapsed');
    }
}

/* ── Navigation ── */
function switchSection(section) {
    try {
    activeSection = section;
    localStorage.setItem('august-active-section', section);
    document.querySelectorAll('.dashboard-section').forEach(el => {
        el.classList.toggle('hidden', el.id !== 'section-' + section);
    });
    /* Show Gateway Dashboard header only on Overview tab */
    const dashHeader = document.getElementById('dashboardHeader');
    if (dashHeader) dashHeader.style.display = (section !== 'overview') ? 'none' : '';
    /* Close mobile sidebar overlay on nav */
    closeSidebarMobile();
    document.querySelectorAll('.section-nav').forEach(btn => {
        const isActive = btn.dataset.section === section;
        btn.classList.toggle('active', isActive);
    });
    try { setPeriod(currentPeriod); } catch(e) {}
    if (sectionVisible('overview', 'traffic')) loadRequests();
    if (sectionVisible('overview')) loadActivity();
    if (sectionVisible('health')) loadHealthUI();
    if (sectionVisible('workbench')) { ensureWorkbenchSession(); loadWorkbenchAgentsUI(); loadComputerUseStatus(); }
    if (sectionVisible('inspector')) loadInspector();
    if (sectionVisible('thinking')) loadThinking();
    if (sectionVisible('conversations')) loadConversations();
    if (sectionVisible('memory')) loadMemoryItemsUI();
    if (sectionVisible('mcp')) loadMcpSkillsUI();
    if (sectionVisible('profiles')) { loadProviderList(); loadProxyAIDiagnostics(); }
    if (sectionVisible('august')) {
        loadAugustUI();
        if (typeof initAugustConsoleUI === 'function') initAugustConsoleUI();
    }
    } catch(e) { /* ignore section switch errors */ }
}

/* ── UI Utilities ── */
function toggleApiKeyVisibility(inputId, button) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.innerText = reveal ? '🙈' : '👁';
}

function formatTokenCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n || 0);
}

function formatExactNumber(n) { return Number(n || 0).toLocaleString(); }

function formatUsd(value) {
    const amount = Number(value || 0);
    return '$' + amount.toLocaleString(undefined, { minimumFractionDigits: amount >= 1 ? 2 : 4, maximumFractionDigits: amount >= 1 ? 2 : 4 });
}

function extractProvider(url) {
    if (!url) return 'Unknown';
    try {
        const host = new URL(url).hostname;
        if (host.includes('kilo')) return 'Kilocode';
        if (host.includes('opencode')) return 'Opencode';
        if (host.includes('openrouter')) return 'OpenRouter';
        if (host.includes('nvidia')) return 'NVIDIA';
        if (host.includes('localhost') || host.includes('127.0.0.1')) return 'Local';
        return host.split('.')[0];
    } catch { return 'Custom'; }
}

function extractApiBaseUrl(url) {
    if (!url) return '--';
    try { return new URL(url).origin; } catch { return url; }
}

function getOptimizationSummary(profileCfg, profileName) {
    if (!profileCfg || !profileCfg.targetUrl) return 'Standard compatibility mode.';
    const route = profileCfg.targetUrl || '';
    const upstreamModel = profileCfg._upstreamModel || profileCfg.currentModel || '';
    const isMiniMax = route.includes('minimax') || upstreamModel.toLowerCase().includes('minimax');
    if (!isMiniMax) return 'Standard compatibility mode.';
    if (profileName === 'claude' || route.includes('/v1/messages') || route.includes('anthropic')) return 'MiniMax native-thinking mode.';
    return 'MiniMax optimized mode.';
}

function getPeriodQueryString(period) {
    const params = new URLSearchParams();
    params.set('period', period || '24h');
    params.set('tzOffsetMinutes', String(new Date().getTimezoneOffset()));
    let weekStartsOn = 0;
    try { const fd = new Intl.Locale(navigator.language).weekInfo?.firstDay; if (typeof fd === 'number') weekStartsOn = fd % 7; } catch (e) {}
    params.set('weekStartsOn', String(weekStartsOn));
    return params.toString();
}

function getLiveProfileState(profile) {
    const existing = window.currentConfigState?.[profile] || {};
    return { ...existing };
}

function sanitize(text) { return String(text || '').replace(/[&<>"']/g, function(c) { var m = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}; return m[c]; }); }

function setPeriod(period) {
    if (typeof period !== 'string') return;
    window.currentPeriod = period;
    try {
        document.querySelectorAll('.period-btn').forEach(function(btn) {
            btn.classList.toggle('active', btn.dataset.period === period);
        });
    } catch(e) {}
}

function setOptions(select, options, selected) {
    if (!select) return;
    select.innerHTML = '';
    (options || []).forEach(function(o) {
        var opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.label;
        if (o.value === selected) opt.selected = true;
        select.appendChild(opt);
    });
}

function getClaudePublicAliasValue() {
    const input = document.getElementById('claudePublicModel');
    return (input?.value || '').trim() || 'claude-opus-4-6';
}

function rerenderCostSummary() {
    if (!window.latestStatsSnapshot) return;
    var totalCostEl = document.getElementById('statusTotalCost');
    var costBreakEl = document.getElementById('statusCostBreakdown');
    if (!totalCostEl) return;
    var stats = window.latestStatsSnapshot;
    var inputCost = Number(stats.estimatedInputCost || 0);
    var outputCost = Number(stats.estimatedOutputCost || 0);
    var total = inputCost + outputCost;
    var formatted = '$' + total.toLocaleString(undefined, { minimumFractionDigits: total >= 1 ? 2 : 4, maximumFractionDigits: total >= 1 ? 2 : 4 });
    totalCostEl.textContent = formatted;
    if (costBreakEl) costBreakEl.textContent = 'In $' + inputCost.toFixed(4) + ' / Out $' + outputCost.toFixed(4);
}

function renderButtons(data, container) {
    if (!container || !data) return;
    if (data.approve) { var b = document.createElement('button'); b.className = 'minimal-button primary rounded-xl px-3 py-1.5 text-xs font-semibold'; b.textContent = 'Approve'; b.onclick = data.approve; container.appendChild(b); }
    if (data.reject) { var b2 = document.createElement('button'); b2.className = 'minimal-button rounded-xl px-3 py-1.5 text-xs font-semibold ml-2'; b2.textContent = 'Reject'; b2.onclick = data.reject; container.appendChild(b2); }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function prettyJson(obj) {
    if (!obj) return '';
    try { return JSON.stringify(typeof obj === 'string' ? JSON.parse(obj) : obj, null, 2); }
    catch (e) { return String(obj); }
}

function parseStructuredValue(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try { return JSON.parse(value); }
    catch (e) { return null; }
}

function stringifyPanelContent(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    return prettyJson(value);
}

function extractFilePathsFromValue(value) {
    const seen = new Set();
    const paths = [];
    function visit(input) {
        if (!input) return;
        if (typeof input === 'string') {
            const pathPattern = /(?:[A-Za-z]:\\[^\s"'`<>|]+|\/[A-Za-z0-9._\-\/\\]+|(?:^|[\s{[])(?:src|app|lib|public|tests?|docs|scripts|utils|adapters)[\/\\][^\s"'`<>|]+)/g;
            const matches = input.match(pathPattern) || [];
            matches.forEach(match => {
                const cleaned = String(match).trim().replace(/^[{[]/, '').replace(/[,\]}]$/, '');
                if (!cleaned || seen.has(cleaned)) return;
                seen.add(cleaned);
                paths.push(cleaned);
            });
            return;
        }
        if (Array.isArray(input)) { input.forEach(visit); return; }
        if (typeof input === 'object') {
            Object.entries(input).forEach(([key, val]) => {
                if (/(path|file|filename|target|glob|pattern|search_path|relative_path)/i.test(key)) {
                    visit(val);
                } else if (typeof val === 'object' || typeof val === 'string') { visit(val); }
            });
        }
    }
    visit(value);
    return paths.slice(0, 8);
}

function classifyToolAction(name) {
    const lowered = String(name || '').toLowerCase();
    if (/(read|open|view|fetch|get_file|cat)/.test(lowered)) return 'Read';
    if (/(write|edit|patch|replace|create|insert|delete|move|rename|apply)/.test(lowered)) return 'Change';
    if (/(glob|ls|find|search|grep|rg|list)/.test(lowered)) return 'Search';
    return 'Tool';
}

function isFileInteraction(name, args, output) {
    const lowered = String(name || '').toLowerCase();
    if (/(read|write|edit|patch|replace|file|path|glob|grep|find|ls|open|view|cat|delete|move|rename)/.test(lowered)) return true;
    return extractFilePathsFromValue(args).length > 0 || extractFilePathsFromValue(output).length > 0;
}

function buildToolInteraction(kind, payload, source) {
    if (!payload || typeof payload !== 'object') return null;
    const name = payload.name || payload.tool_name || 'unknown';
    const args = payload.arguments ?? payload.input ?? payload.args ?? null;
    const output = payload.output ?? payload.content ?? payload.result ?? null;
    const paths = [...extractFilePathsFromValue(args), ...extractFilePathsFromValue(output)].filter((value, index, arr) => arr.indexOf(value) === index);
    return { kind, source, name, id: payload.id || payload.tool_use_id || payload.tool_call_id || '', action: classifyToolAction(name), isFile: isFileInteraction(name, args, output), paths, argumentsText: stringifyPanelContent(args), outputText: stringifyPanelContent(output) };
}

function extractToolInteractions(item) {
    const interactions = [];
    const requestBody = parseStructuredValue(item.requestBody);
    const responseBody = parseStructuredValue(item.responseBody);
    function pushIfPresent(interaction) {
        if (!interaction) return;
        if (!interaction.argumentsText && !interaction.outputText && interaction.paths.length === 0) return;
        interactions.push(interaction);
    }
    function scanMessages(messages, source) {
        if (!Array.isArray(messages)) return;
        messages.forEach(message => {
            if (!message || typeof message !== 'object') return;
            if (Array.isArray(message.tool_calls)) {
                message.tool_calls.forEach(tc => { pushIfPresent(buildToolInteraction('call', { id: tc.id, name: tc.function?.name, arguments: parseStructuredValue(tc.function?.arguments) || tc.function?.arguments }, source)); });
            }
            if (message.role === 'tool') { pushIfPresent(buildToolInteraction('result', { id: message.tool_call_id, name: 'tool_result', output: parseStructuredValue(message.content) || message.content }, source)); }
            if (Array.isArray(message.content)) {
                message.content.forEach(block => {
                    if (!block || typeof block !== 'object') return;
                    if (block.type === 'tool_use') { pushIfPresent(buildToolInteraction('call', { id: block.id, name: block.name, input: block.input }, source)); }
                    else if (block.type === 'tool_result') { pushIfPresent(buildToolInteraction('result', { id: block.tool_use_id, name: 'tool_result', output: block.content }, source)); }
                });
            }
        });
    }
    function scanTopLevel(parsed, source) {
        if (!parsed || typeof parsed !== 'object') return;
        scanMessages(parsed.messages, source);
        if (Array.isArray(parsed.content)) {
            parsed.content.forEach(block => {
                if (!block || typeof block !== 'object') return;
                if (block.type === 'tool_use') { pushIfPresent(buildToolInteraction('call', { id: block.id, name: block.name, input: block.input }, source)); }
                else if (block.type === 'tool_result') { pushIfPresent(buildToolInteraction('result', { id: block.tool_use_id, name: 'tool_result', output: block.content }, source)); }
            });
        }
        const choice = parsed.choices?.[0];
        if (choice?.message?.tool_calls) {
            choice.message.tool_calls.forEach(tc => { pushIfPresent(buildToolInteraction('call', { id: tc.id, name: tc.function?.name, arguments: parseStructuredValue(tc.function?.arguments) || tc.function?.arguments }, source)); });
        }
        if (Array.isArray(parsed.output)) {
            parsed.output.forEach(entry => {
                if (!entry || typeof entry !== 'object') return;
                if (entry.type === 'function_call') { pushIfPresent(buildToolInteraction('call', { id: entry.call_id || entry.id, name: entry.name, arguments: parseStructuredValue(entry.arguments) || entry.arguments }, source)); }
                else if (entry.type === 'function_call_output') { pushIfPresent(buildToolInteraction('result', { id: entry.call_id || entry.id, name: 'function_call_output', output: entry.output }, source)); }
            });
        }
    }
    scanTopLevel(requestBody, 'request');
    scanTopLevel(responseBody, 'response');
    return interactions;
}

function renderToolInteractionPanels(interactions) {
    if (!Array.isArray(interactions) || interactions.length === 0) return '';
    const fileInteractions = interactions.filter(entry => entry.isFile);
    const otherInteractions = interactions.filter(entry => !entry.isFile);
    const ordered = [...fileInteractions, ...otherInteractions].slice(0, 20);
    return `<div class="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-3"><p class="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 uppercase mb-2">📁 File Activity And Tool Output</p><div class="space-y-3">${ordered.map(renderToolInteractionCard).join('')}</div></div>`;
}

function renderToolInteractionCard(entry) {
    const pathLine = entry.paths.length > 0 ? `<p class="text-[10px] text-emerald-700 dark:text-emerald-300 font-mono break-all">${escapeHtml(entry.paths.join('\n'))}</p>` : '';
    const argsBlock = entry.argumentsText ? `<div><p class="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase mb-1">Input</p><pre class="text-[10px] bg-white dark:bg-slate-800 rounded p-2 overflow-x-auto text-slate-700 dark:text-slate-200">${escapeHtml(entry.argumentsText)}</pre></div>` : '';
    const outputBlock = entry.outputText ? `<div><p class="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase mb-1">Output</p><pre class="text-[10px] bg-white dark:bg-slate-800 rounded p-2 overflow-x-auto text-slate-700 dark:text-slate-200">${escapeHtml(entry.outputText)}</pre></div>` : '';
    return `<div class="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-white/70 dark:bg-slate-900 p-3 space-y-2"><div class="flex items-center justify-between gap-3"><div><p class="text-xs font-bold text-emerald-800 dark:text-emerald-200">${escapeHtml(entry.action)}: ${escapeHtml(entry.name)}</p><p class="text-[10px] text-slate-500 dark:text-slate-400 uppercase">${escapeHtml(entry.source)}${entry.kind === 'result' ? ' result' : ' call'}${entry.id ? ' • ' + escapeHtml(entry.id) : ''}</p></div></div>${pathLine}${argsBlock}${outputBlock}</div>`;
}

function extractResponsePanels(responseBody) {
    const parsed = parseStructuredValue(responseBody);
    if (!parsed) return [];
    const panels = [];
    if (Array.isArray(parsed.content)) {
        parsed.content.forEach(block => {
            if (!block || typeof block !== 'object') return;
            if (block.type === 'thinking' && block.thinking) { panels.push({ tone: 'indigo', title: 'Anthropic Thinking', content: block.thinking }); }
            else if (block.type === 'text' && block.text) { panels.push({ tone: 'slate', title: 'Response Content', content: block.text }); }
            else if (block.type === 'tool_use') { panels.push({ tone: 'orange', title: `Tool Use: ${block.name || 'unknown'}`, content: prettyJson(block.input || block) }); }
            else if (block.type === 'tool_result') { panels.push({ tone: 'amber', title: `Tool Result${block.tool_use_id ? ' (' + block.tool_use_id + ')' : ''}`, content: typeof block.content === 'string' ? block.content : prettyJson(block.content || block) }); }
        });
    }
    const choice = parsed.choices?.[0];
    const reasoningDetails = Array.isArray(choice?.message?.reasoning_details) ? choice.message.reasoning_details.filter(Boolean) : [];
    reasoningDetails.forEach((detail, index) => { const panel = formatReasoningDetail(detail, index); if (panel.content) panels.push(panel); });
    const openAIThinking = choice?.message?.reasoning || choice?.message?.reasoning_content || choice?.message?.thinking;
    const openAIContent = choice?.message?.content || '';
    if (openAIThinking) panels.push({ tone: 'indigo', title: 'Model Thinking', content: openAIThinking });
    if (openAIContent) panels.push({ tone: 'slate', title: 'Response Content', content: openAIContent });
    return panels;
function renderResponsePanel(panel) {
    const styles = { indigo: { box: 'bg-indigo-50 dark:bg-indigo-900/20', title: 'text-indigo-700 dark:text-indigo-300', body: 'text-indigo-900 dark:text-indigo-200' }, orange: { box: 'bg-orange-50 dark:bg-orange-900/20', title: 'text-orange-700 dark:text-orange-300', body: 'text-orange-900 dark:text-orange-200' }, amber: { box: 'bg-amber-50 dark:bg-amber-900/20', title: 'text-amber-700 dark:text-amber-300', body: 'text-amber-900 dark:text-amber-200' }, slate: { box: 'bg-slate-50 dark:bg-slate-900', title: 'text-slate-700 dark:text-slate-200', body: 'text-slate-800 dark:text-slate-100' } };
    const tone = styles[panel.tone] || styles.slate;
    return `<div class="${tone.box} rounded-lg p-3"><p class="text-[10px] font-bold ${tone.title} uppercase mb-1">${escapeHtml(panel.title)}</p><pre class="text-xs ${tone.body} whitespace-pre-wrap font-mono leading-relaxed">${escapeHtml(panel.content)}</pre></div>`;
}

/* ── Config UI ── */
function safeSetVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}
function safeSetText(id, txt) {
    const el = document.getElementById(id);
    if (el) el.innerText = txt;
}

function applyConfigToUI(cfg) {
    currentConfigState = JSON.parse(JSON.stringify(cfg || {}));
    if (cfg.claude) {
        safeSetVal('claudePublicModel', cfg.claude.currentModel || DEFAULT_CLAUDE_PUBLIC_ALIAS);
        setSelectValue('claudeModelSelect', cfg.claude._upstreamModel || cfg.claude.currentModel);
        safeSetVal('claudeTargetUrl', cfg.claude.targetUrl || '');
        safeSetVal('claudeApiKey', cfg.claude.apiKey || '');
        safeSetVal('claudeContextWindow', cfg.claude.contextWindow ? cfg.claude.contextWindow.toLocaleString() + ' tokens' : '');
        safeSetVal('overviewClaudeInCost', cfg.claude.inputCostPer1M || '');
        safeSetVal('overviewClaudeOutCost', cfg.claude.outputCostPer1M || '');
        safeSetText('claudeStatusModel', cfg.claude.currentModel || '--');
        safeSetText('claudeStatusAlias', 'Public alias: ' + (cfg.claude.currentModel || DEFAULT_CLAUDE_PUBLIC_ALIAS));
        safeSetText('claudeStatusProvider', extractProvider(cfg.claude.targetUrl));
        safeSetText('claudeStatusContext', cfg.claude.contextWindow ? formatTokenCount(cfg.claude.contextWindow) + ' ctx' : '--');
        safeSetText('claudeOptimizationHint', getOptimizationSummary(cfg.claude, 'claude'));
    }
    if (cfg.codex) {
        setSelectValue('codexModelSelect', cfg.codex.currentModel);
        safeSetVal('codexTargetUrl', cfg.codex.targetUrl || '');
        safeSetVal('codexApiKey', cfg.codex.apiKey || '');
        safeSetVal('codexContextWindow', cfg.codex.contextWindow ? cfg.codex.contextWindow.toLocaleString() + ' tokens' : '');
        safeSetVal('overviewCodexInCost', cfg.codex.inputCostPer1M || '');
        safeSetVal('overviewCodexOutCost', cfg.codex.outputCostPer1M || '');
        safeSetText('codexStatusModel', cfg.codex.currentModel || '--');
        safeSetText('codexStatusProvider', extractProvider(cfg.codex.targetUrl));
        safeSetText('codexStatusContext', cfg.codex.contextWindow ? formatTokenCount(cfg.codex.contextWindow) + ' ctx' : '--');
        safeSetText('codexOptimizationHint', getOptimizationSummary(cfg.codex, 'codex'));
    }
    if (cfg.customProvider) {
        safeSetVal('customBaseUrl', cfg.customProvider.baseUrl || '');
        safeSetVal('customApiKey', cfg.customProvider.apiKey || '');
    }
    safeSetVal('requestLogLimit', cfg.requestLogLimit || DEFAULT_REQUEST_LOG_LIMIT);
    safeSetVal('pendingTimeoutMinutes', cfg.pendingRequestTimeoutMinutes || DEFAULT_PENDING_TIMEOUT_MINUTES);
    const memoryLimitInput = document.getElementById('memoryContextMaxChars');
    if (memoryLimitInput) memoryLimitInput.value = cfg.memoryContextMaxChars || DEFAULT_MEMORY_CONTEXT_MAX_CHARS;
    updateConfigDisplay(cfg);
    updateClineInfo();
    updateOverviewSummary(cfg);
    rerenderCostSummary();
    onClaudeAliasChange();
    if (cfg.claude && cfg.claude.currentModel) refreshContextWindow('claude');
    if (cfg.codex && cfg.codex.currentModel) refreshContextWindow('codex');
}

function setSelectValue(id, value) {
    const select = document.getElementById(id);
    if (!select || !value) return;
    let found = false;
    for (let i = 0; i < select.options.length; i++) { if (select.options[i].value === value) { found = true; break; } }
    if (found) { select.value = value; }
    else { const opt = document.createElement('option'); opt.value = value; opt.innerText = value; select.insertBefore(opt, select.firstChild); select.value = value; }
}

function maskSecretValue(value) {
    if (value === null || value === undefined || value === '') return value;
    const text = String(value);
    if (/^\$\{env:/i.test(text)) return text;
    if (text.length <= 10) return '***';
    return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function redactConfigForDisplay(value, keyName = '') {
    const sensitiveKey = /(api[-_]?key|token|secret|authorization|password|credential)/i.test(keyName);
    if (sensitiveKey) return maskSecretValue(value);
    if (Array.isArray(value)) return value.map(item => redactConfigForDisplay(item));
    if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactConfigForDisplay(child, key)])); }
    return value;
}

function updateConfigDisplay(cfg) {
    const safeCfg = redactConfigForDisplay(JSON.parse(JSON.stringify(cfg || {})));
    ['claude', 'codex'].forEach(profile => { if (!safeCfg[profile] || typeof safeCfg[profile] !== 'object') return; Object.keys(safeCfg[profile]).forEach(key => { if (key.startsWith('_') && key !== '_upstreamModel') delete safeCfg[profile][key]; }); });
    document.getElementById('currentConfig').innerText = JSON.stringify(safeCfg, null, 2);
}

function updateClineInfo() {
    document.getElementById('clineBaseUrl').value = 'http://localhost:8085';
    const overviewField = document.getElementById('overviewClineBaseUrl');
    if (overviewField) overviewField.value = 'http://localhost:8085';
}

function updateOverviewSummary(cfg) {
    const claudeModel = cfg?.claude?.currentModel || '--';
    const codexModel = cfg?.codex?.currentModel || '--';
    const claudeRoute = cfg?.claude?.targetUrl || '--';
    const codexRoute = cfg?.codex?.targetUrl || '--';
    const customBase = cfg?.customProvider?.baseUrl || '--';
    document.getElementById('sidebarClaudeModel').innerText = claudeModel;
    document.getElementById('sidebarCodexModel').innerText = codexModel;
    document.getElementById('overviewClaudeRoute').innerText = claudeRoute;
    document.getElementById('overviewClaudeBase').innerText = extractApiBaseUrl(claudeRoute);
    document.getElementById('overviewClaudeFeatures').innerText = getOptimizationSummary(cfg?.claude, 'claude');
    document.getElementById('overviewCodexRoute').innerText = codexRoute;
    document.getElementById('overviewCodexBase').innerText = extractApiBaseUrl(codexRoute);
    document.getElementById('overviewCodexFeatures').innerText = getOptimizationSummary(cfg?.codex, 'codex');
    document.getElementById('overviewCustomBase').innerText = customBase;
    syncProfileToOverview('claude');
    syncProfileToOverview('codex');
}

function syncSummaryFromUI() {
    document.getElementById('sidebarClaudeModel').innerText = document.getElementById('claudeStatusModel').innerText || '--';
    document.getElementById('sidebarCodexModel').innerText = document.getElementById('codexStatusModel').innerText || '--';
    const claudeRoute = document.getElementById('claudeTargetUrl').value || '--';
    const codexRoute = document.getElementById('codexTargetUrl').value || '--';
    const customBase = document.getElementById('customBaseUrl').value || '--';
    const liveClaude = getLiveProfileState('claude');
    const liveCodex = getLiveProfileState('codex');
    document.getElementById('overviewClaudeRoute').innerText = claudeRoute;
    document.getElementById('overviewClaudeBase').innerText = extractApiBaseUrl(claudeRoute);
    document.getElementById('overviewClaudeFeatures').innerText = getOptimizationSummary(liveClaude, 'claude');
    document.getElementById('overviewCodexRoute').innerText = codexRoute;
    document.getElementById('overviewCodexBase').innerText = extractApiBaseUrl(codexRoute);
    document.getElementById('overviewCodexFeatures').innerText = getOptimizationSummary(liveCodex, 'codex');
    document.getElementById('overviewCustomBase').innerText = customBase;
    const claudeHint = document.getElementById('claudeOptimizationHint');
    const codexHint = document.getElementById('codexOptimizationHint');
    if (claudeHint) claudeHint.innerText = getOptimizationSummary(liveClaude, 'claude');
    if (codexHint) codexHint.innerText = getOptimizationSummary(liveCodex, 'codex');
}

/* ── Dark Mode ── */
function initDarkMode() {
    const saved = localStorage.getItem('august-dark');
    const shouldBeDark = saved === 'true';
    const html = document.documentElement;
    if (shouldBeDark) {
        html.classList.add('dark');
        document.getElementById('moonIcon')?.classList.add('hidden');
        document.getElementById('sunIcon')?.classList.remove('hidden');
        document.querySelector('.sidebar-moon')?.classList.add('hidden');
        document.querySelector('.sidebar-sun')?.classList.remove('hidden');
    } else {
        html.classList.remove('dark');
        document.getElementById('moonIcon')?.classList.remove('hidden');
        document.getElementById('sunIcon')?.classList.add('hidden');
        document.querySelector('.sidebar-moon')?.classList.remove('hidden');
        document.querySelector('.sidebar-sun')?.classList.add('hidden');
    }
}
function toggleDarkMode() {
    const html = document.documentElement;
    const isDark = html.classList.toggle('dark');
    localStorage.setItem('august-dark', isDark);
    document.getElementById('moonIcon')?.classList.toggle('hidden');
    document.getElementById('sunIcon')?.classList.toggle('hidden');
    document.querySelector('.sidebar-moon')?.classList.toggle('hidden');
    document.querySelector('.sidebar-sun')?.classList.toggle('hidden');
}

/* ── Test Result Modal ── */
function showTestResult(title, content, isError) {
    const modal = document.getElementById('testResultModal');
    const titleEl = document.getElementById('testResultTitle');
    const bodyEl = document.getElementById('testResultBody');
    titleEl.innerText = title;
    titleEl.className = 'text-sm font-bold ' + (isError ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400');
    bodyEl.innerText = content;
    bodyEl.className = 'text-xs font-mono p-4 rounded-xl border whitespace-pre-wrap break-words max-h-[50vh] overflow-y-auto ' + (isError ? 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border-red-200 dark:border-red-800' : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-800');
    modal.classList.remove('hidden');
}
function closeTestResult() { document.getElementById('testResultModal').classList.add('hidden'); }
function copyTestResult() {
    const text = document.getElementById('testResultBody').innerText;
    navigator.clipboard.writeText(text).then(() => {
        const btn = event.target;
        const orig = btn.innerText;
        btn.innerText = '✅ Copied';
        setTimeout(() => btn.innerText = orig, 1500);
    });
}

/* ── Toast ── */
function showStatus(message, classes) {
    const toast = document.getElementById('statusToast');
    toast.className = 'fixed bottom-4 right-4 px-5 py-3 rounded-xl shadow-xl text-sm font-medium transition-all duration-300 z-50 ' + classes;
    toast.innerText = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(8px)'; }, 3000);
}

/* ── Markdown ── */
function renderMarkdown(text) {
    if (!text) return '';
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') { return escapeHtml(text); }
    marked.setOptions({ gfm: true, breaks: true });
    const raw = marked.parse(text);
    const clean = DOMPurify.sanitize(raw);
    return clean;
}

function highlightCodeBlocks(container) {
    if (typeof hljs === 'undefined') return;
    container.querySelectorAll('pre code[class*="language-"]').forEach(block => { hljs.highlightElement(block); });
}

function attachCopyButtons(container) {
    container.querySelectorAll('pre').forEach(pre => {
        if (pre.querySelector('.copy-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.onclick = () => {
            const code = pre.querySelector('code');
            const text = code ? code.textContent : pre.textContent;
            navigator.clipboard.writeText(text).then(() => { btn.textContent = 'Copied!'; btn.classList.add('copied'); setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000); }).catch(() => { btn.textContent = 'Failed'; });
        };
        pre.appendChild(btn);
    });
}

/* ── SSE ── */
function connectSSE() {
    console.log('[SSE] Connecting...');
    if (liveStream) { liveStream.close(); }
    const generation = ++liveStreamGeneration;
    const es = new EventSource('/ui/stream?' + getPeriodQueryString(currentPeriod));
    liveStream = es;
    es.onopen = function() { console.log('[SSE] Connected'); };
    es.onmessage = function(event) {
        if (generation !== liveStreamGeneration || liveStream !== es) return;
        try {
            const d = JSON.parse(event.data);
            if (d.stats) renderStats(d.stats);
            if (d.pending) renderPending(d.pending);
            if (d.completed) renderCompleted(d.completed);
            if (d.activity) renderActivity(d.activity);
            updateDebugStamp('requests', `SSE • ${(d.stats?.pendingRequests || 0)} pending`);
        } catch (e) { console.error('[SSE] render error:', e); }
    };
    es.onerror = function() {
        if (generation !== liveStreamGeneration) return;
        es.close();
        if (liveStream === es) { liveStream = null; }
        if (_sseRetryTimeout) clearTimeout(_sseRetryTimeout);
        _sseRetryTimeout = setTimeout(connectSSE, 3000);
        updateDebugStamp('requests', 'SSE reconnect scheduled');
    };
}
function reconnectSSE() {
    if (_sseRetryTimeout) { clearTimeout(_sseRetryTimeout); _sseRetryTimeout = null; }
    connectSSE();
}

function syncProfileToOverview(profile) {
    // Stub function to prevent ReferenceErrors during synchronization.
}

async function syncCostToProfile(profile, direction) {
    if (!currentConfigState || !currentConfigState[profile]) return;
    const inputId = `overview${profile.charAt(0).toUpperCase() + profile.slice(1)}${direction === 'in' ? 'In' : 'Out'}Cost`;
    const val = parseFloat(document.getElementById(inputId)?.value) || 0;
    if (direction === 'in') {
        currentConfigState[profile].inputCostPer1M = val;
    } else {
        currentConfigState[profile].outputCostPer1M = val;
    }
    
    try {
        const payload = {
            profile: profile,
            currentModel: currentConfigState[profile].currentModel,
            targetUrl: currentConfigState[profile].targetUrl,
            apiKey: currentConfigState[profile].apiKey,
            inputCostPer1M: currentConfigState[profile].inputCostPer1M,
            outputCostPer1M: currentConfigState[profile].outputCostPer1M,
            contextWindow: currentConfigState[profile].contextWindow
        };
        await fetch('/ui/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        rerenderCostSummary();
    } catch (e) {
        console.error('Failed to sync cost to profile:', e);
    }
}

function formatReasoningDetail(detail, index) {
    let content = '';
    if (typeof detail === 'string') {
        content = detail;
    } else if (detail && typeof detail === 'object') {
        content = detail.text || detail.content || JSON.stringify(detail);
    }
    return {
        tone: 'indigo',
        title: `Reasoning Detail #${index + 1}`,
        content: content
    };
}

