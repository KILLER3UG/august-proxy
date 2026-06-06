// ── Init ── (every step wrapped so one failure never blocks another)
console.log('[Init] Starting...');
try { initDarkMode(); console.log('[Init] ✓ darkMode'); } catch(e) { console.error('[Init] ✗ darkMode:', e); }
try { initSidebar(); console.log('[Init] ✓ sidebar'); } catch(e) { console.error('[Init] ✗ sidebar:', e); }
try { switchSection(activeSection); console.log('[Init] ✓ switchSection:', activeSection); } catch(e) { console.error('[Init] ✗ switchSection:', e); }
try { ['customBaseUrl'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', syncSummaryFromUI); }); console.log('[Init] ✓ listeners'); } catch(e) { console.error('[Init] ✗ listeners:', e); }

// ── Real-time SSE ──
try { connectSSE(); console.log('[Init] ✓ SSE'); } catch(e) { console.error('[Init] ✗ SSE:', e); }
try { fetch('/ui/config').then(r=>r.json()).then(cfg=>{applyConfigToUI(cfg);console.log('[Init] ✓ config applied')}).catch(e=>console.error('[Init] ✗ config:',e)); } catch(e) { console.error('[Init] ✗ config dispatch:', e); }
try { loadRequests().then(()=>console.log('[Init] ✓ requests')).catch(e=>console.error('[Init] ✗ requests:',e)); } catch(e) { console.error('[Init] ✗ requests dispatch:', e); }
try { loadActivity().then(()=>console.log('[Init] ✓ activity')).catch(e=>console.error('[Init] ✗ activity:',e)); } catch(e) { console.error('[Init] ✗ activity dispatch:', e); }
try { loadInspector().then(()=>console.log('[Init] ✓ inspector')).catch(e=>console.error('[Init] ✗ inspector:',e)); } catch(e) { console.error('[Init] ✗ inspector dispatch:', e); }
try { if (sectionVisible('thinking')) loadThinking().then(()=>console.log('[Init] ✓ thinking')).catch(e=>console.error('[Init] ✗ thinking:',e)); } catch(e) { console.error('[Init] ✗ thinking dispatch:', e); }
try { if (sectionVisible('conversations')) loadConversations().then(()=>console.log('[Init] ✓ conversations')).catch(e=>console.error('[Init] ✗ conversations:',e)); } catch(e) { console.error('[Init] ✗ conversations dispatch:', e); }
try { if (sectionVisible('profiles')) { if (typeof loadProviderList === 'function') { loadProviderList(); } else { console.error('[Init] ✗ loadProviderList is not defined — check that profiles.js loaded correctly'); } loadProxyAIDiagnostics(); console.log('[Init] ✓ providers'); } } catch(e) { console.error('[Init] ✗ providers:', e); }
try { loadModels().then(()=>console.log('[Init] ✓ models')).catch(e=>console.error('[Init] ✗ models:',e)); } catch(e) { console.error('[Init] ✗ models dispatch:', e); }
try { if (sectionVisible('memory')) loadMemoryUI().then(()=>console.log('[Init] ✓ memory')).catch(e=>console.warn('[Init] ✗ memory:',e)); } catch(e) { console.warn('[Init] memory dispatch:', e); }

try {
    pollHandles = [ setInterval(() => {
        if (sectionVisible('inspector')) loadInspector();
        if (sectionVisible('thinking')) loadThinking();
        if (sectionVisible('conversations')) loadConversations();
        if (sectionVisible('memory')) loadMemoryUI();
        if (sectionVisible('august')) loadAugustUI();
        if (sectionVisible('profiles')) { if (typeof loadProviderList === 'function') loadProviderList(); loadProxyAIDiagnostics(); }
    }, 5000) ];
    console.log('[Init] ✓ poll');
} catch(e) { console.error('[Init] ✗ poll:', e); }
console.log('[Init] All dispatched');
