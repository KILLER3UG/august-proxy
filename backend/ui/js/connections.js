// Service Connections UI
async function loadConnectionsUI() {
    const container = document.getElementById('connectionsCards');
    if (!container) return;
    container.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">Loading connections...</div>';

    try {
        const res = await fetch('/api/service-connections');
        const data = await res.json();
        renderConnections(container, data.connections || {});
    } catch (e) {
        container.innerHTML = '<div class="text-sm text-red-500">Failed to load connections: ' + e.message + '</div>';
    }
}

function renderConnections(container, connections) {
    const cards = {
        google: renderGoogleCard(connections.google || { status: 'disconnected' }),
        github: renderGithubCard(connections.github || { status: 'disconnected' }),
        slack: renderSlackCard(connections.slack || { status: 'disconnected' })
    };
    container.innerHTML = Object.values(cards).join('');
    attachConnectionHandlers(connections);
}

function renderGoogleCard(conn) {
    const connected = conn.status === 'connected';
    return `
        <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
            <div class="p-5">
                <div class="flex items-center justify-between mb-4">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-orange-500 flex items-center justify-center text-white text-sm font-bold">G</div>
                        <div>
                            <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">Google Workspace</h3>
                            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Gmail, Calendar, Drive, Docs, Sheets</p>
                        </div>
                    </div>
                    <span class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold ${connected ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}">
                        <span class="relative flex h-1.5 w-1.5 ${connected ? 'bg-emerald-500' : 'bg-slate-400'} rounded-full"></span>
                        ${connected ? 'Connected' : 'Not connected'}
                    </span>
                </div>
                ${connected ? `<p class="text-xs text-slate-600 dark:text-slate-300 mb-4">Authenticated as: <span class="font-mono">${conn.email || 'Unknown'}</span></p>` : '<p class="text-xs text-slate-500 dark:text-slate-400 mb-4">No Google account connected. Authenticate to access Gmail, Calendar, Drive, and more.</p>'}
                <div class="flex gap-2">
                    <button data-action="google-auth" class="minimal-button primary rounded-xl px-4 py-2 text-xs font-semibold flex-1">${connected ? 'Re-authenticate' : 'Connect Google'}</button>
                    ${connected ? '<button data-action="google-disconnect" class="minimal-button rounded-xl px-4 py-2 text-xs font-semibold text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800">Disconnect</button>' : ''}
                </div>
            </div>
        </div>`;
}

function renderGithubCard(conn) {
    const connected = conn.status === 'connected';
    const maskedToken = connected ? conn.token?.slice(0, 8) + '...' : '';
    return `
        <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
            <div class="p-5">
                <div class="flex items-center justify-between mb-4">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-xl bg-slate-900 dark:bg-white flex items-center justify-center text-white dark:text-slate-900 text-sm font-bold">
                            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                        </div>
                        <div>
                            <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">GitHub</h3>
                            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Repository access, PRs, issues, releases</p>
                        </div>
                    </div>
                    <span class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold ${connected ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}">
                        <span class="relative flex h-1.5 w-1.5 ${connected ? 'bg-emerald-500' : 'bg-slate-400'} rounded-full"></span>
                        ${connected ? 'Connected' : 'Not connected'}
                    </span>
                </div>
                ${connected ? `<p class="text-xs text-slate-600 dark:text-slate-300 mb-4">Token: <span class="font-mono">${maskedToken}</span></p>` : '<p class="text-xs text-slate-500 dark:text-slate-400 mb-4">Connect with a GitHub Personal Access Token.</p>'}
                <div id="github-form" class="space-y-3 ${connected ? 'hidden' : ''}">
                    <input id="github-token" class="minimal-input w-full rounded-xl p-2.5 text-xs font-mono" type="password" placeholder="ghp_... or github_pat_...">
                    <button data-action="github-connect" class="minimal-button primary rounded-xl px-4 py-2 text-xs font-semibold w-full">Connect</button>
                </div>
                ${connected ? '<button data-action="github-disconnect" class="minimal-button rounded-xl px-4 py-2 text-xs font-semibold text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 w-full">Disconnect</button>' : ''}
            </div>
        </div>`;
}

