/* August Console: terminal-style UI backed by the Workbench execution engine. */

let augustConsoleSession = null;
let augustConsoleInitialized = false;
let augustConsoleBusy = false;
let augustConsoleHistory = [];
let augustConsoleHistoryIndex = 0;
let augustConsoleThinkingEntry = null;

function augustConsoleEscape(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function initAugustConsoleUI() {
    if (augustConsoleInitialized) return;
    augustConsoleInitialized = true;
    autoResizeAugustConsoleInput(document.getElementById('augustConsoleInput'));
    ensureAugustConsoleSession().catch(e => appendAugustConsoleEntry('error', 'session', e.message));
    loadAugustConsoleSnapshot();
}

function fillAugustConsoleInput(text) {
    const input = document.getElementById('augustConsoleInput');
    if (!input) return;
    input.value = text || '';
    autoResizeAugustConsoleInput(input);
    input.focus();
}

function autoResizeAugustConsoleInput(input) {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 150) + 'px';
}

function handleAugustConsoleKeydown(event) {
    const input = event.currentTarget || event.target;
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendAugustConsoleInput();
        return;
    }
    if (event.key === 'ArrowUp' && !input.value.trim() && augustConsoleHistory.length) {
        event.preventDefault();
        augustConsoleHistoryIndex = Math.max(0, augustConsoleHistoryIndex - 1);
        input.value = augustConsoleHistory[augustConsoleHistoryIndex] || '';
        autoResizeAugustConsoleInput(input);
        return;
    }
    if (event.key === 'ArrowDown' && augustConsoleHistory.length) {
        event.preventDefault();
        augustConsoleHistoryIndex = Math.min(augustConsoleHistory.length, augustConsoleHistoryIndex + 1);
        input.value = augustConsoleHistory[augustConsoleHistoryIndex] || '';
        autoResizeAugustConsoleInput(input);
    }
}

function setAugustConsoleStatus(text, tone = 'ready') {
    const status = document.getElementById('augustConsoleStatus');
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone;
}

function getAugustConsoleProvider() {
    return document.getElementById('augustConsoleProvider')?.value === 'codex' ? 'codex' : 'claude';
}

async function ensureAugustConsoleSession() {
    if (augustConsoleSession?.id) {
        renderAugustConsolePlan();
        return augustConsoleSession;
    }
    const res = await fetch('/ui/workbench/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: getAugustConsoleProvider(), surface: 'august-console' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create August session');
    augustConsoleSession = data;
    renderAugustConsolePlan();
    return augustConsoleSession;
}

function renderAugustConsolePlan() {
    const planEl = document.getElementById('augustConsolePlan');
    const approveBtn = document.getElementById('augustConsoleApproveBtn');
    const gateBadge = document.getElementById('augustConsoleGateBadge');
    if (!planEl || !approveBtn || !gateBadge) return;

    const plan = augustConsoleSession?.plan;
    const approved = augustConsoleSession?.approved === true;
    approveBtn.disabled = !plan || approved;
    gateBadge.textContent = approved ? 'approved' : (plan ? 'waiting' : 'locked');
    gateBadge.className = 'august-console-badge ' + (approved ? 'ok' : 'warn');

    if (!plan) {
        planEl.textContent = 'No plan submitted yet.';
        return;
    }

    const rows = [];
    if (plan.summary) rows.push(`<p>${renderMarkdown(plan.summary)}</p>`);
    if (Array.isArray(plan.steps) && plan.steps.length) {
        rows.push('<div class="august-console-plan-label">Steps</div>');
        rows.push('<ol>' + plan.steps.map(step => `<li>${renderMarkdown(step)}</li>`).join('') + '</ol>');
    }
    if (Array.isArray(plan.files) && plan.files.length) {
        rows.push('<div class="august-console-plan-label">Files</div>');
        rows.push('<ul>' + plan.files.map(file => `<li><code>${augustConsoleEscape(file)}</code></li>`).join('') + '</ul>');
    }
    if (Array.isArray(plan.verification) && plan.verification.length) {
        rows.push('<div class="august-console-plan-label">Verify</div>');
        rows.push('<ul>' + plan.verification.map(item => `<li>${augustConsoleEscape(item)}</li>`).join('') + '</ul>');
    }
    rows.push(`<div class="august-console-plan-state">${approved ? 'Approved. Planned mutations are unlocked.' : 'Waiting for approval. Mutations remain blocked.'}</div>`);
    planEl.innerHTML = rows.join('');
}

function resetAugustConsoleThinking() {
    if (augustConsoleThinkingEntry?.isConnected) {
        augustConsoleThinkingEntry.classList.remove('is-running');
        const title = augustConsoleThinkingEntry.querySelector('.august-console-entry-title');
        if (title) title.textContent = 'thinking complete';
    }
    augustConsoleThinkingEntry = null;
}

