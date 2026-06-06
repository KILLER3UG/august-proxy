/* ── AI Workbench (Claude Desktop 2026 + Codex CLI style) ── */

/* Helper: fill prompt from welcome chips */
function fillWorkbenchPrompt(text) {
    const input = document.getElementById('workbenchInput');
    if (input) {
        input.value = text;
        autoResizeTextarea(input);
        closeSlashPalette();
        input.focus();
    }
}

const WORKBENCH_BASE_SLASH_COMMANDS = [
    {
        id: 'cmd-skills',
        label: '/skills',
        title: 'Show skills',
        kind: 'command',
        description: 'List available skills and when to use them.',
        insert: 'List the available skills I can use and when each one fits.'
    },
    {
        id: 'cmd-tools',
        label: '/tools',
        title: 'Show tools',
        kind: 'command',
        description: 'List the proxy tools grouped by capability.',
        insert: 'List the Workbench tools I can use, grouped by capability.'
    },
    {
        id: 'cmd-agents',
        label: '/agents',
        title: 'Show agents',
        kind: 'command',
        description: 'List build, plan, explore, and general agents with inherited permissions.',
        insert: 'List the Workbench agent registry and explain inherited permissions.'
    },
    {
        id: 'cmd-btw',
        label: '/btw',
        title: 'Ask aside',
        kind: 'side chat',
        description: 'Ask a quick side question while the main agent keeps running.',
        insert: '/btw '
    },
    {
        id: 'cmd-goal',
        label: '/goal',
        title: 'Set goal',
        kind: 'autonomy',
        description: 'Keep the agent working until the goal evaluator says the goal is reached.',
        insert: '/goal '
    },
    {
        id: 'cmd-goal-clear',
        label: '/goal clear',
        title: 'Clear goal',
        kind: 'autonomy',
        description: 'Stop the active goal loop.',
        insert: '/goal clear'
    },
    {
        id: 'cmd-fetch-skill',
        label: '/fetch-skill',
        title: 'Fetch a skill',
        kind: 'command',
        description: 'Find and preview a skill from the web or GitHub.',
        insert: 'Find a skill from the internet or GitHub for: '
    },
    {
        id: 'cmd-plan',
        label: '/plan',
        title: 'Create a plan',
        kind: 'command',
        description: 'Ask August to plan first and wait for approval.',
        insert: 'Create a plan first and wait for my approval before changing anything: '
    },
    {
        id: 'cmd-diagnose',
        label: '/diagnose',
        title: 'Diagnose proxy',
        kind: 'command',
        description: 'Check proxy health, memory, MCP, tools, and recent errors.',
        insert: 'Diagnose the proxy health, August Brain, MCP, tools, and recent errors.'
    },
    {
        id: 'cmd-help',
        label: '/help',
        title: 'Workbench help',
        kind: 'command',
        description: 'Explain the current Workbench session and approval gate.',
        insert: 'Explain what you can do in this Workbench session and what requires approval.'
    }
];

let slashCommandsCache = null;
let slashActiveIndex = 0;
let slashVisibleCommands = [];
let slashQueryState = null;
let slashRenderSeq = 0;
let workbenchAgentsCache = null;
let workbenchMainBusy = false;
let workbenchBtwBusy = false;

const WORKBENCH_TYPING_INTERVAL_MS = 16;

