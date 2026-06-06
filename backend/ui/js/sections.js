/* ── Memory ── */

        let augustAgentState = [];
        let augustAgentSessionState = [];

        function escMemHtml(str) {
            if (!str) return '';
            return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        async function loadMemoryUI() {
            try {
                const res = await fetch('/ui/memory');
                const memory = await res.json();
                document.getElementById('memoryUserProfile').value = memory.user_profile || '';
                document.getElementById('memoryGlobalContext').value = memory.global_context || '';
                const learnedEl = document.getElementById('memoryLearnedGuidelines');
                if (learnedEl) {
                    learnedEl.value = Array.isArray(memory.learned_guidelines) ? memory.learned_guidelines.join('\n') : '';
                }

                // Active Projects
                const projectsEl = document.getElementById('memoryProjects');
                const projects = Array.isArray(memory.active_projects) ? memory.active_projects : [];
                document.getElementById('memoryProjectCount').textContent = projects.length;
                if (projects.length === 0) {
                    projectsEl.innerHTML = '<p class="text-xs text-slate-400 dark:text-slate-500 italic">No projects tracked yet</p>';
                } else {
                    projectsEl.innerHTML = projects.map(p => {
                        const statusBadge = p.status ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300">${escMemHtml(p.status)}</span>` : '';
                        const summary = p.summary ? `<p class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">${escMemHtml(p.summary)}</p>` : '';
                        const date = p.updated_at ? `<p class="mt-1 text-[9px] text-slate-400 dark:text-slate-500">${new Date(p.updated_at).toLocaleString()}</p>` : '';
                        return `<div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2"><div class="flex items-center justify-between"><span class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(p.name || 'Untitled')}</span>${statusBadge}</div>${summary}${date}</div>`;
                    }).join('');
                }

                // Integrations
                const intEl = document.getElementById('memoryIntegrations');
                const integrations = memory.integrations && typeof memory.integrations === 'object' ? Object.entries(memory.integrations) : [];
                document.getElementById('memoryIntegrationCount').textContent = integrations.length;
                if (integrations.length === 0) {
                    intEl.innerHTML = '<p class="text-xs text-slate-400 dark:text-slate-500 italic">No integrations recorded</p>';
                } else {
                    intEl.innerHTML = integrations.map(([name, d]) => {
                        const statusBadge = d?.status ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">${escMemHtml(d.status)}</span>` : '';
                        const summary = d?.summary ? `<p class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">${escMemHtml(d.summary)}</p>` : '';
                        return `<div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2"><div class="flex items-center justify-between"><span class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(name)}</span>${statusBadge}</div>${summary}</div>`;
                    }).join('');
                }

                // Recent Events
                const evEl = document.getElementById('memoryEvents');
                const events = Array.isArray(memory.recent_events) ? memory.recent_events : [];
                document.getElementById('memoryEventCount').textContent = events.length;
                if (events.length === 0) {
                    evEl.innerHTML = '<p class="text-xs text-slate-400 dark:text-slate-500 italic">No events recorded</p>';
                } else {
                    evEl.innerHTML = events.slice().reverse().map(ev => {
                        const ts = ev.timestamp ? `<span class="text-[9px] text-slate-400 dark:text-slate-500">${new Date(ev.timestamp).toLocaleString()}</span>` : '';
                        const src = ev.source ? `<span class="text-[9px] text-slate-400 dark:text-slate-500">via ${escMemHtml(ev.source)}</span>` : '';
                        return `<div class="flex gap-3 items-start py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0"><span class="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600"></span><div class="min-w-0"><p class="text-[11px] text-slate-600 dark:text-slate-300">${escMemHtml(ev.summary || '')}</p><div class="flex gap-2 mt-0.5">${ts}${src}</div></div></div>`;
                    }).join('');
                }

                // Conversation Checkpoints
                const cpEl = document.getElementById('memoryCheckpoints');
                const checkpoints = Array.isArray(memory.conversation_checkpoints) ? memory.conversation_checkpoints : [];
                document.getElementById('memoryCheckpointCount').textContent = checkpoints.length;
                if (checkpoints.length === 0) {
                    cpEl.innerHTML = '<p class="text-xs text-slate-400 dark:text-slate-500 italic">No checkpoints saved</p>';
                } else {
                    cpEl.innerHTML = checkpoints.slice().reverse().map(cp => {
                        const topic = cp.topic ? `<span class="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase">${escMemHtml(cp.topic)}</span>` : '';
                        const ts = cp.timestamp ? `<p class="mt-1 text-[9px] text-slate-400 dark:text-slate-500">${new Date(cp.timestamp).toLocaleString()}</p>` : '';
                        return `<div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2">${topic}<p class="text-[11px] text-slate-600 dark:text-slate-300 ${cp.topic ? 'mt-1' : ''}">${escMemHtml(cp.summary || '')}</p>${ts}</div>`;
                    }).join('');
                }

                document.getElementById('memoryLastSync').textContent = 'Last synced: ' + new Date().toLocaleTimeString();
                await Promise.all([loadMemoryPreview(), loadMemoryItemsUI()]);
            } catch (e) {
                const syncEl = document.getElementById('memoryLastSync');
                if (syncEl) syncEl.textContent = 'Memory refresh delayed; retrying on the next poll.';
            }
        }

        async function loadMemoryItemsUI() {
            const list = document.getElementById('memoryLifecycleList');
            if (!list) return;
            try {
                const res = await fetch('/ui/memory/items', { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to load memory lifecycle');
                memoryItemState = Array.isArray(data.items) ? data.items : [];
                renderMemoryItemsUI();
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        function memoryLifecycleClass(status) {
            if (status === 'active') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
            if (status === 'stale') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
            return 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400';
        }

        function renderMemoryItemsUI() {
            const list = document.getElementById('memoryLifecycleList');
            if (!list) return;
            if (memoryItemState.length === 0) {
                list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No August Brain items available yet.</div>';
                return;
            }

            list.innerHTML = memoryItemState.slice(0, 16).map(item => {
                const key = encodeURIComponent(item.key || '');
                const type = encodeURIComponent(item.type || '');
                const confidence = Math.round(Number(item.confidence || 0) * 100);
                const score = Number(item.injection?.score || 0);
                const nextStatus = item.status === 'archived' ? 'active' : 'archived';
                return `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex flex-wrap items-center gap-2">
                            <h3 class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100" title="${escapeHtml(item.title)}">${escapeHtml(item.title || 'Memory item')}</h3>
                            ${renderTinyBadge(item.pinned ? 'pinned' : 'unpinned', item.pinned ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}
                            ${renderTinyBadge(item.status || 'active', memoryLifecycleClass(item.status || 'active'))}
                        </div>
                        <p class="mt-2 line-clamp-3 text-xs leading-5 text-slate-500 dark:text-slate-400">${escapeHtml(item.summary || '')}</p>
                        <div class="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                            <span>Score ${score}</span>
                            <span>Confidence ${confidence}%</span>
                        </div>
                        <p class="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600 dark:bg-slate-950 dark:text-slate-300">${escapeHtml(item.injection?.reason || '')}</p>
                        <div class="mt-3 flex flex-wrap gap-2">
                            <button onclick="updateMemoryItemUI('${type}', '${key}', { pinned: ${item.pinned ? 'false' : 'true'} })" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">${item.pinned ? 'Unpin' : 'Pin'}</button>
                            <button onclick="updateMemoryItemUI('${type}', '${key}', { status: '${nextStatus}' })" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">${item.status === 'archived' ? 'Activate' : 'Archive'}</button>
                            <button onclick="updateMemoryItemUI('${type}', '${key}', { status: 'stale' })" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">Mark Stale</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        async function updateMemoryItemUI(type, key, updates) {
            try {
                const res = await fetch('/ui/memory/items', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: decodeURIComponent(type),
                        key: decodeURIComponent(key),
                        updates
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to update memory item');
                memoryItemState = Array.isArray(data.items) ? data.items : memoryItemState;
                renderMemoryItemsUI();
                await Promise.all([loadMemoryPreview(), loadHealthUI()]);
                showStatus('Memory lifecycle updated', 'bg-emerald-600 text-white');
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function searchMemoryUI() {
            const input = document.getElementById('memorySearchQuery');
            const results = document.getElementById('memorySearchResults');
            if (!input || !results) return;
            const query = input.value.trim();
            if (!query) {
                results.textContent = 'Search August Brain and local vector memory.';
                return;
            }
            results.textContent = 'Searching...';
            try {
                const res = await fetch('/ui/memory/search?q=' + encodeURIComponent(query), { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Search failed');
                const core = Array.isArray(data.core) ? data.core : [];
                const vector = Array.isArray(data.vector) ? data.vector : [];
                const coreHtml = core.length
                    ? core.map(item => `<div class="rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900"><p class="font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(item.title)}</p><p class="mt-1 leading-5">${escapeHtml(item.summary || '')}</p></div>`).join('')
                    : '<p class="text-slate-400 dark:text-slate-500">No core matches.</p>';
                const vectorHtml = vector.length
                    ? vector.map(item => {
                        const retrieval = item.retrieval || {};
                        const score = Number(item.score || 0);
                        const meta = [
                            retrieval.method || 'hybrid',
                            retrieval.sqliteFtsRank ? `FTS #${retrieval.sqliteFtsRank}` : '',
                            score ? `${Math.round(score * 100)}%` : ''
                        ].filter(Boolean).join(' · ');
                        return `<div class="rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
                            <div class="flex items-start justify-between gap-3">
                                <div>
                                    <p class="font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(item.topic || 'Vector memory')}</p>
                                    <p class="mt-1 leading-5">${escapeHtml(item.summary || '')}</p>
                                    <p class="mt-1 text-[10px] uppercase tracking-wide text-slate-400">${escapeHtml(meta)}</p>
                                </div>
                                ${item.id ? `<button onclick="applyMemoryGovernanceUI('forget_vector', '${escapeHtml(item.id)}')" class="minimal-button px-2 py-1 text-[10px]">Forget</button>` : ''}
                            </div>
                        </div>`;
                    }).join('')
                    : '<p class="text-slate-400 dark:text-slate-500">No vector matches.</p>';
                results.innerHTML = `
                    <div class="space-y-3">
                        <div>
                            <h3 class="text-[11px] font-bold uppercase text-slate-500 dark:text-slate-400">August Brain</h3>
                            <div class="mt-2 space-y-2">${coreHtml}</div>
                        </div>
                        <div>
                            <h3 class="text-[11px] font-bold uppercase text-slate-500 dark:text-slate-400">Vector Memory</h3>
                            <div class="mt-2 space-y-2">${vectorHtml}</div>
                            <p class="mt-2 text-[11px] text-slate-400 dark:text-slate-500">${Number(data.vectorCount || 0)} vector entries indexed</p>
                        </div>
                    </div>
                `;
            } catch (e) {
                results.innerHTML = `<div class="rounded-xl border border-red-200 bg-red-50 p-3 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        function refreshMemoryUI() {
            loadMemoryUI();
            showStatus('Memory refreshed', 'bg-slate-700 text-white');
        }

        async function saveMemoryUI() {
            try {
                const user_profile = document.getElementById('memoryUserProfile').value;
                const global_context = document.getElementById('memoryGlobalContext').value;
                const learnedEl = document.getElementById('memoryLearnedGuidelines');
                const learned_guidelines = learnedEl ? parseLinesOrJsonArray(learnedEl.value) : [];
                const res = await fetch('/ui/memory', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_profile, global_context, learned_guidelines })
                });
                if (res.ok) {
                    showStatus('Memory saved successfully!', 'bg-emerald-600 text-white');
                    await loadMemoryUI();
                } else {
                    showStatus('Failed to save memory', 'bg-red-600 text-white');
                }
            } catch (e) {
                showStatus('Network error saving memory', 'bg-red-600 text-white');
            }
        }

        function parseLinesOrJsonArray(value) {
            const text = String(value || '').trim();
            if (!text) return [];
            try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed)) return parsed.map(item => String(item)).filter(Boolean);
            } catch (e) {
                // Newline mode is friendlier for quick dashboard edits.
            }
            return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        }

        function parseEnvText(value) {
            const text = String(value || '').trim();
            if (!text) return {};
            try {
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
            } catch (e) {
                // Fall back to KEY=VALUE lines.
            }
            return Object.fromEntries(
                text.split(/\r?\n/)
                    .map(line => line.trim())
                    .filter(Boolean)
                    .map(line => {
                        const idx = line.indexOf('=');
                        return idx === -1
                            ? [line, '']
                            : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
                    })
                    .filter(([key]) => key)
            );
        }

/* ── Compatibility ── */
        async function loadCompatibilityUI() {
            const list = document.getElementById('compatibilityList');
            if (!list) return;
            try {
                const res = await fetch('/ui/compatibility', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                compatibilityState = await res.json();
                renderCompatibilityUI();
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        function renderCompatibilityUI() {
            const list = document.getElementById('compatibilityList');
            const host = document.getElementById('hostFilesInfo');
            if (!compatibilityState) return;
            const families = Array.isArray(compatibilityState.families) ? compatibilityState.families : [];
            list.innerHTML = families.map(family => {
                const tools = Array.isArray(family.tools) ? family.tools : [];
                const statusClass = family.status === 'available'
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                    : family.status === 'degraded'
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                        : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
                return `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex flex-wrap items-center gap-2">
                            <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(family.name)}</h3>
                            ${renderTinyBadge(family.status || 'unknown', statusClass)}
                            ${renderTinyBadge(family.mode || 'local', 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300')}
                        </div>
                        <p class="mt-2 max-h-28 overflow-auto font-mono text-[10px] leading-5 text-slate-500 dark:text-slate-400">${escapeHtml(tools.slice(0, 14).map(tool => tool.name).join('\n') || 'No tools listed')}</p>
                    </div>
                `;
            }).join('');
            if (host && compatibilityState.hostFiles) {
                const folders = compatibilityState.hostFiles.folders || [];
                host.textContent = [
                    `Host: ${compatibilityState.hostFiles.hostPath}`,
                    `Container: ${compatibilityState.hostFiles.containerPath}`,
                    `Folders: ${folders.map(folder => folder.name).join(', ') || 'none yet'}`,
                    compatibilityState.claudeDesktopPluginRestriction?.message || ''
                ].filter(Boolean).join('\n');
            }
        }

        async function createHostFilesFolderUI() {
            const name = document.getElementById('hostFolderName').value.trim() || 'dropzone';
            try {
                const res = await fetch('/ui/host-files/folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Could not create host_files folder');
                compatibilityState = data.compatibility;
                renderCompatibilityUI();
                showStatus(`Created ${data.folder.name}`, 'bg-emerald-600 text-white');
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

/* ── Plugins ── */
        async function loadPluginsUI() {
            const list = document.getElementById('pluginList');
            if (!list) return;
            try {
                const res = await fetch('/ui/plugins', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                pluginListState = Array.isArray(data.plugins) ? data.plugins : [];
                renderPluginsUI();
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        function renderPluginsUI() {
            const list = document.getElementById('pluginList');
            if (!list) return;
            if (pluginListState.length === 0) {
                list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No proxy plugins imported yet.</div>';
                return;
            }
            list.innerHTML = pluginListState.map(plugin => {
                const skillCount = Array.isArray(plugin.skills) ? plugin.skills.length : 0;
                const mcpCount = Array.isArray(plugin.mcpServers) ? plugin.mcpServers.length : 0;
                return `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0">
                                <div class="flex flex-wrap items-center gap-2">
                                    <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(plugin.name)}</h3>
                                    ${renderTinyBadge(plugin.enabled === false ? 'disabled' : 'enabled', plugin.enabled === false ? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300')}
                                </div>
                                <p class="mt-2 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(plugin.description || 'Imported proxy plugin')}</p>
                                <p class="mt-2 break-all font-mono text-[10px] text-slate-400 dark:text-slate-500">${escapeHtml(plugin.sourceUrl || '')}</p>
                                <p class="mt-2 text-[11px] text-slate-500 dark:text-slate-400">${skillCount} skills, ${mcpCount} MCP servers</p>
                            </div>
                            <div class="flex shrink-0 flex-col gap-2">
                                <button onclick="togglePluginUI('${plugin.name}', ${plugin.enabled === false ? 'true' : 'false'})" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">${plugin.enabled === false ? 'Enable' : 'Disable'}</button>
                                <button onclick="refreshPluginUI('${plugin.name}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">Update</button>
                                <button onclick="deletePluginUI('${plugin.name}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-300">Delete</button>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        async function togglePluginUI(name, enabled) {
            try {
                const res = await fetch('/ui/plugins/' + encodeURIComponent(name), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to update plugin');
                pluginListState = Array.isArray(data.plugins) ? data.plugins : [];
                renderPluginsUI();
                await Promise.all([loadMemoryPreview(), loadHealthUI()]);
                showStatus(enabled ? 'Proxy plugin enabled' : 'Proxy plugin disabled', 'bg-slate-700 text-white');
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function refreshPluginUI(name) {
            try {
                const res = await fetch('/ui/plugins/' + encodeURIComponent(name) + '/refresh', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to update plugin');
                pluginListState = Array.isArray(data.plugins) ? data.plugins : [];
                renderPluginsUI();
                await Promise.all([loadMcpUI(), loadSkillsUI(), loadMemoryPreview(), loadHealthUI()]);
                if (typeof invalidateWorkbenchSlashCommands === 'function') invalidateWorkbenchSlashCommands();
                showStatus('Proxy plugin refreshed from source', 'bg-emerald-600 text-white');
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function deletePluginUI(name) {
            if (!confirm(`Delete proxy plugin ${name}? Imported skills/MCP server configs remain until deleted from their own sections.`)) return;
            try {
                const res = await fetch('/ui/plugins/' + encodeURIComponent(name), { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to delete plugin');
                pluginListState = Array.isArray(data.plugins) ? data.plugins : [];
                renderPluginsUI();
                await Promise.all([loadMemoryPreview(), loadHealthUI()]);
                showStatus('Proxy plugin deleted', 'bg-slate-700 text-white');
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

/* ── MCP Servers ── */
function loadMcpSkillsUI() {
    return Promise.all([loadMcpUI(), loadSkillsUI(), loadPluginsUI(), loadCompatibilityUI(), loadMemoryPreview(), loadHealthUI()]);
}

        async function loadMcpUI() {
            const list = document.getElementById('mcpServerList');
            if (!list) return;
            try {
                const res = await fetch('/ui/mcp', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                mcpServerListState = Array.isArray(data.servers) ? data.servers : [];
                renderMcpServers(data);
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        function renderMcpServers(data) {
            const list = document.getElementById('mcpServerList');
            if (!list) return;
            const servers = Array.isArray(data.servers) ? data.servers : [];
            const statusMap = new Map((Array.isArray(data.status) ? data.status : []).map(item => [item.name, item]));
            if (servers.length === 0) {
                list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No MCP servers configured yet.</div>';
                return;
            }
            list.innerHTML = servers.map(server => {
                const status = statusMap.get(server.name) || server;
                const state = status.status || (server.enabled === false ? 'disabled' : 'not_started');
                const tools = Array.isArray(status.tools) && status.tools.length
                    ? `<p class="mt-2 text-[11px] text-slate-500 dark:text-slate-400">${escapeHtml(status.tools.slice(0, 8).join(', '))}${status.tools.length > 8 ? '...' : ''}</p>`
                    : '';
                const error = status.error
                    ? `<p class="mt-2 rounded-xl bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(status.error)}</p>`
                    : '';
                const commandLine = [server.command, ...(server.args || [])].filter(Boolean).join(' ');
                const sourceClass = server.source === 'builtin'
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                    : 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300';
                const toggleLabel = server.enabled === false ? 'Enable' : 'Disable';
                return `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div class="min-w-0">
                                <div class="flex flex-wrap items-center gap-2">
                                    <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(server.name)}</h3>
                                    ${renderTinyBadge(state, mcpStatusClass(state))}
                                    ${renderTinyBadge(server.source || 'custom', sourceClass)}
                                    ${server.enabled === false ? renderTinyBadge('disabled', 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400') : ''}
                                </div>
                                <p class="mt-2 break-all font-mono text-[11px] text-slate-500 dark:text-slate-400">${escapeHtml(commandLine || server.command)}</p>
                                ${status.toolCount ? `<p class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">${status.toolCount} tools registered</p>` : ''}
                                ${tools}
                                ${error}
                            </div>
                            <div class="flex shrink-0 gap-2">
                                <button onclick="fillMcpForm('${server.name}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">Edit</button>
                                <button onclick="toggleMcpServerUI('${server.name}', ${server.enabled === false ? 'true' : 'false'})" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">${toggleLabel}</button>
                                ${server.source !== 'builtin' ? `<button onclick="deleteMcpServerUI('${server.name}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-300">Delete</button>` : ''}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function fillMcpForm(name) {
            const server = mcpServerListState.find(item => item.name === name);
            if (!server) return;
            document.getElementById('mcpName').value = server.name || '';
            document.getElementById('mcpCommand').value = server.command || '';
            document.getElementById('mcpArgs').value = server.argsText || (server.args || []).join('\n');
            document.getElementById('mcpEnv').value = server.envText || '';
            document.getElementById('mcpCwd').value = server.cwd || '';
            document.getElementById('mcpEnabled').checked = server.enabled !== false;
        }

        async function saveMcpServerUI() {
            const payload = {
                name: document.getElementById('mcpName').value.trim(),
                command: document.getElementById('mcpCommand').value.trim(),
                args: parseLinesOrJsonArray(document.getElementById('mcpArgs').value),
                env: parseEnvText(document.getElementById('mcpEnv').value),
                cwd: document.getElementById('mcpCwd').value.trim() || undefined,
                enabled: document.getElementById('mcpEnabled').checked
            };
            try {
                const res = await fetch('/ui/mcp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to save MCP server');
                showStatus('MCP server saved and restarted', 'bg-emerald-600 text-white');
                await loadMcpUI();
                await loadMemoryPreview();
                await loadHealthUI();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function toggleMcpServerUI(name, enabled) {
            try {
                const res = await fetch('/ui/mcp/' + encodeURIComponent(name), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to update MCP server');
                mcpServerListState = Array.isArray(data.servers) ? data.servers : mcpServerListState;
                showStatus(enabled ? 'MCP server enabled and restarted' : 'MCP server disabled and restarted', enabled ? 'bg-emerald-600 text-white' : 'bg-slate-700 text-white');
                await Promise.all([loadMcpUI(), loadCompatibilityUI(), loadHealthUI(), loadMemoryPreview()]);
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function deleteMcpServerUI(name) {
            const server = mcpServerListState.find(item => item.name === name);
            const action = 'delete';
            if (!confirm(`Are you sure you want to ${action} ${name}?`)) return;
            try {
                const res = await fetch('/ui/mcp/' + encodeURIComponent(name), { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to update MCP server');
                showStatus('MCP server deleted', 'bg-slate-700 text-white');
                await Promise.all([loadMcpUI(), loadHealthUI()]);
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function restartMcpServersUI() {
            try {
                showStatus('Restarting MCP servers...', 'bg-slate-700 text-white');
                const res = await fetch('/ui/mcp/restart', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to restart MCP servers');
                await Promise.all([loadMcpUI(), loadHealthUI()]);
                showStatus('MCP servers restarted', 'bg-emerald-600 text-white');
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

/* ── Skills ── */
        async function loadSkillsUI() {
            const list = document.getElementById('skillList');
            if (!list) return;
            try {
                const res = await fetch('/ui/skills', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                skillListState = Array.isArray(data.skills) ? data.skills : [];
                renderSkills();
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        function renderSkills() {
            const list = document.getElementById('skillList');
            if (!list) return;
            if (skillListState.length === 0) {
                list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No custom skills configured yet.</div>';
                return;
            }
            list.innerHTML = skillListState.map(skill => {
                const trigger = skill.trigger
                    ? `<p class="mt-2 font-mono text-[11px] text-slate-500 dark:text-slate-400">${escapeHtml(skill.trigger)}</p>`
                    : '';
                const description = skill.description
                    ? `<p class="mt-2 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(skill.description)}</p>`
                    : '';
                return `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div class="min-w-0">
                                <div class="flex flex-wrap items-center gap-2">
                                    <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(skill.name)}</h3>
                                    ${renderTinyBadge(skill.enabled === false ? 'disabled' : 'enabled', skill.enabled === false ? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300')}
                                </div>
                                ${description}
                                ${trigger}
                                <p class="mt-2 line-clamp-3 text-[11px] leading-5 text-slate-500 dark:text-slate-400">${escapeHtml(skill.instructions || '')}</p>
                            </div>
                            <div class="flex shrink-0 gap-2">
                                <button onclick="fillSkillForm('${skill.name}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold">Edit</button>
                                <button onclick="deleteSkillUI('${skill.name}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-300">Delete</button>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function fillSkillForm(name) {
            const skill = skillListState.find(item => item.name === name);
            if (!skill) return;
            document.getElementById('skillName').value = skill.name || '';
            document.getElementById('skillTrigger').value = skill.trigger || '';
            document.getElementById('skillDescription').value = skill.description || '';
            document.getElementById('skillInstructions').value = skill.instructions || '';
            document.getElementById('skillEnabled').checked = skill.enabled !== false;
        }

        async function saveSkillUI() {
            const payload = {
                name: document.getElementById('skillName').value.trim(),
                trigger: document.getElementById('skillTrigger').value.trim(),
                description: document.getElementById('skillDescription').value.trim(),
                instructions: document.getElementById('skillInstructions').value.trim(),
                enabled: document.getElementById('skillEnabled').checked
            };
            try {
                const res = await fetch('/ui/skills', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to save skill');
                showStatus('Skill saved', 'bg-emerald-600 text-white');
                await Promise.all([loadSkillsUI(), loadMemoryPreview(), loadHealthUI()]);
                if (typeof invalidateWorkbenchSlashCommands === 'function') invalidateWorkbenchSlashCommands();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function deleteSkillUI(name) {
            if (!confirm(`Delete skill ${name}?`)) return;
            try {
                const res = await fetch('/ui/skills/' + encodeURIComponent(name), { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to delete skill');
                showStatus('Skill deleted', 'bg-slate-700 text-white');
                await Promise.all([loadSkillsUI(), loadMemoryPreview(), loadHealthUI()]);
                if (typeof invalidateWorkbenchSlashCommands === 'function') invalidateWorkbenchSlashCommands();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

/* ── Toggle collapsible sections ── */
        function toggleSection(elemId) {
            const el = document.getElementById(elemId);
            if (!el) return;
            el.classList.toggle('hidden');
        }

/* ── Memory Preview & Context Limit ── */
        async function loadMemoryPreview() {
            const meta = document.getElementById('memoryPreviewMeta');
            if (!meta) return;
            try {
                const limit = document.getElementById('memoryContextMaxChars')?.value || DEFAULT_MEMORY_CONTEXT_MAX_CHARS;

                async function fetchJson(url, fallback) {
                    try { const r = await fetch(url, { cache: 'no-store' }); return await r.json(); }
                    catch (e) { console.warn('Memory preview fetch failed:', url, e.message); return fallback; }
                }

                const [preview, memory, vector, semantic] = await Promise.all([
                    fetchJson(`/ui/memory/preview?profile=claude&maxChars=${encodeURIComponent(limit)}`, {}),
                    fetchJson('/ui/memory', { conversation_checkpoints: [] }),
                    fetchJson('/ui/memory/vector', { entries: [], count: 0 }),
                    fetchJson('/ui/semantic-memory', { facts: [] })
                ]);

                // Stats bar (with safe defaults for each data source)
                const checkpointCount = (memory.conversation_checkpoints || []).length;
                const facts = Array.isArray(semantic.facts) ? semantic.facts : [];
                const vecCount = vector.count || 0;
                const factEl = document.getElementById('memFactCount');
                if (factEl) factEl.textContent = formatExactNumber(facts.length);
                const chkCountEl = document.getElementById('memCheckpointCount');
                if (chkCountEl) chkCountEl.textContent = formatExactNumber(checkpointCount);
                const vecCountEl = document.getElementById('memVectorCount');
                if (vecCountEl) vecCountEl.textContent = formatExactNumber(vecCount);
                const allTimestamps = [
                    ...(memory.conversation_checkpoints || []).map(c => c.timestamp),
                    ...facts.map(f => f.updated || f.created || ''),
                    ...(vector.entries || []).map(e => e.timestamp)
                ].filter(Boolean).sort().reverse();
                const updatedEl = document.getElementById('memUpdated');
                if (updatedEl) updatedEl.textContent = allTimestamps.length
                    ? 'Last updated: ' + new Date(allTimestamps[0]).toLocaleDateString()
                    : 'Last updated: --';

                // Meta text
                if (preview.length !== undefined) {
                    const compactText = preview.prompt
                        ? ` Memory injected: ${formatExactNumber(preview.length)} chars.`
                        : '';
                    meta.textContent = `Memory: ${formatExactNumber(facts.length)} facts, ${formatExactNumber(checkpointCount)} checkpoints, ${formatExactNumber(vecCount)} vectors.${compactText}`;
                } else {
                    meta.textContent = `Memory: ${formatExactNumber(facts.length)} facts, ${formatExactNumber(checkpointCount)} checkpoints, ${formatExactNumber(vecCount)} vectors.`;
                }

                // Raw system prompt (hidden by default)
                const rawEl = document.getElementById('memRawPrompt');
                if (rawEl) rawEl.textContent = preview.prompt || '';

                // Semantic facts (independent — failures don't block other panels)
                try {
                    const factsEl = document.getElementById('memFactsContent');
                    if (factsEl) {
                        if (facts.length === 0) {
                            factsEl.innerHTML = '<div class="text-xs text-slate-400 dark:text-slate-500 italic">No semantic facts yet.</div>';
                        } else {
                            factsEl.innerHTML = facts.slice(0, 20).map(f => `
                                <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2">
                                    <div class="flex items-center gap-2">
                                        <code class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(f.key)}</code>
                                        <span class="text-[10px] px-1.5 py-0.5 rounded-full ${f.category === 'user_preference' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : f.category === 'project_info' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}">${escMemHtml(f.category || 'general')}</span>
                                    </div>
                                    <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escMemHtml(f.value)}</p>
                                </div>
                            `).join('');
                        }
                    }
                } catch (e) {
                    const factsEl = document.getElementById('memFactsContent');
                    if (factsEl) factsEl.innerHTML = '<div class="text-xs text-red-400 italic">Failed to load facts.</div>';
                }

                // Vector entries (independent)
                try {
                    const vecEl = document.getElementById('memVectorContent');
                    if (vecEl) {
                        const entries = vector.entries || [];
                        if (entries.length === 0) {
                            vecEl.innerHTML = '<div class="text-xs text-slate-400 dark:text-slate-500 italic">No vector entries yet.</div>';
                        } else {
                            vecEl.innerHTML = entries.slice(0, 20).map(e => `
                                <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2">
                                    <div class="flex items-center justify-between">
                                        <span class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(e.topic)}</span>
                                        <span class="text-[10px] text-slate-400">${new Date(e.timestamp).toLocaleDateString()}</span>
                                    </div>
                                    <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escMemHtml(e.summary)}</p>
                                </div>
                            `).join('');
                        }
                    }
                } catch (e) {
                    const vecEl = document.getElementById('memVectorContent');
                    if (vecEl) vecEl.innerHTML = '<div class="text-xs text-red-400 italic">Failed to load vectors.</div>';
                }

                // Checkpoints (independent)
                try {
                    const chkEl = document.getElementById('memCheckpointContent');
                    if (chkEl) {
                        const checkpoints = memory.conversation_checkpoints || [];
                        if (checkpoints.length === 0) {
                            chkEl.innerHTML = '<div class="text-xs text-slate-400 dark:text-slate-500 italic">No checkpoints saved yet.</div>';
                        } else {
                            chkEl.innerHTML = checkpoints.slice(0, 15).map(c => `
                                <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2">
                                    <div class="flex items-center justify-between">
                                        <span class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(c.topic || 'Checkpoint')}</span>
                                        <span class="text-[10px] text-slate-400">${new Date(c.timestamp).toLocaleDateString()}</span>
                                    </div>
                                    <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escMemHtml(c.summary || '')}</p>
                                </div>
                            `).join('');
                        }
                    }
                } catch (e) {
                    const chkEl = document.getElementById('memCheckpointContent');
                    if (chkEl) chkEl.innerHTML = '<div class="text-xs text-red-400 italic">Failed to load checkpoints.</div>';
                }

            } catch (e) {
                if (meta) meta.textContent = 'Memory preview error: ' + e.message;
            }
        }

        async function saveMemoryContextLimitUI() {
            const input = document.getElementById('memoryContextMaxChars');
            const value = Number.parseInt(input?.value, 10);
            if (!Number.isFinite(value) || value < 8000 || value > MAX_MEMORY_CONTEXT_CHARS) {
                showStatus('Brain limit must be between 8,000 and 64,000 characters', 'bg-red-600 text-white');
                return;
            }
            const res = await fetch('/ui/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ memoryContextMaxChars: value })
            });
            if (!res.ok) {
                showStatus('Failed to save brain limit', 'bg-red-600 text-white');
                return;
            }
            currentConfigState = { ...currentConfigState, memoryContextMaxChars: value };
            showStatus('Brain context limit saved', 'bg-green-600 text-white');
            await Promise.all([loadMemoryPreview(), loadHealthUI()]);
        }

/* ── August / Semantic Memory ── */
        async function loadSemanticMemoryUI() {
            const list = document.getElementById('semanticMemoryList');
            if (!list) return;
            try {
                const res = await fetch('/ui/semantic-memory', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                const facts = Array.isArray(data.facts) ? data.facts : [];
                if (facts.length === 0) {
                    list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No semantic memory facts stored yet. Facts are auto-extracted from conversations or set via august__remember.</div>';
                    return;
                }
                list.innerHTML = facts.map((f, i) => `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0 flex-1">
                                <div class="flex flex-wrap items-center gap-2">
                                    <code class="text-xs font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(f.key)}</code>
                                    ${renderTinyBadge(f.category, f.category === 'user_preference' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : f.category === 'user_detail' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' : f.category === 'project_info' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : f.category === 'workflow_rule' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}
                                    ${f.ttl ? renderTinyBadge('TTL: ' + new Date(f.ttl).toLocaleDateString(), 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300') : ''}
                                </div>
                                <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">${escapeHtml(f.value)}</p>
                                <p class="mt-1 text-[10px] text-slate-400 dark:text-slate-500">source: ${escapeHtml(f.source || 'unknown')} &middot; updated: ${new Date(f.updated).toLocaleString()}</p>
                            </div>
                            <button onclick="deleteSemanticFactUI('${escapeHtml(f.key)}')" class="minimal-button shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-300">Delete</button>
                        </div>
                    </div>
                `).join('');
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        async function deleteSemanticFactUI(key) {
            if (!confirm(`Delete semantic fact "${key}"?`)) return;
            try {
                const res = await fetch('/ui/semantic-memory', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key })
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                showStatus('Semantic fact deleted', 'bg-slate-700 text-white');
                loadSemanticMemoryUI();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        function loadAugustUI() {
            loadMemoryProvidersUI();
            loadAgentRegistryUI();
            loadAgentSessionsUI();
            loadAutomationJobsUI();
            loadBrainDiagnosticsUI();
            loadTerminalPanelUI();
            loadSemanticMemoryUI();
            loadSpecialistUI();
            loadUrlMcpUI();
            loadVectorMemoryUI();
            if (document.getElementById('supermemoryUrl')) {
                fetch('/ui/config/safe', { cache: 'no-store' }).then(r=>r.json()).then(cfg => {
                    const urlEl = document.getElementById('supermemoryUrl');
                    if (urlEl && cfg.supermemoryUrl) urlEl.value = cfg.supermemoryUrl;
                }).catch(() => {});
            }
        }

/* ── August Provider Stack ── */
        function permissionBadgeClass(value) {
            if (value === 'allow') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
            if (value === 'deny') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
            return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
        }

        function renderPermissionBadges(permissions) {
            return Object.entries(permissions || {}).map(([key, value]) =>
                renderTinyBadge(`${key}:${value}`, permissionBadgeClass(value))
            ).join(' ');
        }

        async function loadMemoryProvidersUI() {
            const list = document.getElementById('memoryProviderList');
            const recall = document.getElementById('memoryProviderRecall');
            const eventsEl = document.getElementById('memoryProviderEvents');
            const status = document.getElementById('memoryProviderStatus');
            if (!list && !recall && !eventsEl && !status) return;
            const query = document.getElementById('providerRecallQuery')?.value?.trim() || 'august brain proxy';
            try {
                const [providersRes, storeRes, eventsRes] = await Promise.all([
                    fetch('/ui/memory/providers?q=' + encodeURIComponent(query), { cache: 'no-store' }),
                    fetch('/ui/memory/store/status', { cache: 'no-store' }),
                    fetch('/ui/memory/provider-events?limit=12', { cache: 'no-store' })
                ]);
                const data = await providersRes.json();
                const store = await storeRes.json();
                const providerEvents = await eventsRes.json();
                if (!providersRes.ok) throw new Error(data.error || 'Failed to load memory providers');
                const providers = Array.isArray(data.providers) ? data.providers : [];
                if (status) {
                    status.textContent = `SQLite ${store.available ? 'available' : 'fallback'} via ${store.driver || 'unknown'} with ${formatExactNumber(store.count || 0)} mirrored rows.`;
                }
                if (list) {
                    list.innerHTML = providers.map(provider => {
                        const hooks = (provider.hooks || []).map(hook => renderTinyBadge(hook, 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')).join(' ');
                        const detail = provider.status
                            ? `${provider.status.driver || 'unknown'} · ${formatExactNumber(provider.status.count || 0)} rows`
                            : provider.type;
                        return `
                            <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                                <div class="flex items-start justify-between gap-3">
                                    <div>
                                        <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(provider.label || provider.id)}</h3>
                                        <p class="mt-1 text-[11px] text-slate-400 dark:text-slate-500">${escapeHtml(detail || '')}</p>
                                    </div>
                                    ${renderTinyBadge(provider.enabled ? 'enabled' : 'disabled', provider.enabled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}
                                </div>
                                <div class="mt-3 flex flex-wrap gap-1.5">${hooks}</div>
                            </div>
                        `;
                    }).join('');
                }
                if (recall) {
                    const recalled = Array.isArray(data.recalled) ? data.recalled : [];
                    recall.innerHTML = recalled.length
                        ? recalled.map(item => `
                            <div class="mb-3 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
                                <div class="flex items-center gap-2">
                                    ${renderTinyBadge(item.provider || 'provider', 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300')}
                                    ${renderTinyBadge(item.type || 'memory', 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}
                                </div>
                                <p class="mt-2 font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(item.title || 'Memory result')}</p>
                                <p class="mt-1 leading-5">${escapeHtml(item.text || '')}</p>
                            </div>
                        `).join('')
                        : '<div class="text-slate-400 dark:text-slate-500">No provider recall results for this query.</div>';
                }
                if (eventsEl) {
                    const events = Array.isArray(providerEvents.events) ? providerEvents.events : [];
                    eventsEl.innerHTML = events.length
                        ? events.map(event => `
                            <div class="mb-2 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
                                <div class="flex items-center justify-between gap-2">
                                    <span class="font-semibold text-slate-700 dark:text-slate-200">${escapeHtml(event.providerId || 'provider')}.${escapeHtml(event.hook || 'hook')}</span>
                                    <span class="text-[10px] text-slate-400">${event.createdAt ? new Date(event.createdAt).toLocaleTimeString() : ''}</span>
                                </div>
                                <p class="mt-1 truncate font-mono text-[10px] text-slate-400">${escapeHtml(event.sessionId || event.id || '')}</p>
                            </div>
                        `).join('')
                        : '<div class="text-slate-400 dark:text-slate-500">No provider hook events yet.</div>';
                }
            } catch (e) {
                if (list) list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        async function rebuildSqliteMemoryUI() {
            const status = document.getElementById('memoryProviderStatus');
            try {
                if (status) status.textContent = 'Rebuilding SQLite mirror...';
                const res = await fetch('/ui/memory/store/rebuild', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'SQLite rebuild failed');
                showStatus(`SQLite memory mirror rebuilt: ${data.synced || 0} rows`, 'bg-emerald-600 text-white');
                await loadMemoryProvidersUI();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

/* ── August Agents ── */
        function fillAgentFormUI(encodedId) {
            const id = decodeURIComponent(encodedId || '');
            const agent = augustAgentState.find(item => item.id === id);
            if (!agent) return;
            document.getElementById('agentIdInput').value = agent.id || '';
            document.getElementById('agentRoleInput').value = agent.role || '';
            document.getElementById('agentGoalInput').value = agent.goal || '';
            document.getElementById('agentModeInput').value = agent.mode || 'subagent';
            document.getElementById('agentTemplateInput').value = agent.id || 'general';
            document.getElementById('agentMemoryEnabledInput').checked = agent.memory_enabled !== false;
            document.getElementById('agentDelegationInput').checked = agent.allow_delegation === true;
        }

        async function loadAgentRegistryUI() {
            const list = document.getElementById('agentRegistryList');
            if (!list) return;
            try {
                const res = await fetch('/ui/agents', { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to load agents');
                augustAgentState = Array.isArray(data.agents) ? data.agents : [];
                list.innerHTML = augustAgentState.map(agent => `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0">
                                <div class="flex flex-wrap items-center gap-2">
                                    <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(agent.id)}</h3>
                                    ${renderTinyBadge(agent.mode || 'agent', agent.mode === 'primary' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}
                                </div>
                                <p class="mt-1 text-xs font-semibold text-slate-600 dark:text-slate-300">${escapeHtml(agent.role || '')}</p>
                                <p class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">${escapeHtml(agent.goal || '')}</p>
                            </div>
                            <button onclick="fillAgentFormUI('${encodeURIComponent(agent.id)}')" class="minimal-button shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold">Edit</button>
                        </div>
                        <div class="mt-3 flex flex-wrap gap-1.5">${renderPermissionBadges(agent.permissions)}</div>
                    </div>
                `).join('');
                await deriveAgentPermissionsUI();
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        async function saveAgentRegistryUI() {
            const id = document.getElementById('agentIdInput')?.value?.trim();
            if (!id) {
                showStatus('Agent id is required', 'bg-red-600 text-white');
                return;
            }
            const templateId = document.getElementById('agentTemplateInput')?.value || 'general';
            const template = augustAgentState.find(agent => agent.id === templateId) || augustAgentState.find(agent => agent.id === 'general') || {};
            const payload = {
                id,
                role: document.getElementById('agentRoleInput')?.value?.trim() || id,
                goal: document.getElementById('agentGoalInput')?.value?.trim() || 'Handle assigned August Brain work.',
                mode: document.getElementById('agentModeInput')?.value || 'subagent',
                memory_enabled: document.getElementById('agentMemoryEnabledInput')?.checked !== false,
                allow_delegation: document.getElementById('agentDelegationInput')?.checked === true,
                permissions: template.permissions || {},
                tools: template.tools || []
            };
            try {
                const res = await fetch('/ui/agents', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to save agent');
                showStatus('Agent saved', 'bg-emerald-600 text-white');
                await loadAgentRegistryUI();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function deriveAgentPermissionsUI(parentOverride, childOverride) {
            const preview = document.getElementById('agentPermissionPreview');
            if (!preview) return;
            const parentAgent = parentOverride ? decodeURIComponent(parentOverride) : (document.getElementById('agentParentInput')?.value?.trim() || 'build');
            const childAgent = childOverride ? decodeURIComponent(childOverride) : (document.getElementById('agentChildInput')?.value?.trim() || 'general');
            try {
                const res = await fetch('/ui/agents/permissions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ parentAgent, childAgent })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Permission check failed');
                preview.textContent = JSON.stringify({ parentAgent, childAgent, permissions: data.permissions }, null, 2);
            } catch (e) {
                preview.textContent = e.message;
            }
        }

/* ── August Agent Sessions ── */
        function sessionStatusClass(status) {
            if (status === 'running') return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
            if (status === 'blocked') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
            if (status === 'completed') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
            if (status === 'failed' || status === 'cancelled') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
            return 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400';
        }

        function pendingRequestCount(session) {
            const permissions = Array.isArray(session.permissions) ? session.permissions : [];
            const questions = Array.isArray(session.questions) ? session.questions : [];
            return permissions.filter(item => item.status === 'pending').length + questions.filter(item => item.status === 'pending').length;
        }

        async function loadAgentSessionsUI() {
            const list = document.getElementById('agentSessionList');
            const summary = document.getElementById('agentSessionSummary');
            if (!list && !summary) return;
            try {
                const res = await fetch('/ui/agent-sessions', { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to load agent sessions');
                augustAgentSessionState = Array.isArray(data.sessions) ? data.sessions : [];
                if (summary) {
                    const counts = data.counts || {};
                    summary.textContent = `${formatExactNumber(counts.total || 0)} sessions · ${formatExactNumber(counts.running || 0)} running · ${formatExactNumber(counts.blocked || 0)} blocked.`;
                }
                if (!list) return;
                list.innerHTML = augustAgentSessionState.length ? augustAgentSessionState.map(session => {
                    const todos = session.todoSummary || {};
                    const requests = pendingRequestCount(session);
                    return `
                        <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                            <div class="flex items-start justify-between gap-3">
                                <div class="min-w-0">
                                    <div class="flex flex-wrap items-center gap-2">
                                        <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(session.title || session.id)}</h3>
                                        ${renderTinyBadge(session.status || 'idle', sessionStatusClass(session.status))}
                                        ${session.todoDock && session.todoDock !== 'hide' ? renderTinyBadge(`todos:${session.todoDock}`, 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300') : ''}
                                    </div>
                                    <p class="mt-1 truncate font-mono text-[10px] text-slate-400">${escapeHtml(session.id || '')}</p>
                                    <p class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">${escapeHtml(session.task || session.lastRun?.command || '')}</p>
                                    <p class="mt-1 font-mono text-[10px] text-slate-400">agent: ${escapeHtml(session.agent || 'build')} · todos: ${formatExactNumber(todos.pending || 0)}/${formatExactNumber(todos.total || 0)} pending · requests: ${formatExactNumber(requests)}</p>
                                </div>
                            </div>
                            <div class="mt-3 flex flex-wrap gap-2">
                                <button onclick="inspectAgentSessionUI('${encodeURIComponent(session.id)}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs">Inspect</button>
                                <button onclick="copyAgentSessionRunIdUI('${encodeURIComponent(session.id)}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs">Use</button>
                                <button onclick="cancelAgentSessionUI('${encodeURIComponent(session.id)}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs">Cancel</button>
                                <button onclick="deleteAgentSessionUI('${encodeURIComponent(session.id)}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs text-red-600 dark:text-red-300">Delete</button>
                            </div>
                        </div>
                    `;
                }).join('') : '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No agent sessions yet.</div>';
            } catch (e) {
                if (list) list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        function copyAgentSessionRunIdUI(encodedId) {
            const id = decodeURIComponent(encodedId);
            const runInput = document.getElementById('agentSessionRunIdInput');
            const parentInput = document.getElementById('agentSessionParentInput');
            if (runInput) runInput.value = id;
            if (parentInput) parentInput.value = id;
        }

        async function inspectAgentSessionUI(encodedId) {
            const id = decodeURIComponent(encodedId);
            const detail = document.getElementById('agentSessionDetail');
            copyAgentSessionRunIdUI(encodedId);
            try {
                const res = await fetch('/ui/agent-sessions/' + encodeURIComponent(id), { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to inspect session');
                if (detail) detail.textContent = JSON.stringify(data, null, 2);
            } catch (e) {
                if (detail) detail.textContent = e.message;
            }
        }

        async function createAgentSessionUI() {
            const payload = {
                title: document.getElementById('agentSessionTitleInput')?.value?.trim() || 'August session',
                agent: document.getElementById('agentSessionAgentInput')?.value?.trim() || 'build',
                parentId: document.getElementById('agentSessionParentInput')?.value?.trim() || undefined,
                task: document.getElementById('agentSessionTaskInput')?.value?.trim() || '',
                cwd: document.getElementById('agentSessionCwdInput')?.value?.trim() || undefined
            };
            try {
                const res = await fetch('/ui/agent-sessions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to create agent session');
                showStatus('Agent session created', 'bg-emerald-600 text-white');
                if (data.session?.id) copyAgentSessionRunIdUI(encodeURIComponent(data.session.id));
                await loadAgentSessionsUI();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function runAgentSessionCommandUI() {
            const id = document.getElementById('agentSessionRunIdInput')?.value?.trim();
            const command = document.getElementById('agentSessionCommandInput')?.value?.trim();
            const timeoutMs = Number(document.getElementById('agentSessionTimeoutInput')?.value || 180000);
            const approved = document.getElementById('agentSessionApprovedInput')?.checked === true;
            const detail = document.getElementById('agentSessionDetail');
            if (!id || !command) {
                showStatus('Session id and command are required', 'bg-red-600 text-white');
                return;
            }
            if (detail) detail.textContent = 'Running...';
            try {
                const res = await fetch('/ui/agent-sessions/' + encodeURIComponent(id) + '/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command, approved, timeoutMs })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Agent session run failed');
                if (detail) detail.textContent = JSON.stringify(data, null, 2);
                await loadAgentSessionsUI();
            } catch (e) {
                if (detail) detail.textContent = e.message;
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function cancelAgentSessionUI(encodedId) {
            const id = decodeURIComponent(encodedId);
            try {
                const res = await fetch('/ui/agent-sessions/' + encodeURIComponent(id) + '/cancel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason: 'dashboard cancel' })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to cancel session');
                await loadAgentSessionsUI();
                await inspectAgentSessionUI(encodeURIComponent(id));
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function deleteAgentSessionUI(encodedId) {
            const id = decodeURIComponent(encodedId);
            if (!confirm(`Delete session ${id}?`)) return;
            try {
                const res = await fetch('/ui/agent-sessions/' + encodeURIComponent(id) + '?includeChildren=true', { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to delete session');
                await loadAgentSessionsUI();
                const detail = document.getElementById('agentSessionDetail');
                if (detail) detail.textContent = JSON.stringify(data, null, 2);
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

/* ── August Terminal ── */
        async function loadTerminalPanelUI() {
            const sessionsEl = document.getElementById('terminalSessionList');
            const approvalsEl = document.getElementById('terminalApprovalList');
            if (!sessionsEl && !approvalsEl) return;
            try {
                const res = await fetch('/ui/terminal/sessions', { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to load terminal sessions');
                const sessions = Array.isArray(data.sessions) ? data.sessions : [];
                const approvals = Array.isArray(data.approvals) ? data.approvals : [];
                if (sessionsEl) {
                    sessionsEl.innerHTML = sessions.length ? sessions.map(session => `
                        <div class="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                            <div class="flex items-start justify-between gap-2">
                                <div class="min-w-0">
                                    <p class="font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(session.title || session.id)}</p>
                                    <p class="mt-1 truncate font-mono text-[10px] text-slate-400">${escapeHtml(session.cwd || '')}</p>
                                </div>
                                ${renderTinyBadge(session.status || 'unknown', session.status === 'running' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}
                            </div>
                            <div class="mt-2 flex gap-2">
                                <button onclick="readTerminalBufferUI('${encodeURIComponent(session.id)}')" class="minimal-button rounded-lg px-2 py-1 text-[10px]">Buffer</button>
                                <button onclick="closeTerminalSessionUI('${encodeURIComponent(session.id)}')" class="minimal-button rounded-lg px-2 py-1 text-[10px] text-red-600 dark:text-red-300">Close</button>
                            </div>
                        </div>
                    `).join('') : '<div class="text-slate-400 dark:text-slate-500">No interactive sessions.</div>';
                }
                if (approvalsEl) {
                    approvalsEl.innerHTML = approvals.length ? approvals.map(item => `
                        <div class="rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                            <p class="font-semibold text-amber-800 dark:text-amber-200">${escapeHtml(item.reason || item.type || 'approval required')}</p>
                            <p class="mt-1 break-all font-mono text-[10px] text-amber-700 dark:text-amber-300">${escapeHtml(item.command || item.inputPreview || item.id)}</p>
                            <div class="mt-2 flex gap-2">
                                <button onclick="approveTerminalUI('${encodeURIComponent(item.id)}', true)" class="minimal-button rounded-lg px-2 py-1 text-[10px]">Approve</button>
                                <button onclick="approveTerminalUI('${encodeURIComponent(item.id)}', false)" class="minimal-button rounded-lg px-2 py-1 text-[10px]">Reject</button>
                            </div>
                        </div>
                    `).join('') : '<div class="text-slate-400 dark:text-slate-500">No pending terminal approvals.</div>';
                }
            } catch (e) {
                if (sessionsEl) sessionsEl.innerHTML = `<div class="text-red-500">${escapeHtml(e.message)}</div>`;
            }
        }

        async function runTerminalCommandUI() {
            const output = document.getElementById('terminalCommandOutput');
            const command = document.getElementById('terminalCommandInput')?.value?.trim();
            const cwd = document.getElementById('terminalCwdInput')?.value?.trim();
            const timeoutMs = Number(document.getElementById('terminalTimeoutInput')?.value || 180000);
            const approved = document.getElementById('terminalApprovedInput')?.checked === true;
            if (!command) {
                showStatus('Command is required', 'bg-red-600 text-white');
                return;
            }
            if (output) output.textContent = 'Running...';
            try {
                const res = await fetch('/ui/terminal/command', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command, cwd, approved, timeoutMs })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Terminal command failed');
                if (output) output.textContent = data.output || JSON.stringify(data, null, 2);
                await loadTerminalPanelUI();
            } catch (e) {
                if (output) output.textContent = e.message;
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function createTerminalSessionUI() {
            const cwd = document.getElementById('terminalCwdInput')?.value?.trim();
            const approvedInteractive = document.getElementById('terminalApprovedInput')?.checked === true;
            try {
                const res = await fetch('/ui/terminal/sessions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'Dashboard shell', cwd, approvedInteractive })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to start terminal session');
                showStatus('Terminal session started', 'bg-emerald-600 text-white');
                await loadTerminalPanelUI();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function readTerminalBufferUI(encodedId) {
            const id = decodeURIComponent(encodedId);
            const output = document.getElementById('terminalCommandOutput');
            try {
                const res = await fetch('/ui/terminal/buffer?id=' + encodeURIComponent(id), { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to read terminal buffer');
                if (output) output.textContent = data.buffer || '[empty buffer]';
            } catch (e) {
                if (output) output.textContent = e.message;
            }
        }

        async function closeTerminalSessionUI(encodedId) {
            const id = decodeURIComponent(encodedId);
            try {
                await fetch('/ui/terminal/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
                await loadTerminalPanelUI();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function approveTerminalUI(encodedId, approve) {
            const requestId = decodeURIComponent(encodedId);
            const output = document.getElementById('terminalCommandOutput');
            try {
                const res = await fetch('/ui/terminal/approve', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId, approve })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Terminal approval failed');
                if (output) output.textContent = data.output || JSON.stringify(data, null, 2);
                await loadTerminalPanelUI();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

/* ── August Automations ── */
        async function loadAutomationJobsUI() {
            const jobsEl = document.getElementById('automationJobList');
            const runsEl = document.getElementById('automationRunList');
            if (!jobsEl && !runsEl) return;
            try {
                const res = await fetch('/ui/automations', { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to load automations');
                const jobs = Array.isArray(data.jobs) ? data.jobs : [];
                const runs = Array.isArray(data.runs) ? data.runs : [];
                if (jobsEl) {
                    jobsEl.innerHTML = jobs.length ? jobs.map(job => `
                        <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                            <div class="flex items-start justify-between gap-3">
                                <div class="min-w-0">
                                    <div class="flex flex-wrap items-center gap-2">
                                        <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(job.name || job.id)}</h3>
                                        ${renderTinyBadge(job.type || 'job', 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300')}
                                        ${job.approved ? renderTinyBadge('approved', 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300') : renderTinyBadge('approval gated', 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300')}
                                    </div>
                                    <p class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">${escapeHtml(job.task || job.command || '')}</p>
                                    <p class="mt-1 font-mono text-[10px] text-slate-400">schedule: ${escapeHtml(job.schedule || 'manual')} · timeout: ${formatExactNumber(job.timeoutMs || 0)}ms · next: ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : 'manual'}</p>
                                </div>
                            </div>
                            <div class="mt-3 flex flex-wrap gap-2">
                                <button onclick="runAutomationJobUI('${encodeURIComponent(job.id)}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs">Run</button>
                                <button onclick="deleteAutomationJobUI('${encodeURIComponent(job.id)}')" class="minimal-button rounded-lg px-3 py-1.5 text-xs text-red-600 dark:text-red-300">Delete</button>
                            </div>
                        </div>
                    `).join('') : '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No automation jobs yet.</div>';
                }
                if (runsEl) {
                    runsEl.innerHTML = runs.length ? runs.slice(-12).reverse().map(run => `
                        <div class="rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
                            <div class="flex items-center justify-between gap-3">
                                <span class="font-mono text-[10px] text-slate-400">${escapeHtml(run.jobId || '')}</span>
                                ${renderTinyBadge(run.status || 'unknown', run.status === 'completed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : run.status === 'approval_required' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}
                            </div>
                            <p class="mt-1 text-[11px] leading-5">${escapeHtml(run.output || '')}</p>
                        </div>
                    `).join('') : 'No runs yet.';
                }
            } catch (e) {
                if (jobsEl) jobsEl.innerHTML = `<div class="text-red-500">${escapeHtml(e.message)}</div>`;
            }
        }

        async function saveAutomationJobUI() {
            const type = document.getElementById('automationTypeInput')?.value || 'memory_event';
            const command = document.getElementById('automationCommandInput')?.value?.trim() || '';
            if (type === 'command' && !command) {
                showStatus('Command jobs need a command', 'bg-red-600 text-white');
                return;
            }
            const payload = {
                name: document.getElementById('automationNameInput')?.value?.trim() || 'August automation',
                schedule: document.getElementById('automationScheduleInput')?.value?.trim() || 'manual',
                type,
                agent: document.getElementById('automationAgentInput')?.value?.trim() || 'build',
                task: document.getElementById('automationTaskInput')?.value?.trim() || '',
                command,
                cwd: document.getElementById('automationCwdInput')?.value?.trim() || undefined,
                timeoutMs: Number(document.getElementById('automationTimeoutInput')?.value || 180000),
                approved: document.getElementById('automationApprovedInput')?.checked === true
            };
            try {
                const res = await fetch('/ui/automations', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to save automation');
                showStatus('Automation saved', 'bg-emerald-600 text-white');
                await loadAutomationJobsUI();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function runAutomationJobUI(encodedId) {
            const id = decodeURIComponent(encodedId);
            try {
                const res = await fetch('/ui/automations/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Automation run failed');
                showStatus(`Automation run: ${data.run?.status || data.result?.status || 'done'}`, 'bg-slate-700 text-white');
                await loadAutomationJobsUI();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

        async function deleteAutomationJobUI(encodedId) {
            const id = decodeURIComponent(encodedId);
            if (!confirm(`Delete automation ${id}?`)) return;
            try {
                await fetch('/ui/automations/' + encodeURIComponent(id), { method: 'DELETE' });
                await loadAutomationJobsUI();
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }

/* ── August Governance & Diagnostics ── */
        function renderGovernanceCard(title, items, renderButtons) {
            const content = items.length ? items.map(item => `
                <div class="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                    <p class="font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(item.title || item.key || item.topic || 'Memory')}</p>
                    <p class="mt-1 text-[11px] leading-5 text-slate-500 dark:text-slate-400">${escapeHtml(item.summary || item.value || '')}</p>
                    <div class="mt-2 flex flex-wrap gap-2">${renderButtons(item)}</div>
                </div>
            `).join('') : '<div class="text-xs text-slate-400 dark:text-slate-500">No matches.</div>';
            return `
                <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
                    <h3 class="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">${escapeHtml(title)}</h3>
                    <div class="mt-3 grid gap-2">${content}</div>
                </div>
            `;
        }

        async function searchMemoryGovernanceUI() {
            const results = document.getElementById('governanceResults');
            if (!results) return;
            const query = document.getElementById('governanceQueryInput')?.value?.trim() || 'august brain';
            results.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">Searching...</div>';
            try {
                const res = await fetch('/ui/memory/governance?q=' + encodeURIComponent(query), { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Memory governance search failed');
                const core = Array.isArray(data.core) ? data.core : [];
                const semantic = Array.isArray(data.semantic) ? data.semantic : [];
                const vector = Array.isArray(data.vector) ? data.vector : [];
                results.innerHTML = [
                    renderGovernanceCard('Core Memory', core, item => `
                        <button onclick="applyMemoryGovernanceUI('pin_core', { type: '${encodeURIComponent(item.type || '')}', key: '${encodeURIComponent(item.key || '')}' })" class="minimal-button rounded-lg px-2 py-1 text-[10px]">Pin</button>
                        <button onclick="applyMemoryGovernanceUI('archive_core', { type: '${encodeURIComponent(item.type || '')}', key: '${encodeURIComponent(item.key || '')}' })" class="minimal-button rounded-lg px-2 py-1 text-[10px]">Archive</button>
                        <button onclick="applyMemoryGovernanceUI('forget_core', { type: '${encodeURIComponent(item.type || '')}', key: '${encodeURIComponent(item.key || '')}' })" class="minimal-button rounded-lg px-2 py-1 text-[10px] text-red-600 dark:text-red-300">Forget</button>
                    `),
                    renderGovernanceCard('Semantic Facts', semantic.map(item => ({ ...item, title: item.key, summary: item.value })), item => `
                        <button onclick="applyMemoryGovernanceUI('forget_semantic', { key: '${encodeURIComponent(item.key || '')}' })" class="minimal-button rounded-lg px-2 py-1 text-[10px] text-red-600 dark:text-red-300">Forget</button>
                    `),
                    renderGovernanceCard('Vector Memory', vector.map(item => ({ ...item, title: item.topic })), item => `
                        <button onclick="applyMemoryGovernanceUI('forget_vector', { id: '${encodeURIComponent(item.id || '')}' })" class="minimal-button rounded-lg px-2 py-1 text-[10px] text-red-600 dark:text-red-300">Forget</button>
                    `)
                ].join('');
            } catch (e) {
                results.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

        async function loadBrainDiagnosticsUI() {
            const summary = document.getElementById('brainDiagnosticsSummary');
            const checksEl = document.getElementById('brainDiagnosticsChecks');
            if (!summary && !checksEl) return;
            try {
                const res = await fetch('/ui/brain/diagnostics', { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Diagnostics failed');
                if (summary) {
                    const counts = data.counts || {};
                    summary.textContent = `Status ${data.summary?.overall || 'unknown'} · ${formatExactNumber(counts.semanticFacts || 0)} facts · ${formatExactNumber(counts.vectorEntries || 0)} vectors · ${formatExactNumber(counts.coreCheckpoints || 0)} checkpoints.`;
                }
                if (checksEl) {
                    const checks = Array.isArray(data.checks) ? data.checks : [];
                    checksEl.innerHTML = checks.map(check => {
                        const klass = check.status === 'error'
                            ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                            : check.status === 'warn'
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
                        return `
                            <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                                <div class="flex items-start justify-between gap-3">
                                    <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(check.label || check.id)}</h3>
                                    ${renderTinyBadge(check.status || 'ok', klass)}
                                </div>
                                <p class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">${escapeHtml(check.detail || '')}</p>
                                ${check.action ? `<p class="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-500 dark:bg-slate-950 dark:text-slate-400">${escapeHtml(check.action)}</p>` : ''}
                            </div>
                        `;
                    }).join('');
                }
            } catch (e) {
                if (summary) summary.textContent = 'Diagnostics failed: ' + e.message;
            }
        }

        function renderBrainMetricCard(label, value, detail, tone = 'slate') {
            const toneClass = tone === 'green'
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                : tone === 'amber'
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                    : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
            return `
                <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                    <div class="flex items-start justify-between gap-3">
                        <p class="text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">${escMemHtml(label)}</p>
                        ${renderTinyBadge(value, toneClass)}
                    </div>
                    <p class="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">${escMemHtml(detail || '')}</p>
                </div>
            `;
        }

        async function loadBrainPolicyUI() {
            const summary = document.getElementById('brainPolicySummary');
            const cards = document.getElementById('brainPolicyCards');
            const jsonEl = document.getElementById('brainPolicyJson');
            if (!summary && !cards && !jsonEl) return;
            try {
                const res = await fetch('/ui/brain/policy', { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Brain policy failed');
                const cfg = data.config || {};
                const counts = data.counts || {};
                if (summary) {
                    summary.textContent = `Mode ${data.samplePolicy?.executionPolicy?.mode || 'normal'} · max loops ${cfg.maxWorkbenchToolLoops || 12} · max agent depth ${cfg.maxAgentDepth || 2}.`;
                }
                if (cards) {
                    cards.innerHTML = [
                        renderBrainMetricCard('Orchestrator', cfg.enabled === false ? 'off' : 'on', `Adaptive policy ${cfg.adaptivePolicy === false ? 'disabled' : 'enabled'}.`, cfg.enabled === false ? 'amber' : 'green'),
                        renderBrainMetricCard('Parallel reads', cfg.parallelReadTools === false ? 'off' : 'on', `Adapter parallel tools ${cfg.adapterParallelTools === false ? 'disabled' : 'enabled'}.`, cfg.parallelReadTools === false ? 'amber' : 'green'),
                        renderBrainMetricCard('Graph', `${counts.graph?.entities || 0} entities`, `${counts.graph?.relations || 0} relations, ${counts.graph?.observations || 0} observations.`, (counts.graph?.entities || 0) > 0 ? 'green' : 'amber'),
                        renderBrainMetricCard('Learning', `${counts.failures || 0} failures`, `${counts.pendingGuidelines || 0} pending guidelines, ${counts.activeGuidelines || 0} active.`, counts.pendingGuidelines > 0 ? 'amber' : 'green'),
                        renderBrainMetricCard('Agent jobs', `${counts.agentJobs || 0}`, `Durable job ledger is ${cfg.agentJobs === false ? 'disabled' : 'enabled'}.`, cfg.agentJobs === false ? 'amber' : 'green')
                    ].join('');
                }
                if (jsonEl) jsonEl.textContent = JSON.stringify(data.samplePolicy || {}, null, 2);
            } catch (e) {
                if (summary) summary.textContent = 'Policy failed: ' + e.message;
            }
        }

        async function loadToolFailuresUI() {
            const list = document.getElementById('toolFailureList');
            const summary = document.getElementById('toolFailureSummary');
            if (!list) return;
            try {
                const res = await fetch('/ui/brain/failures?limit=80', { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failure memory failed');
                const failures = Array.isArray(data.failures) ? data.failures : [];
                if (summary) summary.textContent = `${failures.length} known tool failure correction${failures.length === 1 ? '' : 's'}.`;
                if (!failures.length) {
                    list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No learned tool failures yet.</div>';
                    return;
                }
                list.innerHTML = failures.map(f => `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex flex-wrap items-center gap-2">
                            <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escMemHtml(f.tool || 'unknown')}</h3>
                            ${renderTinyBadge(`x${f.count || 1}`, 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300')}
                            ${renderTinyBadge(f.status || 'active', 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300')}
                        </div>
                        <p class="mt-2 text-xs text-slate-500 dark:text-slate-400">${escMemHtml(f.errorPattern || '')}</p>
                        ${f.successfulFix ? `<p class="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-600 dark:bg-slate-950 dark:text-slate-300">${escMemHtml(f.successfulFix)}</p>` : ''}
                        <p class="mt-2 text-[10px] text-slate-400">last seen ${f.lastSeen ? new Date(f.lastSeen).toLocaleString() : 'unknown'}</p>
                    </div>
                `).join('');
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escMemHtml(e.message)}</div>`;
            }
        }

        async function loadGuidelineReviewUI(status = window.currentGuidelineStatus || 'pending') {
            window.currentGuidelineStatus = status;
            const list = document.getElementById('guidelineReviewList');
            const summary = document.getElementById('guidelineReviewSummary');
            if (!list) return;
            try {
                const res = await fetch('/ui/brain/guidelines?status=' + encodeURIComponent(status), { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Guideline review failed');
                const guidelines = Array.isArray(data.guidelines) ? data.guidelines : [];
                if (summary) summary.textContent = `${guidelines.length} ${status} guideline${guidelines.length === 1 ? '' : 's'}.`;
                if (!guidelines.length) {
                    list.innerHTML = `<div class="text-sm text-slate-400 dark:text-slate-500 italic">No ${escMemHtml(status)} learned guidelines.</div>`;
                    return;
                }
                list.innerHTML = guidelines.map(g => `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex flex-wrap items-center justify-between gap-3">
                            <div class="flex flex-wrap items-center gap-2">
                                <span class="text-xs font-mono text-slate-400">${escMemHtml(g.id || '')}</span>
                                ${renderTinyBadge(g.status || 'pending', g.status === 'active' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300')}
                                ${renderTinyBadge(`x${g.count || 1}`, 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300')}
                            </div>
                            <div class="flex items-center gap-2">
                                <button onclick="setGuidelineStatusUI('${escMemHtml(g.id)}','active')" class="minimal-button rounded-lg px-2 py-1 text-[10px]">Approve</button>
                                <button onclick="setGuidelineStatusUI('${escMemHtml(g.id)}','rejected')" class="minimal-button rounded-lg px-2 py-1 text-[10px]">Reject</button>
                                <button onclick="setGuidelineStatusUI('${escMemHtml(g.id)}','archived')" class="minimal-button rounded-lg px-2 py-1 text-[10px]">Archive</button>
                            </div>
                        </div>
                        <p class="mt-3 text-xs leading-5 text-slate-600 dark:text-slate-300">${escMemHtml(g.text || '')}</p>
                        <p class="mt-2 text-[10px] text-slate-400">${escMemHtml(g.source || 'unknown')} · confidence ${g.confidence ?? 'n/a'}</p>
                    </div>
                `).join('');
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escMemHtml(e.message)}</div>`;
            }
        }

        async function setGuidelineStatusUI(id, status) {
            try {
                const res = await fetch('/ui/brain/guidelines/status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, status, nextListStatus: window.currentGuidelineStatus || 'pending' })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Guideline update failed');
                await loadGuidelineReviewUI(window.currentGuidelineStatus || 'pending');
            } catch (e) {
                const summary = document.getElementById('guidelineReviewSummary');
                if (summary) summary.textContent = e.message;
            }
        }

        function renderGraphSection(title, items, renderer) {
            if (!items || !items.length) return '';
            return `
                <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                    <h3 class="text-xs font-bold uppercase text-slate-500 dark:text-slate-400">${escMemHtml(title)}</h3>
                    <div class="mt-3 grid gap-2">${items.map(renderer).join('')}</div>
                </div>
            `;
        }

        async function loadLocalGraphUI() {
            const query = document.getElementById('localGraphQuery')?.value?.trim() || '';
            const summary = document.getElementById('localGraphSummary');
            const resultsEl = document.getElementById('localGraphResults');
            if (!resultsEl) return;
            try {
                const res = await fetch('/ui/brain/graph?q=' + encodeURIComponent(query), { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Graph memory failed');
                const stats = data.stats || {};
                const counts = stats.counts || {};
                const results = data.results || {};
                if (summary) summary.textContent = `${counts.entities || 0} entities · ${counts.relations || 0} relations · ${counts.observations || 0} observations.`;
                const sections = [
                    renderGraphSection('Entities', results.entities || [], e => `
                        <div class="rounded-xl bg-slate-50 px-3 py-2 text-xs dark:bg-slate-950">
                            <div class="flex items-center justify-between gap-2">
                                <span class="font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(e.name || e.id)}</span>
                                ${renderTinyBadge(e.type || 'concept', 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300')}
                            </div>
                            <p class="mt-1 text-[10px] text-slate-400">${escMemHtml(e.id || '')}</p>
                        </div>
                    `),
                    renderGraphSection('Relations', results.relations || [], r => `
                        <div class="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                            ${escMemHtml(r.fromName || r.from)} --${escMemHtml(r.type || 'related_to')}--&gt; ${escMemHtml(r.toName || r.to)}
                        </div>
                    `),
                    renderGraphSection('Observations', results.observations || [], o => `
                        <div class="rounded-xl bg-slate-50 px-3 py-2 text-xs dark:bg-slate-950">
                            <p class="font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(o.entityName || o.entityId)}</p>
                            <p class="mt-1 text-slate-500 dark:text-slate-400">${escMemHtml(o.text || '')}</p>
                        </div>
                    `)
                ].filter(Boolean);
                resultsEl.innerHTML = sections.length ? sections.join('') : '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No graph matches yet.</div>';
            } catch (e) {
                resultsEl.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escMemHtml(e.message)}</div>`;
            }
        }

        async function indexLocalGraphUI() {
            const summary = document.getElementById('localGraphSummary');
            if (summary) summary.textContent = 'Indexing memory into graph...';
            try {
                const res = await fetch('/ui/brain/graph/index', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Graph indexing failed');
                if (summary) summary.textContent = `Indexed: ${data.results?.projects || 0} projects, ${data.results?.semanticFacts || 0} facts, ${data.results?.checkpoints || 0} checkpoints.`;
                await loadLocalGraphUI();
            } catch (e) {
                if (summary) summary.textContent = e.message;
            }
        }

        async function loadAgentJobsUI() {
            const summary = document.getElementById('agentJobsSummary');
            const list = document.getElementById('agentJobsList');
            if (!list) return;
            try {
                const res = await fetch('/ui/agent-jobs?limit=50', { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Agent jobs failed');
                const jobs = Array.isArray(data.jobs) ? data.jobs : [];
                if (summary) summary.textContent = `${data.count || jobs.length} durable sub-agent job${(data.count || jobs.length) === 1 ? '' : 's'}.`;
                if (!jobs.length) {
                    list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No sub-agent jobs recorded yet.</div>';
                    return;
                }
                list.innerHTML = jobs.map(job => `
                    <details class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                        <summary class="cursor-pointer list-none">
                            <div class="flex flex-wrap items-start justify-between gap-3">
                                <div class="min-w-0 flex-1">
                                    <div class="flex flex-wrap items-center gap-2">
                                        <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escMemHtml(job.agentId || 'agent')}</h3>
                                        ${renderTinyBadge(job.status || 'running', job.status === 'completed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : job.status === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300')}
                                        ${renderTinyBadge(`depth ${job.depth || 0}`, 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300')}
                                    </div>
                                    <p class="mt-2 text-xs text-slate-600 dark:text-slate-300">${escMemHtml(job.task || '')}</p>
                                </div>
                                <span class="text-[10px] text-slate-400">${job.updatedAt ? new Date(job.updatedAt).toLocaleString() : ''}</span>
                            </div>
                        </summary>
                        <div class="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
                            ${job.result ? `<p class="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-950 dark:text-slate-300">${escMemHtml(job.result)}</p>` : ''}
                            ${job.error ? `<p class="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">${escMemHtml(job.error)}</p>` : ''}
                            <div class="mt-3 grid gap-2">
                                ${(job.events || []).slice(-8).map(ev => `
                                    <div class="rounded-xl bg-slate-50 px-3 py-2 text-[11px] dark:bg-slate-950">
                                        <div class="flex items-center justify-between gap-2">
                                            <span class="font-semibold text-slate-600 dark:text-slate-300">${escMemHtml(ev.title || ev.type || 'event')}</span>
                                            <span class="text-slate-400">${ev.at ? new Date(ev.at).toLocaleTimeString() : ''}</span>
                                        </div>
                                        <p class="mt-1 text-slate-500 dark:text-slate-400">${escMemHtml(ev.content || '').slice(0, 700)}</p>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    </details>
                `).join('');
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escMemHtml(e.message)}</div>`;
            }
        }

/* ── Vector Memory ── */
        async function loadVectorMemoryUI() {
            const list = document.getElementById('vectorMemoryList');
            const count = document.getElementById('vectorCount');
            if (!list) return;
            try {
                const res = await fetch('/ui/memory/vector', { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) throw new Error('HTTP ' + res.status);
                if (count) count.textContent = data.count || 0;
                if (!data.count || data.count === 0) {
                    list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No vector entries yet. Auto-memory extraction will populate this as you use the assistant.</div>';
                    return;
                }
                list.innerHTML = data.entries.map(e => `
                    <div class="vector-entry rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 p-3">
                        <div class="flex items-center justify-between">
                            <span class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escMemHtml(e.topic)}</span>
                            <span class="text-[10px] text-slate-400">${new Date(e.timestamp).toLocaleDateString()}</span>
                        </div>
                        <p class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">${escMemHtml(e.summary)}</p>
                    </div>
                `).join('');
            } catch (e) {
                list.innerHTML = `<div class="text-xs text-red-500">${escMemHtml(e.message)}</div>`;
            }
        }

        function filterVectorMemory(value) {
            const q = String(value || '').toLowerCase();
            document.querySelectorAll('.vector-entry').forEach(el => {
                el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none';
            });
        }

        async function loadSpecialistUI() {
            const list = document.getElementById('specialistList');
            if (!list) return;
            try {
                const res = await fetch('/ui/config/safe', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const cfg = await res.json();
                const eps = cfg.specialistEndpoints || {};
                if (Object.keys(eps).length === 0) {
                    list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No specialist endpoints configured. Add specialistEndpoints to config.json.</div>';
                    return;
                }
                list.innerHTML = Object.entries(eps).map(([name, ep]) => `
                    <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                        <div class="flex items-center gap-2 mb-2">
                            ${renderTinyBadge(name, 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300')}
                        </div>
                        <p class="mt-2 text-[11px] text-slate-600 dark:text-slate-300 font-mono break-all">${escapeHtml(ep.url || 'N/A')}</p>
                        <p class="mt-1 text-[10px] text-slate-400 dark:text-slate-500">model: ${escapeHtml(ep.model || 'MiniMax-M2.7')} &middot; max_tokens: ${ep.maxTokens || 4096} &middot; timeout: ${(ep.timeoutMs || 60000) / 1000}s</p>
                    </div>
                `).join('');
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

/* ── URL MCP ── */
        async function saveUrlMcpUI() {
            const name = document.getElementById('urlMcpName')?.value?.trim();
            const url = document.getElementById('urlMcpUrl')?.value?.trim();
            const enabled = document.getElementById('urlMcpEnabled')?.checked !== false;
            const headersRaw = document.getElementById('urlMcpHeaders')?.value?.trim();
            const status = document.getElementById('urlMcpStatus');
            if (!name) { status.textContent = 'Name is required'; return; }
            if (!url) { status.textContent = 'URL is required'; return; }

            let headers = {};
            if (headersRaw) {
                try { headers = JSON.parse(headersRaw); } catch (e) { status.textContent = 'Invalid JSON in headers'; return; }
            }

            try {
                const res = await fetch('/ui/mcp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, url, enabled, headers, source: 'custom' })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to save');
                status.textContent = 'Saved! Restart MCP servers to apply.';
                status.className = 'text-[10px] text-emerald-600';
                loadUrlMcpUI();
            } catch (e) {
                status.textContent = e.message;
                status.className = 'text-[10px] text-red-600';
            }
        }

        async function loadUrlMcpUI() {
            const list = document.getElementById('urlMcpList');
            if (!list) return;
            try {
                const res = await fetch('/ui/mcp', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                const servers = Array.isArray(data.servers) ? data.servers : [];
                const urlServers = servers.filter(s => s.url);
                if (urlServers.length === 0) {
                    list.innerHTML = '<div class="text-sm text-slate-400 dark:text-slate-500 italic">No URL-based MCP servers configured. Add one using the form.</div>';
                    return;
                }
                const statusMap = new Map((Array.isArray(data.status) ? data.status : []).map(s => [s.name, s]));
                list.innerHTML = urlServers.map(s => {
                    const st = statusMap.get(s.name) || {};
                    const isRunning = st.status === 'running';
                    return `
                        <div class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                            <div class="flex items-start justify-between gap-3">
                                <div class="min-w-0 flex-1">
                                    <div class="flex flex-wrap items-center gap-2">
                                        <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(s.name)}</h3>
                                        ${renderTinyBadge(isRunning ? 'running' : st.status || 'unknown', isRunning ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}
                                        ${s.enabled === false ? renderTinyBadge('disabled', 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400') : ''}
                                    </div>
                                    <p class="mt-2 text-xs text-slate-600 dark:text-slate-300 font-mono break-all">${escapeHtml(s.url)}</p>
                                    <p class="mt-1 text-[10px] text-slate-400 dark:text-slate-500">${s.toolCount || 0} tools</p>
                                </div>
                                <button onclick="deleteMcpServerUI('${escapeHtml(s.name)}')" class="minimal-button shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-300">Delete</button>
                            </div>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                list.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">${escapeHtml(e.message)}</div>`;
            }
        }

/* ── Supermemory ── */
        async function saveSupermemoryConfigUI() {
            const apiKey = document.getElementById('supermemoryApiKey')?.value?.trim();
            const url = document.getElementById('supermemoryUrl')?.value?.trim();
            const status = document.getElementById('supermemoryStatus');
            try {
                const payload = {};
                if (apiKey) payload.supermemoryApiKey = apiKey;
                if (url) payload.supermemoryUrl = url;
                const res = await fetch('/ui/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                status.textContent = 'Saved';
                status.className = 'text-[10px] text-emerald-600';
            } catch (e) {
                status.textContent = e.message;
                status.className = 'text-[10px] text-red-600';
            }
        }

        async function testSupermemoryUI() {
            const query = document.getElementById('supermemoryTestQuery')?.value?.trim();
            const result = document.getElementById('supermemoryTestResult');
            if (!query) { result.textContent = 'Enter a search query'; return; }
            result.textContent = 'Searching...';
            try {
                const searchRes = await fetch('/ui/supermemory/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query }),
                    signal: AbortSignal.timeout(20000)
                });
                if (!searchRes.ok) {
                    result.textContent = 'HTTP ' + searchRes.status + ': ' + (await searchRes.text()).slice(0, 200);
                    return;
                }
                const data = await searchRes.json();
                if (data.configured === false) {
                    result.textContent = data.error || 'Supermemory is not configured';
                    return;
                }
                const items = data.results || [];
                if (items.length === 0) { result.textContent = 'No results'; return; }
                result.textContent = items.slice(0, 5).map((r, i) =>
                    `[${i + 1}] ${r.text?.slice(0, 180) || '(untitled)'}${r.similarity ? `\nscore: ${Math.round(r.similarity * 100)}%` : ''}`
                ).join('\n---\n');
            } catch (e) {
                result.textContent = e.message;
            }
        }

        function decodeGovernancePayload(payload) {
            if (!payload || typeof payload !== 'object') return {};
            const decoded = {};
            for (const [key, value] of Object.entries(payload)) {
                decoded[key] = typeof value === 'string' ? decodeURIComponent(value) : value;
            }
            return decoded;
        }

        async function applyMemoryGovernanceUI(action, target) {
            try {
                const body = target && typeof target === 'object'
                    ? { action, ...decodeGovernancePayload(target) }
                    : action === 'forget_vector'
                        ? { action, id: target }
                        : { action };
                const res = await fetch('/ui/memory/governance', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Memory governance failed');
                await Promise.all([loadMemoryItemsUI(), searchMemoryUI(), searchMemoryGovernanceUI(), loadMemoryPreview()]);
                showStatus('Memory governance updated', 'bg-emerald-600 text-white');
            } catch (e) {
                showStatus(e.message, 'bg-red-600 text-white');
            }
        }