function appendAugustConsoleEntry(kind, title, content, options = {}) {
    const output = document.getElementById('augustConsoleOutput');
    if (!output) return null;
    const entry = document.createElement('div');
    entry.className = `august-console-entry is-${kind}`;
    const contentText = content == null ? '' : String(content);
    const body = options.markdown
        ? `<div class="md-content">${renderMarkdown(contentText)}</div>`
        : `<pre>${augustConsoleEscape(contentText)}</pre>`;
    entry.innerHTML = `
        <div class="august-console-entry-title">${augustConsoleEscape(title || kind)}</div>
        <div class="august-console-entry-body">${body}</div>
    `;
    output.appendChild(entry);
    const md = entry.querySelector('.md-content');
    if (md) {
        highlightCodeBlocks(md);
        attachCopyButtons(md);
    }
    output.scrollTop = output.scrollHeight;
    return entry;
}

function appendAugustConsolePrompt(text) {
    return appendAugustConsoleEntry('prompt', 'august> ' + text, '', { compact: true });
}

function summarizeAugustPayload(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    const direct = value.command || value.path || value.query || value.url || value.name || value.summary;
    if (direct) return String(direct);
    try { return JSON.stringify(value, null, 2).slice(0, 1200); } catch (e) { return String(value); }
}

function handleAugustConsoleSSEEvent(event, data) {
    if (event === 'thinking') {
        if (!augustConsoleThinkingEntry?.isConnected) {
            augustConsoleThinkingEntry = appendAugustConsoleEntry('thinking is-running', 'thinking', '');
        }
        const pre = augustConsoleThinkingEntry?.querySelector('pre');
        if (pre) pre.textContent += data?.content || '';
        return;
    }
    if (event === 'tool_use') {
        resetAugustConsoleThinking();
        const summary = summarizeAugustPayload(data?.input);
        appendAugustConsoleEntry('tool', `tool: ${data?.name || 'unknown'}`, summary || '(no input)');
        return;
    }
    if (event === 'tool_result') {
        const text = typeof data?.content === 'string' ? data.content : JSON.stringify(data?.content || {}, null, 2);
        appendAugustConsoleEntry(data?.is_error ? 'error' : 'result', data?.is_error ? 'tool error' : 'tool result', text);
        return;
    }
    if (event === 'text') {
        resetAugustConsoleThinking();
        appendAugustConsoleEntry('assistant', 'august', data?.content || '', { markdown: true });
        return;
    }
    if (event === 'session') {
        augustConsoleSession = data;
        renderAugustConsolePlan();
        setAugustConsoleStatus(augustConsoleSession.approved ? 'approved' : (augustConsoleSession.plan ? 'plan pending' : 'ready'));
        return;
    }
    if (event === 'error') {
        resetAugustConsoleThinking();
        appendAugustConsoleEntry('error', 'error', data?.message || 'Unknown error');
    }
}

async function readAugustConsoleSSE(reader) {
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = '';
    let eventData = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (line.startsWith('event: ')) eventName = line.slice(7).trim();
            else if (line.startsWith('data: ')) eventData = line.slice(6).trim();
            else if (line === '' && eventName && eventData) {
                try { handleAugustConsoleSSEEvent(eventName, JSON.parse(eventData)); } catch (e) {}
                eventName = '';
                eventData = '';
            }
        }
    }
    if (eventName && eventData) {
        try { handleAugustConsoleSSEEvent(eventName, JSON.parse(eventData)); } catch (e) {}
    }
}

async function sendAugustConsoleMessage(message) {
    const text = String(message || '').trim();
    if (!text || augustConsoleBusy) return;
    await ensureAugustConsoleSession();
    augustConsoleBusy = true;
    setAugustConsoleStatus('working', 'busy');
    appendAugustConsolePrompt(text);
    try {
        const res = await fetch('/ui/workbench/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: augustConsoleSession.id,
                provider: getAugustConsoleProvider(),
                message: text
            })
        });
        if (!res.ok) {
            const errorText = await res.text();
            let message = errorText || 'August request failed';
            try { message = JSON.parse(errorText).error || message; } catch (e) {}
            throw new Error(message);
        }
        await readAugustConsoleSSE(res.body.getReader());
    } catch (e) {
        appendAugustConsoleEntry('error', 'request failed', e.message);
        setAugustConsoleStatus('error', 'error');
    } finally {
        resetAugustConsoleThinking();
        augustConsoleBusy = false;
        setAugustConsoleStatus(augustConsoleSession?.approved ? 'approved' : 'ready');
        renderAugustConsolePlan();
        loadAugustConsoleSnapshot();
    }
}

function sendAugustConsoleInput() {
    const input = document.getElementById('augustConsoleInput');
    const text = input?.value.trim();
    if (!text) return;
    augustConsoleHistory.push(text);
    augustConsoleHistory = augustConsoleHistory.slice(-80);
    augustConsoleHistoryIndex = augustConsoleHistory.length;
    input.value = '';
    autoResizeAugustConsoleInput(input);
    sendAugustConsoleCommand(text);
}

function printAugustConsoleHelp() {
    appendAugustConsoleEntry('system', 'commands', [
        ':help                 show console commands',
        ':diagnose             inspect proxy, memory, MCP, and recent errors',
        ':tools                list Workbench tools and approval requirements',
        ':plan <task>          ask August to create a plan first',
        ':approve              approve the currently submitted plan',
        ':provider claude      switch to Claude-shaped proxy route',
        ':provider codex       switch to Codex/OpenAI-shaped proxy route',
        ':new                  start a fresh August session',
        ':clear                clear the console'
    ].join('\n'));
}