function prefersReducedWorkbenchMotion() {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function getWorkbenchTypingChunk(fullLength, remaining) {
    if (fullLength > 6000) return Math.min(remaining, 28);
    if (fullLength > 1800) return Math.min(remaining, 14);
    if (fullLength > 600) return Math.min(remaining, 7);
    return Math.min(remaining, 3);
}

function applyTypingContent(target, text, markdown) {
    if (markdown) target.innerHTML = renderMarkdown(text || '');
    else target.textContent = text || '';
    if (target && target.classList.contains('wb-typing-output')) {
        parseAndRenderTodosFromText(text);
    }
}

function parseAndRenderTodosFromText(text) {
    if (!text) return;
    const lines = text.split('\n');
    const todos = [];
    const todoRegex = /^\s*[-*+]?\s*\d*\.?\s*\[\s*([ xX\/]?)\s*\]\s*(.+)$/;
    
    for (const line of lines) {
        const match = line.match(todoRegex);
        if (match) {
            const check = match[1].toLowerCase();
            const content = match[2].trim();
            let status = 'pending';
            if (check === 'x') {
                status = 'completed';
            } else if (check === '/') {
                status = 'in_progress';
            }
            todos.push({
                id: `todo_${todos.length + 1}`,
                content,
                status
            });
        }
    }
    
    if (todos.length > 0) {
        renderWorkbenchTodos({ todos });
    }
}

function finalizeTypingJob(job) {
    if (!job || !job.target) return;
    job.target.classList.remove('is-typing');
    job.target._wbTypingJob = null;
    job.target._wbTypingRendered = job.full.length;
    applyTypingContent(job.target, job.full, job.markdown);
    if (typeof job.onDone === 'function') job.onDone(job.target);
}

function runTypingJob(job) {
    if (!job || !job.target?.isConnected) return;
    const remaining = job.full.length - job.rendered;
    if (remaining <= 0) {
        finalizeTypingJob(job);
        return;
    }
    job.rendered += getWorkbenchTypingChunk(job.full.length, remaining);
    applyTypingContent(job.target, job.full.slice(0, job.rendered), job.markdown);
    const messages = document.getElementById('workbenchMessages');
    if (messages) messages.scrollTop = messages.scrollHeight;
    job.timer = setTimeout(() => runTypingJob(job), WORKBENCH_TYPING_INTERVAL_MS);
}

function enqueueTypingText(target, text, options = {}) {
    if (!target || text == null) return;
    const chunk = String(text);
    if (!chunk) return;
    const markdown = options.markdown !== false;
    if (prefersReducedWorkbenchMotion()) {
        const fullText = (target._wbTypingFull || (markdown ? target.textContent : target.textContent) || '') + chunk;
        target._wbTypingFull = fullText;
        target._wbTypingRendered = fullText.length;
        applyTypingContent(target, fullText, markdown);
        if (typeof options.onDone === 'function') options.onDone(target);
        return;
    }
    let job = target._wbTypingJob;
    if (!job) {
        job = {
            target,
            markdown,
            full: target._wbTypingFull || '',
            rendered: Number(target._wbTypingRendered || 0),
            timer: null,
            onDone: options.onDone || null
        };
        target._wbTypingJob = job;
    }
    job.markdown = markdown;
    if (options.onDone) job.onDone = options.onDone;
    job.full += chunk;
    target._wbTypingFull = job.full;
    target.classList.add('is-typing');
    if (!job.timer) runTypingJob(job);
}

function invalidateWorkbenchSlashCommands() {
    slashCommandsCache = null;
}

function parseWorkbenchInputCommand(text) {
    const match = String(text || '').trim().match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    return { command: match[1].toLowerCase(), arg: String(match[2] || '').trim() };
}

function isBtwCommandText(text) {
    return parseWorkbenchInputCommand(text)?.command === 'btw';
}

function isGoalCommandText(text) {
    return parseWorkbenchInputCommand(text)?.command === 'goal';
}

/* Remove welcome screen on first interaction */
function removeWelcome() {
    const w = document.getElementById('wbWelcome');
    if (w) w.remove();
}

/* ── Flat-Text Message Renderer ── */
function renderWorkbenchMessage(role, text, msgIndex, options = {}) {
    const messages = document.getElementById('workbenchMessages');
    if (!messages) return;
    removeWelcome();
    const isUser = role === 'user';
    const shouldType = !isUser && options.typing !== false;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const bodyHtml = shouldType ? '' : (isUser ? escapeHtml(text || '') : renderMarkdown(text || ''));
    const contentClass = isUser ? 'whitespace-pre-wrap' : `md-content${shouldType ? ' wb-typing-output' : ''}`;
    const idx = msgIndex != null ? msgIndex : Date.now();
    const roleLabel = isUser ? 'You' : '✦ August';
    const roleClass = isUser ? '' : 'is-assistant';
    const copyBtn = `<button onclick="copyMessage(this)" title="Copy"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg></button>`;
    const regenBtn = isUser ? '' : `<button onclick="regenerateMessage(this)" title="Regenerate"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg></button>`;

    messages.insertAdjacentHTML('beforeend', `
        <div class="wb-msg ${isUser ? 'is-user' : 'is-assistant'}" data-msg-idx="${idx}">
            <div class="wb-msg-actions">${copyBtn}${regenBtn}</div>
            <div class="wb-msg-header">
                <span class="wb-msg-role ${roleClass}">${roleLabel}</span>
                <span class="wb-msg-time">${time}</span>
            </div>
            <div class="wb-msg-body">
                <div class="${contentClass}">${bodyHtml}</div>
            </div>
        </div>
    `);
    const last = messages.lastElementChild;
    if (last) {
        const body = last.querySelector('.wb-msg-body > .md-content');
        if (body) {
            if (shouldType) {
                enqueueTypingText(body, text || '', {
                    markdown: true,
                    onDone: target => {
                        highlightCodeBlocks(target);
                        attachCopyButtons(target);
                    }
                });
            } else {
                highlightCodeBlocks(body);
                attachCopyButtons(body);
                if (!isUser) {
                    parseAndRenderTodosFromText(text);
                }
            }
        }
    }
    messages.scrollTop = messages.scrollHeight;
}

function renderWorkbenchPlan() {
    const planEl = document.getElementById('workbenchPlan');
    const approveBtn = document.getElementById('workbenchApproveBtn');
    const badge = document.getElementById('workbenchGateBadge');
    if (!planEl || !approveBtn || !badge) return;
    const plan = workbenchSession?.plan;
    const approved = workbenchSession?.approved === true;
    const mutationCount = Number(workbenchSession?.mutationCount || 0);
    approveBtn.disabled = !plan || approved;
    approveBtn.classList.toggle('opacity-50', !plan || approved);
    badge.textContent = approved ? 'Approved' : (plan ? 'Plan pending' : 'All tools ready');
    badge.className = approved
        ? 'rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
        : 'rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300';
    if (!plan) {
        planEl.innerHTML = '<p class="text-center py-3 opacity-60">No plan submitted yet</p>';
        const gateDiv = planEl.closest('.gate-panel');
        if (gateDiv) gateDiv.classList.remove('is-approved');
        renderInlinePlanApprovalCard();
        return;
    }
    const gateDiv2 = planEl.closest('.gate-panel');
    if (gateDiv2) gateDiv2.classList.toggle('is-approved', approved);
    planEl.innerHTML = [
        plan.summary ? `<p class="mb-2">${renderMarkdown(plan.summary)}</p>` : '',
        Array.isArray(plan.steps) && plan.steps.length
            ? '<div class="text-[11px] font-bold uppercase tracking-wider opacity-60 mt-3 mb-1.5">Steps</div><ol class="list-decimal pl-4 space-y-1">' + plan.steps.map(s => `<li>${renderMarkdown(s)}</li>`).join('') + '</ol>'
            : '',
        Array.isArray(plan.files) && plan.files.length
            ? '<div class="text-[11px] font-bold uppercase tracking-wider opacity-60 mt-3 mb-1.5">Files</div><ul class="list-disc pl-4 space-y-0.5">' + plan.files.map(f => `<li><code>${escapeHtml(f)}</code></li>`).join('') + '</ul>'
            : '',
        Array.isArray(plan.risks) && plan.risks.length
            ? '<div class="text-[11px] font-bold uppercase tracking-wider opacity-60 mt-3 mb-1.5">Risks</div><ul class="list-disc pl-4 space-y-0.5">' + plan.risks.map(r => `<li>${escapeHtml(r)}</li>`).join('') + '</ul>'
            : '',
        Array.isArray(plan.verification) && plan.verification.length
            ? '<div class="text-[11px] font-bold uppercase tracking-wider opacity-60 mt-3 mb-1.5">Verification</div><ul class="list-disc pl-4 space-y-0.5">' + plan.verification.map(v => `<li>${escapeHtml(v)}</li>`).join('') + '</ul>'
            : '',
        `<div class="mt-3 pt-2 border-t border-dashed border-slate-300 dark:border-slate-700 text-[11px] ${approved ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'} font-semibold">${approved ? 'Approved - planned mutations unlocked' : 'All mutations are blocked until approval'}</div>`,
        mutationCount ? `<div class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Mutation audit: ${mutationCount} recorded action${mutationCount === 1 ? '' : 's'}</div>` : ''
    ].filter(Boolean).join('\n');

    renderInlinePlanApprovalCard();
}

function renderInlinePlanApprovalCard() {
    const messages = document.getElementById('workbenchMessages');
    if (!messages) return;

    const existing = document.getElementById('inlinePlanApprovalCard');
    if (existing) {
        existing.remove();
    }

    if (!workbenchSession?.plan) return;

    const plan = workbenchSession.plan;
    const approved = workbenchSession.approved === true;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const title = approved ? '✓ Proposed Plan Approved' : '⚠ Proposed Plan Pending Approval';
    const borderLeftColor = approved ? '#10b981' : '#f59e0b';
    const titleClass = approved ? 'text-emerald-600 dark:text-emerald-400 font-bold' : 'text-amber-600 dark:text-amber-400 font-bold';

    let actionsHtml = '';
    if (!approved) {
        actionsHtml = `
            <div class="flex gap-2 mt-3">
                <button onclick="approvePlanFromChat(this)" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-semibold cursor-pointer transition-colors border-0">
                    Approve Plan
                </button>
            </div>
        `;
    } else {
        actionsHtml = `
            <div class="text-xs text-emerald-600 dark:text-emerald-400 font-semibold mt-2">
                Plan approved. Planned mutations are unlocked.
            </div>
        `;
    }

    messages.insertAdjacentHTML('beforeend', `
        <div id="inlinePlanApprovalCard" class="wb-msg is-assistant" style="border-left: 2px solid ${borderLeftColor}; padding-left: 12px; margin-bottom: 14px;">
            <div class="wb-msg-header flex justify-between items-center mb-1">
                <span class="wb-msg-role ${titleClass}">${title}</span>
                <span class="wb-msg-time text-xs opacity-50">${time}</span>
            </div>
            <div class="wb-msg-body">
                <div class="md-content">
                    <p class="font-semibold mb-1 text-xs">${escapeHtml(plan.summary || 'A plan has been submitted for approval.')}</p>
                    ${Array.isArray(plan.steps) && plan.steps.length ? `<ol class="list-decimal pl-4 mb-2 text-xs opacity-80">${plan.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
                    ${actionsHtml}
                </div>
            </div>
        </div>
    `);
    messages.scrollTop = messages.scrollHeight;
}

async function approvePlanFromChat(btn) {
    btn.disabled = true;
    btn.textContent = 'Approving...';
    try {
        await approveWorkbenchPlanUI();
    } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Approve Plan';
        showStatus(e.message, 'bg-red-600 text-white');
    }
}

function renderWorkbenchGoal(data) {
    const goal = data?.goal !== undefined ? data.goal : workbenchSession?.goal;
    const lastGoal = data?.lastGoal !== undefined ? data.lastGoal : workbenchSession?.lastGoal;
    const badge = document.getElementById('workbenchGoalBadge');
    const drawer = document.getElementById('workbenchGoalPanel');
    if (badge) {
        if (goal) {
            badge.classList.remove('hidden');
            badge.innerHTML = `<span class="wb-header-dot"></span>Goal: active`;
            badge.title = goal.condition || 'Active goal';
        } else if (lastGoal?.status === 'achieved') {
            badge.classList.remove('hidden');
            badge.innerHTML = `<span class="wb-header-dot"></span>Goal: done`;
            badge.title = lastGoal.condition || 'Last goal achieved';
        } else {
            badge.classList.add('hidden');
            badge.title = '';
        }
    }
    if (drawer) {
        if (goal) {
            drawer.innerHTML = `
                <div class="wb-goal-state is-active">
                    <div class="wb-goal-title">Active goal</div>
                    <div class="wb-goal-condition">${escapeHtml(goal.condition || '')}</div>
                    <div class="wb-goal-meta">${Number(goal.turns || 0)} evaluation${Number(goal.turns || 0) === 1 ? '' : 's'} · ${escapeHtml(goal.lastReason || 'Running')}</div>
                    <button type="button" class="minimal-button rounded-xl px-3 py-2 text-xs font-semibold" onclick="clearWorkbenchGoalUI()">Clear goal</button>
                </div>
            `;
        } else {
            drawer.innerHTML = `
                <div class="wb-goal-state">
                    <div class="wb-goal-title">${lastGoal ? `Last goal: ${escapeHtml(lastGoal.status || 'done')}` : 'No active goal'}</div>
                    <div class="wb-goal-condition">${lastGoal ? escapeHtml(lastGoal.condition || '') : 'Use /goal to keep August working until a condition is met.'}</div>
                    ${lastGoal?.lastReason ? `<div class="wb-goal-meta">${escapeHtml(lastGoal.lastReason)}</div>` : ''}
                </div>
            `;
        }
    }
}

function renderWorkbenchTodos(data) {
    const session = data?.session || data || workbenchSession;
    const todos = session?.todos || [];
    const panel = document.getElementById('workbenchTodoPanel');
    const listEl = document.getElementById('workbenchTodoList');
    if (!panel || !listEl) return;

    if (!todos || todos.length === 0) {
        panel.classList.add('hidden');
        return;
    }

    panel.classList.remove('hidden');
    
    const isMin = panel.classList.contains('minimized');
    const total = todos.length;
    const completed = todos.filter(t => t.status === 'completed').length;
    const active = todos.filter(t => t.status === 'in_progress').length;
    
    if (isMin) {
        const minIcon = panel.querySelector('.wb-todo-min-icon');
        if (minIcon) {
            if (active > 0) {
                minIcon.innerHTML = `<span class="wb-spin-ring" style="display:inline-block; width:14px; height:14px; margin-top:2px;"></span>`;
            } else {
                minIcon.innerHTML = `📋 <span style="font-size:9px; font-weight:bold; position:absolute; bottom:2px; right:4px; background:#6366f1; color:white; border-radius:4px; padding:1px 3px; line-height:1;">${completed}/${total}</span>`;
            }
        }
    } else {
        const title = panel.querySelector('.wb-todo-title');
        if (title) {
            title.textContent = `Tasks (${completed}/${total})`;
        }
        
        listEl.innerHTML = todos.map(todo => {
            let iconHtml = '';
            let itemClass = '';
            if (todo.status === 'completed') {
                iconHtml = '<span class="wb-checkmark">✓</span>';
                itemClass = 'completed';
            } else if (todo.status === 'in_progress') {
                iconHtml = '<span class="wb-spin-ring"></span>';
                itemClass = 'in_progress';
            } else if (todo.status === 'cancelled') {
                iconHtml = '<span class="wb-cancelled-icon">✕</span>';
                itemClass = 'cancelled';
            } else {
                iconHtml = '<span class="wb-pending-dot"></span>';
                itemClass = 'pending';
            }
            return `
                <div class="wb-todo-item ${itemClass}">
                    <div class="wb-todo-item-icon">${iconHtml}</div>
                    <div class="wb-todo-item-text">${escapeHtml(todo.content || '')}</div>
                </div>
            `;
        }).join('');
    }
}

function toggleTodoPanelMinimize(event) {
    if (event) {
        event.stopPropagation();
    }
    const panel = document.getElementById('workbenchTodoPanel');
    if (!panel) return;
    panel.classList.toggle('minimized');
    renderWorkbenchTodos();
}

function toggleTodoPanelMinimizeFromHeader(event) {
    const panel = document.getElementById('workbenchTodoPanel');
    if (!panel) return;
    if (panel.classList.contains('minimized')) {
        panel.classList.remove('minimized');
        renderWorkbenchTodos();
    }
}

function renderWorkbenchAgentBadge(data) {
    const badge = document.getElementById('workbenchAgentBadge');
    if (!badge) return;
    const activeId = workbenchSession?.agentId || data?.activeAgentId || document.getElementById('workbenchAgent')?.value || 'build';
    const agent = (data?.agents || []).find(item => item.id === activeId);
    badge.innerHTML = `<span class="wb-header-dot"></span>Agent: ${escapeHtml(agent?.id || activeId)}`;
    badge.title = agent?.role || 'Active Workbench agent';
}

function formatAgentPermissions(permissions = {}) {
    return Object.entries(permissions)
        .map(([key, value]) => `<span class="wb-agent-perm is-${escapeHtml(value)}">${escapeHtml(key)}:${escapeHtml(value)}</span>`)
        .join('');
}

function populateWorkbenchAgentSelect(data) {
    const select = document.getElementById('workbenchAgent');
    if (!select || !Array.isArray(data?.agents)) return;
    const current = select.value || workbenchSession?.agentId || 'build';
    select.innerHTML = data.agents
        .filter(agent => agent.mode === 'primary')
        .map(agent => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.id)}</option>`)
        .join('');
    select.value = data.agents.some(agent => agent.id === current && agent.mode === 'primary') ? current : 'build';
}

function renderWorkbenchAgentsUI(data) {
    const el = document.getElementById('workbenchAgentRegistry');
    if (!el || !data) return;
    const activeId = workbenchSession?.agentId || data.activeAgentId || 'build';
    const agents = Array.isArray(data.agents) ? data.agents : [];
    el.innerHTML = agents.map(agent => `
        <div class="wb-agent-card ${agent.id === activeId ? 'is-active' : ''}">
            <div class="wb-agent-row">
                <span class="wb-agent-name">${escapeHtml(agent.id)}</span>
                <span class="wb-agent-mode">${escapeHtml(agent.mode || 'agent')}</span>
            </div>
            <div class="wb-agent-role">${escapeHtml(agent.role || '')}</div>
            <div class="wb-agent-goal">${escapeHtml(agent.goal || '')}</div>
            <div class="wb-agent-perms">${formatAgentPermissions(agent.effectivePermissions || agent.permissions || {})}</div>
        </div>
    `).join('') || '<div class="text-xs text-slate-500">No agents registered.</div>';
}

async function loadWorkbenchAgentsUI(force = false) {
    if (workbenchAgentsCache && !force) {
        populateWorkbenchAgentSelect(workbenchAgentsCache);
        renderWorkbenchAgentBadge(workbenchAgentsCache);
        renderWorkbenchAgentsUI(workbenchAgentsCache);
        return workbenchAgentsCache;
    }
    const active = workbenchSession?.agentId || document.getElementById('workbenchAgent')?.value || 'build';
    const data = await fetchJsonOrNull(`/ui/workbench/agents?active=${encodeURIComponent(active)}`);
    if (!data) return null;
    workbenchAgentsCache = data;
    populateWorkbenchAgentSelect(data);
    renderWorkbenchAgentBadge(data);
    renderWorkbenchAgentsUI(data);
    return data;
}

async function ensureWorkbenchSession() {
    if (workbenchSession) {
        renderWorkbenchPlan();
        renderWorkbenchGoal();
        loadWorkbenchAgentsUI().catch(() => {});
        renderWorkbenchTodos();
        return workbenchSession;
    }
    
    // Try to load the most recent session from history
    try {
        const sessionsRes = await fetch('/ui/workbench/sessions');
        if (sessionsRes.ok) {
            const sessions = await sessionsRes.json();
            if (Array.isArray(sessions) && sessions.length > 0) {
                await loadWorkbenchSessionUI(sessions[0].id);
                return workbenchSession;
            }
        }
    } catch (e) {
        console.warn('Failed to load recent session, creating new one:', e);
    }
    
    const provider = document.getElementById('workbenchProvider')?.value || 'claude';
    const agentId = document.getElementById('workbenchAgent')?.value || 'build';
    const res = await fetch('/ui/workbench/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, agentId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create Workbench session');
    workbenchSession = data;
    renderWorkbenchPlan();
    renderWorkbenchGoal();
    loadWorkbenchAgentsUI(true).catch(() => {});
    renderWorkbenchTodos();
    setWorkbenchStatus('Ready', 'bg-emerald-400');
    return workbenchSession;
}

function setWorkbenchStatus(html, dotColor) {
    const inner = document.getElementById('workbenchStatusInner');
    if (!inner) return;
    inner.innerHTML = dotColor ? `<span class="w-1.5 h-1.5 rounded-full ${dotColor}"></span>${html}` : html;
}

function renderWorkbenchDiagnostics(data) {
    const el = document.getElementById('workbenchDiagnostics');
    if (!el) return;
    const checks = (data.checks || []).slice(0, 6);
    const counts = data.counts || {};
    const statusClass = data.summary?.overall === 'error'
        ? 'text-red-600 dark:text-red-300'
        : data.summary?.overall === 'warn'
            ? 'text-amber-600 dark:text-amber-300'
            : 'text-emerald-600 dark:text-emerald-300';
    el.classList.remove('hidden');
    el.innerHTML = `
        <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
                <div class="text-[11px] font-bold uppercase tracking-wider ${statusClass}">Proxy diagnostics: ${escapeHtml(data.summary?.overall || 'unknown')}</div>
                <div class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    Vector ${counts.vectorEntries || 0} · Semantic ${counts.semanticFacts || 0} · Core checkpoints ${counts.coreCheckpoints || 0} · Supermemory ${data.supermemory?.configured ? 'configured' : 'not configured'}
                </div>
            </div>
            <button onclick="document.getElementById('workbenchDiagnostics')?.classList.add('hidden')" class="minimal-button rounded-xl px-3 py-1.5 text-[11px] font-semibold">Hide</button>
        </div>
        <div class="mt-3 grid gap-2 md:grid-cols-2">
            ${checks.map(check => `
                <div class="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                    <div class="flex items-center justify-between gap-2">
                        <span class="font-semibold">${escapeHtml(check.label)}</span>
                        <span class="rounded-full px-2 py-0.5 text-[10px] font-bold ${check.status === 'ok' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : check.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'}">${escapeHtml(check.status)}</span>
                    </div>
                    <div class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">${escapeHtml(check.detail || '')}</div>
                </div>
            `).join('')}
        </div>
    `;
}

async function loadWorkbenchDiagnosticsUI() {
    const el = document.getElementById('workbenchDiagnostics');
    if (el) {
        el.classList.remove('hidden');
        el.textContent = 'Checking proxy diagnostics...';
    }
    try {
        const res = await fetch('/ui/brain/diagnostics', { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Diagnostics failed');
        renderWorkbenchDiagnostics(data);
    } catch (e) {
        if (el) {
            el.classList.remove('hidden');
            el.textContent = e.message;
        }
    }
}

function toggleWorkbenchDrawer() {
    const overlay = document.getElementById('wbDrawerOverlay');
    const drawer = document.getElementById('wbDrawer');
    if (!overlay || !drawer) return;
    const opening = !drawer.classList.contains('open');
    overlay.classList.toggle('open', opening);
    drawer.classList.toggle('open', opening);
}

function autoResizeTextarea(el) {
    const sendBtn = document.getElementById('workbenchSendBtn');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
    if (sendBtn) {
        const value = el.value.trim();
        sendBtn.disabled = !value || (workbenchMainBusy && !isBtwCommandText(value) && !/^\/goal\s+(clear|stop|off|reset|none|cancel)$/i.test(value));
    }
    syncSlashPalette(el);
}

function handleWorkbenchInputInput(el) {
    autoResizeTextarea(el);
}

function handleWorkbenchInputKeydown(event) {
    const input = event.currentTarget || event.target;
    if (isSlashPaletteOpen()) {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveSlashSelection(1);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveSlashSelection(-1);
            return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            commitSlashSelection(input);
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            closeSlashPalette();
            return;
        }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        closeSlashPalette();
        sendWorkbenchMessageUI();
    }
}

function getSlashPalette() {
    return document.getElementById('workbenchSlashPalette');
}

function isSlashPaletteOpen() {
    const palette = getSlashPalette();
    return !!palette && !palette.classList.contains('hidden');
}

function closeSlashPalette() {
    const palette = getSlashPalette();
    slashQueryState = null;
    slashVisibleCommands = [];
    slashActiveIndex = 0;
    if (!palette) return;
    palette.classList.add('hidden');
    palette.innerHTML = '';
}

function getSlashQueryState(input) {
    if (!input) return null;
    const cursor = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
    const beforeCursor = input.value.slice(0, cursor);
    const match = beforeCursor.match(/(?:^|\s)\/([^\s/]*)$/);
    if (!match) return null;
    const token = '/' + match[1];
    return {
        query: match[1].toLowerCase(),
        start: beforeCursor.length - token.length,
        end: cursor
    };
}

function syncSlashPalette(input) {
    const state = getSlashQueryState(input);
    if (!state) {
        closeSlashPalette();
        return;
    }
    const seq = ++slashRenderSeq;
    loadSlashCommands()
        .then(commands => {
            if (seq !== slashRenderSeq) return;
            renderSlashPalette(state, commands);
        })
        .catch(() => {
            if (seq !== slashRenderSeq) return;
            renderSlashPalette(state, WORKBENCH_BASE_SLASH_COMMANDS);
        });
}

async function loadSlashCommands() {
    if (slashCommandsCache) return slashCommandsCache;
    const [skillsData, capabilitiesData, agentsData] = await Promise.all([
        fetchJsonOrNull('/ui/skills'),
        fetchJsonOrNull('/ui/workbench/capabilities'),
        fetchJsonOrNull('/ui/workbench/agents')
    ]);
    const commands = [...WORKBENCH_BASE_SLASH_COMMANDS];

    const skills = Array.isArray(skillsData?.skills) ? skillsData.skills : [];
    skills
        .filter(skill => skill && skill.enabled !== false && skill.name)
        .forEach(skill => commands.push({
            id: `skill-${skill.name}`,
            label: `/${skill.name}`,
            title: skill.name,
            kind: 'skill',
            description: skill.description || skill.trigger || 'Available skill',
            insert: `Use the "${skill.name}" skill for: `
        }));

    const groups = capabilitiesData?.groups && typeof capabilitiesData.groups === 'object'
        ? capabilitiesData.groups
        : {};
    Object.entries(groups).forEach(([group, tools]) => {
        (Array.isArray(tools) ? tools : []).forEach(tool => {
            if (!tool?.name) return;
            commands.push({
                id: `tool-${tool.name}`,
                label: `/${tool.name}`,
                title: tool.name,
                kind: tool.mutating ? 'tool + approval' : 'tool',
                group,
                description: trimSlashDescription(tool.description || group || 'Workbench tool', tool.mutating),
                insert: `Use the ${tool.name} tool${tool.mutating ? ' after an approved plan' : ''} with: `
            });
        });
    });

    const agents = Array.isArray(agentsData?.agents) ? agentsData.agents : [];
    agents.forEach(agent => commands.push({
        id: `agent-${agent.id}`,
        label: `/agent:${agent.id}`,
        title: `${agent.id} agent`,
        kind: agent.mode || 'agent',
        description: agent.role || agent.goal || 'Workbench agent',
        insert: `Use the "${agent.id}" Workbench agent role for this request: `
    }));

    const deduped = [];
    const seen = new Set();
    commands.forEach(command => {
        const key = command.id || `${command.kind}:${command.label}`;
        if (seen.has(key)) return;
        seen.add(key);
        deduped.push(command);
    });
    slashCommandsCache = deduped;
    return slashCommandsCache;
}

async function fetchJsonOrNull(url) {
    try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
}

function trimSlashDescription(text, mutating) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    const prefix = mutating ? 'Requires approved plan. ' : '';
    return prefix + (clean.length > 120 ? clean.slice(0, 117) + '...' : clean);
}

function renderSlashPalette(state, commands) {
    const palette = getSlashPalette();
    if (!palette) return;
    slashQueryState = state;
    const query = state.query || '';
    const filtered = filterSlashCommands(commands, query).slice(0, 80);
    slashVisibleCommands = filtered;
    slashActiveIndex = Math.min(slashActiveIndex, Math.max(filtered.length - 1, 0));

    if (!filtered.length) {
        palette.innerHTML = '<div class="wb-slash-empty">No matching commands</div>';
        palette.classList.remove('hidden');
        return;
    }

    palette.innerHTML = filtered.map((command, index) => `
        <button type="button" class="wb-slash-item ${index === slashActiveIndex ? 'is-active' : ''}" role="option" aria-selected="${index === slashActiveIndex ? 'true' : 'false'}" onmousedown="event.preventDefault()" onclick="selectSlashCommand(${index})">
            <span class="wb-slash-main">
                <span class="wb-slash-label">${escapeHtml(command.label)}</span>
                <span class="wb-slash-title">${escapeHtml(command.title || command.label)}</span>
            </span>
            <span class="wb-slash-meta">${escapeHtml(command.kind || 'command')}</span>
            <span class="wb-slash-desc">${escapeHtml(command.description || '')}</span>
        </button>
    `).join('');
    palette.classList.remove('hidden');
}

function filterSlashCommands(commands, query) {
    if (!query) return commands;
    return commands.filter(command => {
        const haystack = [
            command.label,
            command.title,
            command.kind,
            command.group,
            command.description
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(query);
    });
}

function moveSlashSelection(delta) {
    if (!slashVisibleCommands.length) return;
    slashActiveIndex = (slashActiveIndex + delta + slashVisibleCommands.length) % slashVisibleCommands.length;
    paintSlashSelection();
}

function paintSlashSelection() {
    const palette = getSlashPalette();
    if (!palette) return;
    Array.from(palette.querySelectorAll('.wb-slash-item')).forEach((item, index) => {
        const active = index === slashActiveIndex;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
        if (active) item.scrollIntoView({ block: 'nearest' });
    });
}

function selectSlashCommand(index) {
    slashActiveIndex = index;
    commitSlashSelection(document.getElementById('workbenchInput'));
}

function commitSlashSelection(input) {
    const command = slashVisibleCommands[slashActiveIndex];
    if (!command || !input) return false;
    const state = slashQueryState || getSlashQueryState(input);
    if (!state) return false;
    const insert = command.insert || command.title || command.label;
    const before = input.value.slice(0, state.start);
    const after = input.value.slice(state.end).replace(/^\s+/, '');
    const spacerBefore = before && !/\s$/.test(before) ? ' ' : '';
    const spacerAfter = after && !insert.endsWith(' ') ? ' ' : '';
    input.value = before + spacerBefore + insert + spacerAfter + after;
    const cursor = (before + spacerBefore + insert).length;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    closeSlashPalette();
    autoResizeTextarea(input);
    return true;
}

function copyMessage(btn) {
    const msg = btn.closest('.wb-msg');
    if (!msg) return;
    const body = msg.querySelector('.wb-msg-body > div');
    const text = body ? body.textContent : '';
    navigator.clipboard.writeText(text).then(() => {
        const orig = btn.innerHTML;
        btn.innerHTML = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>';
        setTimeout(() => btn.innerHTML = orig, 1500);
    });
}

function regenerateMessage(btn) {
    const msg = btn.closest('.wb-msg');
    if (!msg) return;
    sendWorkbenchMessageUI();
}

function showTypingIndicator() {
    const inner = document.getElementById('workbenchStatusInner');
    if (!inner) return;
    inner.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
}

/* ── Inline Thinking + Tool Activity ── */
let thinkContainer = null;
let thinkStartTime = null;
let thinkTimerInterval = null;

function ensureThinkContainer() {
    if (thinkContainer && thinkContainer.isConnected) return true;
    const messages = document.getElementById('workbenchMessages');
    if (!messages) return false;
    removeWelcome();
    thinkStartTime = Date.now();
    const div = document.createElement('div');
    div.className = 'think-container is-running';
    div.innerHTML = '<button type="button" class="think-toggle" aria-expanded="false" onclick="toggleInlineDisclosure(this)"><span class="inline-caret">›</span><span class="think-label">Thinking <span class="think-timer">0.0s</span></span></button><div class="think-body"></div>';
    messages.appendChild(div);
    thinkContainer = div;
    const timerEl = div.querySelector('.think-timer');
    thinkTimerInterval = setInterval(() => {
        if (timerEl && thinkStartTime) {
            timerEl.textContent = ((Date.now() - thinkStartTime) / 1000).toFixed(1) + 's';
        }
    }, 100);
    messages.scrollTop = messages.scrollHeight;
    return true;
}

function renderThinkingDelta(text) {
    if (!ensureThinkContainer()) return;
    const body = thinkContainer.querySelector('.think-body');
    enqueueTypingText(body, text || '', { markdown: false });
}

function resetThinkLine() {
    if (thinkTimerInterval) { clearInterval(thinkTimerInterval); thinkTimerInterval = null; }
    if (thinkContainer && thinkContainer.isConnected) {
        thinkContainer.classList.remove('is-running');
        const label = thinkContainer.querySelector('.think-label');
        if (label && thinkStartTime) {
            const elapsed = ((Date.now() - thinkStartTime) / 1000).toFixed(1);
            label.textContent = `Thought for ${elapsed}s`;
        }
    }
    thinkContainer = null;
    thinkStartTime = null;
}

function toggleInlineDisclosure(btn) {
    const host = btn?.closest?.('.think-container, .tool-line');
    if (!host) return;
    const isOpen = !host.classList.contains('is-open');
    host.classList.toggle('is-open', isOpen);
    host.classList.toggle('think-open', isOpen);
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function renderToolLine(id, name, input) {
    resetThinkLine();
    const messages = document.getElementById('workbenchMessages');
    if (!messages) return;
    removeWelcome();
    const presentation = getToolPresentation(name);
    const inputSummary = summarizeToolInput(input);
    const div = document.createElement('div');
    div.className = `tool-line tool-line-${presentation.kind}`;
    div.dataset.tid = id;
    div.dataset.toolName = name;
    div.innerHTML = `
        <button type="button" class="tool-line-toggle" aria-expanded="false" onclick="toggleInlineDisclosure(this)">
            <span class="inline-caret">›</span>
            <span class="tool-action">${escapeHtml(presentation.action)}</span>
            <span class="tool-name">${escapeHtml(name)}</span>
            <span class="tool-input-summary">${inputSummary ? escapeHtml(inputSummary) : ''}</span>
            <span class="tool-status running"><span class="tool-status-dot running"></span>running</span>
        </button>
        <div class="tool-line-detail">
            ${inputSummary ? `<div class="tool-line-input">Input: ${escapeHtml(inputSummary)}</div>` : ''}
            <div class="tool-result-preview hidden"></div>
        </div>
    `;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
}

function updateToolLine(id, content, isError) {
    const el = document.querySelector('.tool-line[data-tid="' + id.replace(/"/g, '\\"') + '"]');
    if (!el) return;
    const status = el.querySelector('.tool-status');
    const dot = el.querySelector('.tool-status-dot');
    if (isError) {
        el.classList.add('is-error');
        if (status) { status.className = 'tool-status error'; status.innerHTML = '<span class="tool-status-dot"></span>error'; }
    } else {
        el.classList.add('is-done');
        if (status) { status.className = 'tool-status done'; status.innerHTML = '<span class="tool-status-dot"></span>done'; }
    }
    if (dot) dot.classList.remove('running');
    const preview = el.querySelector('.tool-result-preview');
    if (preview) {
        const summary = summarizeToolResult(el.querySelector('.tool-name')?.textContent || '', content, isError);
        if (summary) {
            preview.classList.remove('hidden');
            preview.innerHTML = summary;
        }
    }
}

function getToolPresentation(name) {
    const lower = String(name || '').toLowerCase();
    if (lower.includes('skill') || lower.includes('capability') || lower.includes('import')) {
        return {
            kind: 'skill',
            action: lower.includes('preview') || lower.includes('find') ? 'Inspecting skill' : 'Using skill'
        };
    }
    if (lower.includes('run_command') || lower.includes('bash') || lower.includes('write_file') || lower.includes('replace_text')) {
        return {
            kind: 'code',
            action: lower.includes('run') || lower.includes('bash') ? 'Running code' : 'Changing files'
        };
    }
    if (lower.includes('web') || lower.includes('fetch') || lower.includes('search')) {
        return {
            kind: 'web',
            action: 'Searching'
        };
    }
    if (lower.includes('read') || lower.includes('list') || lower.includes('diagnose') || lower.includes('activity')) {
        return {
            kind: 'inspect',
            action: 'Inspecting'
        };
    }
    if (lower.startsWith('computer_')) {
        return {
            kind: 'computer',
            action: 'Using computer'
        };
    }
    return {
        kind: 'generic',
        action: 'Using tool'
    };
}

function summarizeToolInput(input) {
    if (typeof input === 'string') return input.slice(0, 160);
    if (!input || typeof input !== 'object') return '';
    return input.url || input.path || input.command || input.query || input.name || JSON.stringify(input).slice(0, 160);
}

function summarizeToolResult(toolName, content, isError) {
    const text = typeof content === 'string' ? content : JSON.stringify(content || '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) {}
    if (isError) return `<div class="tool-result-title">Needs attention</div><pre>${escapeHtml(text.slice(0, 600))}</pre>`;
    if (parsed && typeof parsed === 'object') {
        const skills = parsed.skills || parsed.preview?.skills || parsed.candidates?.flatMap(item => item.preview?.skills || []) || [];
        const mcpServers = parsed.mcpServers || parsed.preview?.mcpServers || [];
        const candidates = parsed.candidates || [];
        if (skills.length || mcpServers.length || candidates.length) {
            const lines = [];
            if (candidates.length) lines.push(`${candidates.length} candidate${candidates.length === 1 ? '' : 's'} found`);
            if (skills.length) lines.push(`Skills: ${skills.map(item => item.name).filter(Boolean).join(', ')}`);
            if (mcpServers.length) lines.push(`MCP: ${mcpServers.map(item => item.name).filter(Boolean).join(', ')}`);
            if (parsed.availability?.clients) lines.push(parsed.availability.clients);
            return `<div class="tool-result-title">Skill result</div><p>${escapeHtml(lines.filter(Boolean).join(' | '))}</p>`;
        }
        if (parsed.stdout || parsed.stderr || parsed.exitCode !== undefined) {
            const output = [parsed.stdout, parsed.stderr].filter(Boolean).join('\n').trim();
            return `<div class="tool-result-title">Command output</div><pre>${escapeHtml((output || `Exit code ${parsed.exitCode}`).slice(0, 800))}</pre>`;
        }
    }
    if (!text.trim()) return '';
    const label = String(toolName || '').toLowerCase().includes('load_skill') ? 'Skill loaded' : 'Result';
    return `<div class="tool-result-title">${escapeHtml(label)}</div><pre>${escapeHtml(text.slice(0, 800))}</pre>`;
}

/* ── SSE Event Handler ── */
function handleSSEEvent(event, data) {
    switch (event) {
        case 'thinking': renderThinkingDelta(data.content); break;
        case 'tool_use': renderToolLine(data.id, data.name, data.input); break;
        case 'tool_result': updateToolLine(data.id, data.content, data.is_error); break;
        case 'text':
            resetThinkLine();
            renderWorkbenchMessage('assistant', data.content);
            break;
        case 'session':
            workbenchSession = data;
            renderWorkbenchPlan();
            renderWorkbenchGoal();
            loadWorkbenchAgentsUI(true).catch(() => {});
            renderWorkbenchTodos(data);
            if (workbenchSession.approved) setWorkbenchStatus('Plan approved', 'bg-emerald-400');
            else if (workbenchSession.plan) setWorkbenchStatus('Plan pending', 'bg-amber-400');
            else setWorkbenchStatus('Ready', 'bg-emerald-400');
            break;
        case 'goal':
            renderWorkbenchGoal(data);
            if (data?.event === 'started') setWorkbenchStatus('Goal running', 'bg-violet-400');
            else if (data?.event === 'achieved') setWorkbenchStatus('Goal reached', 'bg-emerald-400');
            else if (data?.event === 'cleared') setWorkbenchStatus('Goal cleared', 'bg-slate-400');
            break;
        case 'btw':
            appendBtwMessage('assistant', data.answer || '');
            break;
        case 'error':
            resetThinkLine();
            renderWorkbenchMessage('assistant', 'Error: ' + data.message);
            setWorkbenchStatus('Error.', 'bg-red-400');
            break;
        case 'done': break;
    }
}

async function readSSEStream(reader) {
    const dec = new TextDecoder();
    let buf = '', evt = '', dat = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop() || '';
        for (const line of parts) {
            if (line.startsWith('event: ')) evt = line.slice(7).trim();
            else if (line.startsWith('data: ')) dat = line.slice(6).trim();
            else if (line === '' && evt && dat) {
                try { handleSSEEvent(evt, JSON.parse(dat)); } catch (e) {}
                evt = ''; dat = '';
            }
        }
    }
    if (evt && dat) { try { handleSSEEvent(evt, JSON.parse(dat)); } catch (e) {} }
}

function openBtwPanel() {
    const panel = document.getElementById('workbenchBtwPanel');
    if (panel) panel.classList.remove('hidden');
    const input = document.getElementById('workbenchBtwInput');
    if (input) input.focus();
}

function closeBtwPanel() {
    const panel = document.getElementById('workbenchBtwPanel');
    if (panel) panel.classList.add('hidden');
}

function appendBtwMessage(role, text) {
    const log = document.getElementById('workbenchBtwMessages');
    if (!log) return;
    log.querySelector('.wb-btw-empty')?.remove();
    const isUser = role === 'user';
    const div = document.createElement('div');
    div.className = `wb-btw-message ${isUser ? 'is-user' : 'is-assistant'}`;
    div.innerHTML = `
        <div class="wb-btw-role">${isUser ? 'You' : 'August'}</div>
        <div class="wb-btw-body ${isUser ? '' : 'md-content wb-typing-output'}"></div>
    `;
    log.appendChild(div);
    const body = div.querySelector('.wb-btw-body');
    if (isUser) {
        body.textContent = text || '';
    } else {
        enqueueTypingText(body, text || '', {
            markdown: true,
            onDone: target => {
                highlightCodeBlocks(target);
                attachCopyButtons(target);
            }
        });
    }
    log.scrollTop = log.scrollHeight;
}

async function sendWorkbenchBtwQuestion(question) {
    const input = document.getElementById('workbenchBtwInput');
    const sendBtn = document.getElementById('workbenchBtwSendBtn');
    const clean = String(question || input?.value || '').trim();
    if (!clean || workbenchBtwBusy) return;
    await ensureWorkbenchSession();
    openBtwPanel();
    if (input) input.value = '';
    appendBtwMessage('user', clean);
    workbenchBtwBusy = true;
    if (sendBtn) sendBtn.disabled = true;
    try {
        const res = await fetch('/ui/workbench/btw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: workbenchSession.id,
                provider: document.getElementById('workbenchProvider')?.value || 'claude',
                agentId: document.getElementById('workbenchAgent')?.value || workbenchSession.agentId || 'build',
                question: clean
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'BTW failed');
        appendBtwMessage('assistant', data.answer || '(no response)');
    } catch (e) {
        appendBtwMessage('assistant', 'Error: ' + e.message);
    } finally {
        workbenchBtwBusy = false;
        if (sendBtn) sendBtn.disabled = false;
    }
}

function handleBtwInputKeydown(event) {
    if (event.key === 'Escape') {
        closeBtwPanel();
        return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendWorkbenchBtwQuestion();
    }
}

async function handleGoalSideCommand(message) {
    const parsed = parseWorkbenchInputCommand(message);
    if (parsed?.command !== 'goal') return false;
    const lower = parsed.arg.toLowerCase();
    if (!/^(clear|stop|off|reset|none|cancel)$/.test(lower)) return false;
    await ensureWorkbenchSession();
    const res = await fetch('/ui/workbench/goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: workbenchSession.id, action: 'clear' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not clear goal');
    workbenchSession = data.session || workbenchSession;
    renderWorkbenchGoal(data);
    setWorkbenchStatus('Goal cleared', 'bg-slate-400');
    renderWorkbenchMessage('assistant', 'Goal cleared.');
    return true;
}

async function clearWorkbenchGoalUI() {
    await handleGoalSideCommand('/goal clear');
}

async function sendWorkbenchMessageUI() {
    const input = document.getElementById('workbenchInput');
    const sendBtn = document.getElementById('workbenchSendBtn');
    const message = input?.value.trim();
    if (!message) return;
    await ensureWorkbenchSession();
    const parsed = parseWorkbenchInputCommand(message);
    if (parsed?.command === 'btw') {
        input.value = '';
        input.style.height = 'auto';
        openBtwPanel();
        await sendWorkbenchBtwQuestion(parsed.arg);
        if (sendBtn) sendBtn.disabled = true;
        return;
    }
    if (parsed?.command === 'goal' && workbenchMainBusy) {
        try {
            const handled = await handleGoalSideCommand(message);
            if (handled) {
                input.value = '';
                input.style.height = 'auto';
                if (sendBtn) sendBtn.disabled = true;
                return;
            }
        } catch (e) {
            renderWorkbenchMessage('assistant', e.message);
            return;
        }
    }
    if (workbenchMainBusy) {
        showStatus('Workbench is still running. Use /btw for an aside or /goal clear to stop the active goal.', 'bg-amber-600 text-white');
        return;
    }
    input.value = '';
    input.style.height = 'auto';
    workbenchMainBusy = true;
    if (sendBtn) sendBtn.disabled = true;
    renderWorkbenchMessage('user', message);
    setWorkbenchStatus('Working\u2026', 'bg-amber-400');
    lastThinkLine = null;
    try {
        const res = await fetch('/ui/workbench/chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                sessionId: workbenchSession.id,
                provider: document.getElementById('workbenchProvider')?.value || 'claude',
                agentId: document.getElementById('workbenchAgent')?.value || workbenchSession.agentId || 'build',
                message
            })
        });
        if (!res.ok) {
            const errText = await res.text();
            let errMsg = 'Workbench request failed';
            try { errMsg = JSON.parse(errText).error || errMsg; } catch (e) { errMsg = errText || errMsg; }
            throw new Error(errMsg);
        }
        await readSSEStream(res.body.getReader());
        renderWorkbenchPlan();
    } catch (e) {
        resetThinkLine();
        renderWorkbenchMessage('assistant', e.message);
        setWorkbenchStatus('Error.', 'bg-red-400');
    } finally {
        workbenchMainBusy = false;
        if (input) autoResizeTextarea(input);
    }
}

async function approveWorkbenchPlanUI() {
    await ensureWorkbenchSession();
    try {
        const res = await fetch('/ui/workbench/approve', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: workbenchSession.id })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not approve plan');
        workbenchSession = data;
        renderWorkbenchPlan();
        renderWorkbenchGoal();
        loadWorkbenchAgentsUI(true).catch(() => {});
        renderWorkbenchTodos();
        renderWorkbenchMessage('assistant', 'Plan approved. Planned mutations are now unlocked. Send a follow-up message such as "implement the approved plan" to let the agent proceed.');
        showStatus('Workbench plan approved', 'bg-emerald-600 text-white');
    } catch (e) { showStatus(e.message, 'bg-red-600 text-white'); }
}

async function resetWorkbenchUI() {
    const previousId = workbenchSession?.id;
    const provider = document.getElementById('workbenchProvider')?.value || 'claude';
    const agentId = document.getElementById('workbenchAgent')?.value || 'build';
    const res = await fetch('/ui/workbench/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: previousId, provider, agentId })
    });
    const data = await res.json();
    if (!res.ok) { showStatus(data.error || 'Could not reset Workbench', 'bg-red-600 text-white'); return; }
    workbenchSession = data;
    const messages = document.getElementById('workbenchMessages');
    if (messages) {
        messages.innerHTML = `<div class="wb-welcome" id="wbWelcome">
            <div class="wb-welcome-icon">&#10022;</div>
            <div class="wb-welcome-title">August AI</div>
            <div class="wb-welcome-desc">New session started. Read, search, inspect, and preview skill sources freely. Imports and updates require an approved plan.</div>
            <div class="wb-welcome-chips">
                <button class="wb-welcome-chip" onclick="fillWorkbenchPrompt('Refactor the auth module')">Refactor code</button>
                <button class="wb-welcome-chip" onclick="fillWorkbenchPrompt('Debug why tests are failing')">Debug tests</button>
                <button class="wb-welcome-chip" onclick="fillWorkbenchPrompt('Find a GitHub skill for Playwright browser testing, preview it, and wait for my approval before importing')">Fetch skill</button>
                <button class="wb-welcome-chip" onclick="fillWorkbenchPrompt('Diagnose the proxy health, August Brain, vector DB, Supermemory, and recent errors')">Diagnose proxy</button>
            </div>
        </div>`;
    }
    renderWorkbenchPlan();
    renderWorkbenchGoal();
    loadWorkbenchAgentsUI(true).catch(() => {});
    renderWorkbenchTodos();
    setWorkbenchStatus('Ready', 'bg-emerald-400');
    showStatus('Workbench session reset', 'bg-slate-700 text-white');
}

async function loadComputerUseStatus() {
    const badge = document.getElementById('computerUseStatus');
    if (!badge) return;
    try {
        const res = await fetch('/ui/host-agent/status', { cache: 'no-store' });
        const data = await res.json();
        if (data.status === 'connected') {
            badge.textContent = 'connected';
            badge.className = 'ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300';
        } else {
            badge.textContent = 'offline';
            badge.className = 'ml-auto rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-700 dark:text-slate-300';
        }
    } catch (e) {
        badge.textContent = 'offline';
        badge.className = 'ml-auto rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-700 dark:text-slate-300';
    }
}

async function importCapabilityLinkUI() {
    const url = document.getElementById('importCapabilityUrl').value.trim();
    const enableMcp = document.getElementById('importEnableMcp').checked;
    const resultEl = document.getElementById('importCapabilityResult');
    if (!url) { showStatus('Paste a capability link first', 'bg-red-600 text-white'); return; }
    resultEl.classList.remove('hidden');
    resultEl.textContent = 'Importing...';
    try {
        const res = await fetch('/ui/import-link', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, enableMcp })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Import failed');
        const imported = data.imported || {};
        resultEl.textContent = [
            `Resolved: ${imported.resolvedUrl || url}`,
            `Plugins: ${(imported.plugins || []).map(item => item.name).join(', ') || 'none'}`,
            `Skills: ${(imported.skills || []).map(item => item.name).join(', ') || 'none'}`,
            `MCP servers: ${(imported.mcpServers || []).map(item => `${item.name}${item.enabled === false ? ' (disabled)' : ''}`).join(', ') || 'none'}`
        ].join('\n');
        showStatus('Capability link imported', 'bg-emerald-600 text-white');
        invalidateWorkbenchSlashCommands();
        await Promise.all([loadMcpUI(), loadSkillsUI(), loadPluginsUI(), loadCompatibilityUI(), loadMemoryPreview(), loadHealthUI()]);
    } catch (e) { resultEl.textContent = e.message; showStatus(e.message, 'bg-red-600 text-white'); }
}