function renderSlackCard(conn) {
    const connected = conn.status === 'connected';
    return `
        <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
            <div class="p-5">
                <div class="flex items-center justify-between mb-4">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white text-sm font-bold">
                            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 012.52-2.52 2.527 2.527 0 012.52 2.52v6.313A2.528 2.528 0 018.833 24a2.528 2.528 0 01-2.52-2.522v-6.313zM8.833 5.042a2.528 2.528 0 01-2.52-2.52A2.528 2.528 0 018.833 0a2.528 2.528 0 012.52 2.522v2.52H8.833zM8.833 6.313a2.527 2.527 0 012.52 2.52 2.527 2.527 0 01-2.52 2.52H2.52A2.527 2.527 0 010 8.833a2.527 2.527 0 012.522-2.52h6.311zM18.958 8.833a2.528 2.528 0 012.52-2.52A2.528 2.528 0 0124 8.833a2.528 2.528 0 01-2.522 2.52h-2.52v-2.52zM17.687 8.833a2.527 2.527 0 01-2.52 2.52 2.527 2.527 0 01-2.52-2.52V2.52A2.527 2.527 0 0115.167 0a2.527 2.527 0 012.52 2.522v6.311zM15.167 18.958a2.528 2.528 0 012.52 2.52A2.528 2.528 0 0115.167 24a2.528 2.528 0 01-2.52-2.522v-2.52h2.52zM15.167 17.687a2.527 2.527 0 01-2.52-2.52 2.527 2.527 0 012.52-2.52h6.313A2.528 2.528 0 0124 15.167a2.528 2.528 0 01-2.522 2.52h-6.311z"/></svg>
                        </div>
                        <div>
                            <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">Slack</h3>
                            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Messaging, channels, workspace tools</p>
                        </div>
                    </div>
                    <span class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold ${connected ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}">
                        <span class="relative flex h-1.5 w-1.5 ${connected ? 'bg-emerald-500' : 'bg-slate-400'} rounded-full"></span>
                        ${connected ? 'Connected' : 'Not connected'}
                    </span>
                </div>
                <p class="text-xs text-slate-500 dark:text-slate-400 mb-4">Connect with a Slack Bot Token and Team ID.</p>
                <div id="slack-form" class="space-y-3 ${connected ? 'hidden' : ''}">
                    <input id="slack-token" class="minimal-input w-full rounded-xl p-2.5 text-xs font-mono" type="password" placeholder="xoxb-...">
                    <input id="slack-team" class="minimal-input w-full rounded-xl p-2.5 text-xs font-mono" placeholder="T... (Team ID)">
                    <button data-action="slack-connect" class="minimal-button primary rounded-xl px-4 py-2 text-xs font-semibold w-full">Connect</button>
                </div>
                ${connected ? '<button data-action="slack-disconnect" class="minimal-button rounded-xl px-4 py-2 text-xs font-semibold text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 w-full">Disconnect</button>' : ''}
            </div>
        </div>`;
}

function attachConnectionHandlers(connections) {
    // Google auth
    document.querySelectorAll('[data-action="google-auth"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = 'Opening authorization...';
            try {
                const res = await fetch('/api/service-connections/google/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: 'robertacepayales69@gmail.com' })
                });
                const data = await res.json();
                if (data.authUrl) {
                    window.open(data.authUrl, '_blank');
                    // After auth, refresh status
                    setTimeout(loadConnectionsUI, 5000);
                } else {
                    alert('Auth response: ' + (data.message || JSON.stringify(data)));
                    loadConnectionsUI();
                }
            } catch (e) {
                alert('Auth failed: ' + e.message);
                loadConnectionsUI();
            }
        });
    });

    // Google disconnect
    document.querySelectorAll('[data-action="google-disconnect"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            await fetch('/api/service-connections/google', { method: 'DELETE' });
            loadConnectionsUI();
        });
    });

    // GitHub connect
    document.querySelectorAll('[data-action="github-connect"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const token = document.getElementById('github-token')?.value;
            if (!token) return alert('Enter a GitHub token');
            await fetch('/api/service-connections/github', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
            });
            loadConnectionsUI();
        });
    });

    // GitHub disconnect
    document.querySelectorAll('[data-action="github-disconnect"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            await fetch('/api/service-connections/github', { method: 'DELETE' });
            loadConnectionsUI();
        });
    });

    // Slack connect
    document.querySelectorAll('[data-action="slack-connect"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const botToken = document.getElementById('slack-token')?.value;
            const teamId = document.getElementById('slack-team')?.value;
            if (!botToken) return alert('Enter a Slack Bot Token');
            await fetch('/api/service-connections/slack', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ botToken, teamId })
            });
            loadConnectionsUI();
        });
    });

    // Slack disconnect
    document.querySelectorAll('[data-action="slack-disconnect"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            await fetch('/api/service-connections/slack', { method: 'DELETE' });
            loadConnectionsUI();
        });
    });
}