function sendAugustConsoleCommand(raw) {
    const text = String(raw || '').trim();
    if (!text) return;
    const lower = text.toLowerCase();
    if (lower === ':clear') {
        clearAugustConsoleOutput();
        return;
    }
    if (lower === ':help') {
        appendAugustConsolePrompt(text);
        printAugustConsoleHelp();
        return;
    }
    if (lower === ':new') {
        appendAugustConsolePrompt(text);
        resetAugustConsoleUI();
        return;
    }
    if (lower === ':approve') {
        appendAugustConsolePrompt(text);
        approveAugustConsolePlanUI();
        return;
    }
    if (lower.startsWith(':provider')) {
        appendAugustConsolePrompt(text);
        const provider = lower.includes('codex') ? 'codex' : 'claude';
        const select = document.getElementById('augustConsoleProvider');
        if (select) select.value = provider;
        resetAugustConsoleUI();
        return;
    }
    if (lower === ':diagnose') {
        sendAugustConsoleMessage('Diagnose the proxy health, August Brain, vector memory, Supermemory, MCP, skills, plugins, tools, and recent errors. Start with workbench_diagnose_proxy.');
        return;
    }
    if (lower === ':tools') {
        sendAugustConsoleMessage('List every Workbench, August, web, MCP, Cowork, skill, and host-control capability available in this session. Group them by read-only versus approval-required mutation.');
        return;
    }
    if (lower.startsWith(':plan')) {
        const task = text.slice(':plan'.length).trim();
        sendAugustConsoleMessage('Create a concise implementation plan first and wait for my explicit approval before changing anything. Task: ' + (task || 'Ask me what to plan.'));
        return;
    }
    if (text.startsWith(':')) {
        appendAugustConsolePrompt(text);
        appendAugustConsoleEntry('error', 'unknown command', 'Unknown command. Type :help for available commands.');
        return;
    }
    sendAugustConsoleMessage(text);
}

function clearAugustConsoleOutput() {
    const output = document.getElementById('augustConsoleOutput');
    if (!output) return;
    output.innerHTML = '';
    appendAugustConsoleEntry('system', 'console cleared', 'August Console is ready. Type :help for commands.');
}

async function resetAugustConsoleUI() {
    const previousId = augustConsoleSession?.id;
    try {
        const res = await fetch('/ui/workbench/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: previousId, provider: getAugustConsoleProvider() })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not reset August session');
        augustConsoleSession = data;
        renderAugustConsolePlan();
        clearAugustConsoleOutput();
        appendAugustConsoleEntry('system', 'new session', `Provider: ${getAugustConsoleProvider()}\nApproval gate: locked until a plan is approved.`);
        setAugustConsoleStatus('ready');
    } catch (e) {
        appendAugustConsoleEntry('error', 'reset failed', e.message);
    }
}

async function approveAugustConsolePlanUI() {
    await ensureAugustConsoleSession();
    if (!augustConsoleSession?.plan) {
        appendAugustConsoleEntry('error', 'approval', 'No submitted plan is waiting for approval.');
        return;
    }
    try {
        const res = await fetch('/ui/workbench/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: augustConsoleSession.id })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not approve plan');
        augustConsoleSession = data;
        renderAugustConsolePlan();
        appendAugustConsoleEntry('system', 'approved', 'Plan approved. Ask August to implement the approved plan when you are ready.');
        showStatus('August plan approved', 'bg-emerald-600 text-white');
    } catch (e) {
        appendAugustConsoleEntry('error', 'approval failed', e.message);
    }
}

async function augustConsoleFetchJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

async function loadAugustConsoleSnapshot() {
    const host = document.getElementById('augustConsoleCapabilities');
    if (!host) return;
    try {
        const [capabilities, diagnostics] = await Promise.all([
            augustConsoleFetchJson('/ui/workbench/capabilities'),
            augustConsoleFetchJson('/ui/brain/diagnostics')
        ]);
        const groups = capabilities.groups || {};
        const groupRows = Object.entries(groups)
            .map(([name, tools]) => ({ name, count: Array.isArray(tools) ? tools.length : 0 }))
            .filter(row => row.count > 0)
            .sort((a, b) => b.count - a.count)
            .slice(0, 8);
        host.innerHTML = `
            <div class="august-console-cap-grid">
                <span><strong>${Number(capabilities.totalTools || 0)}</strong> tools</span>
                <span><strong>${diagnostics.summary?.overall || 'unknown'}</strong> brain</span>
            </div>
            <div class="august-console-cap-list">
                ${groupRows.map(row => `<span>${augustConsoleEscape(row.name)} <b>${row.count}</b></span>`).join('')}
            </div>
        `;
    } catch (e) {
        host.innerHTML = `<span class="august-console-error-text">${augustConsoleEscape(e.message)}</span>`;
    }
}