/* ── Session History Actions ── */

async function toggleWorkbenchHistoryDropdown(event) {
    if (event) event.stopPropagation();
    const dropdown = document.getElementById('wbHistoryDropdown');
    if (!dropdown) return;
    const isHidden = dropdown.classList.contains('hidden');
    
    // Close other dropdowns if any
    closeAllWorkbenchDropdowns();
    
    if (isHidden) {
        dropdown.classList.remove('hidden');
        await loadWorkbenchHistoryList();
    } else {
        dropdown.classList.add('hidden');
    }
}

function closeAllWorkbenchDropdowns() {
    const dropdown = document.getElementById('wbHistoryDropdown');
    if (dropdown) dropdown.classList.add('hidden');
}

// Add global document click listener to close the dropdown when clicking outside
document.addEventListener('click', () => {
    closeAllWorkbenchDropdowns();
});

async function loadWorkbenchHistoryList() {
    const listEl = document.getElementById('wbHistoryList');
    if (!listEl) return;
    listEl.innerHTML = '<div class="wb-history-empty">Loading history...</div>';
    
    try {
        const res = await fetch('/ui/workbench/sessions');
        if (!res.ok) throw new Error('Failed to load history');
        const sessions = await res.json();
        
        if (!Array.isArray(sessions) || sessions.length === 0) {
            listEl.innerHTML = '<div class="wb-history-empty">No sessions found</div>';
            return;
        }
        
        listEl.innerHTML = sessions.map(session => {
            const isActive = workbenchSession && workbenchSession.id === session.id;
            const activeClass = isActive ? 'is-active' : '';
            const title = session.title || session.id;
            const dateStr = new Date(session.updatedAt).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
            const providerText = session.provider === 'codex' ? 'Codex' : 'Claude';
            const agentIdText = session.agentId || 'build';
            const msgCountText = `${session.messageCount || 0} msg`;
            
            return `
                <div class="wb-history-item ${activeClass}" onclick="loadWorkbenchSessionUI('${escapeHtml(session.id)}')">
                    <div class="wb-history-item-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
                    <div class="wb-history-item-meta">
                        <span>${providerText} (${agentIdText}) · ${msgCountText}</span>
                        <span>${dateStr}</span>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        listEl.innerHTML = `<div class="wb-history-empty text-red-500">${escapeHtml(e.message)}</div>`;
    }
}

async function loadWorkbenchSessionUI(sessionId) {
    if (!sessionId) return;
    try {
        setWorkbenchStatus('Loading...', 'bg-amber-400');
        const res = await fetch(`/ui/workbench/session?sessionId=${encodeURIComponent(sessionId)}`);
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Failed to load session');
        }
        const session = await res.json();
        workbenchSession = session;
        
        // Clear message panel and remove welcome screen
        const messages = document.getElementById('workbenchMessages');
        if (messages) {
            messages.innerHTML = '';
        }
        
        // Render messages history
        if (Array.isArray(session.messages)) {
            for (const msg of session.messages) {
                if (msg.role === 'user') {
                    if (typeof msg.content === 'string') {
                        renderWorkbenchMessage('user', msg.content, null, { typing: false });
                    } else if (Array.isArray(msg.content)) {
                        // Check if it contains tool results
                        const toolResults = msg.content.filter(b => b.type === 'tool_result');
                        if (toolResults.length > 0) {
                            for (const result of toolResults) {
                                updateToolLine(result.tool_use_id, result.content, result.is_error);
                            }
                        } else {
                            // Text block
                            const textBlock = msg.content.find(b => b.type === 'text');
                            if (textBlock) {
                                renderWorkbenchMessage('user', textBlock.text, null, { typing: false });
                            }
                        }
                    }
                } else if (msg.role === 'assistant') {
                    if (typeof msg.content === 'string') {
                        renderWorkbenchMessage('assistant', msg.content, null, { typing: false });
                    } else if (Array.isArray(msg.content)) {
                        for (const block of msg.content) {
                            if (block.type === 'text') {
                                renderWorkbenchMessage('assistant', block.text, null, { typing: false });
                            } else if (block.type === 'tool_use') {
                                renderToolLine(block.id, block.name, block.input);
                            }
                        }
                    }
                }
            }
        }
        
        // Update select values to match loaded session
        const providerSelect = document.getElementById('workbenchProvider');
        if (providerSelect && session.provider) {
            providerSelect.value = session.provider;
        }
        const agentSelect = document.getElementById('workbenchAgent');
        if (agentSelect && session.agentId) {
            agentSelect.value = session.agentId;
        }
        
        // Render other components
        renderWorkbenchPlan();
        renderWorkbenchGoal();
        loadWorkbenchAgentsUI(true).catch(() => {});
        renderWorkbenchTodos();
        
        if (workbenchSession.approved) {
            setWorkbenchStatus('Plan approved', 'bg-emerald-400');
        } else if (workbenchSession.plan) {
            setWorkbenchStatus('Plan pending', 'bg-amber-400');
        } else {
            setWorkbenchStatus('Ready', 'bg-emerald-400');
        }
        
        showStatus('Workbench session loaded', 'bg-slate-700 text-white');
    } catch (e) {
        showStatus(e.message, 'bg-red-600 text-white');
        setWorkbenchStatus('Error.', 'bg-red-400');
    }
}
