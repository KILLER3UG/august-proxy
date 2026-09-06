/* ── App entry ─────────────────────────────────────────────────────── */
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { hydrateTheme } from './lib/theme';
import { hydrateUiCustomization } from './lib/ui-customization';
import { applyStoredPreferences } from './lib/preferences';
import { queryClient } from './query-client';
import { startRealtimeBridge } from './realtime/bridge';
import { ErrorBoundary } from './components/ErrorBoundary';
import { toast } from 'sonner';
import App from './App';
import './styles.css';

// The desktop webview has no console, so surface uncaught errors / rejected
// promises on screen too — the ErrorBoundary only catches render throws.
{
  let lastShown = '';
  const show = (msg: string) => {
    if (!msg || msg === lastShown) return;
    lastShown = msg;
    toast.error(`Unexpected error: ${msg.slice(0, 200)}`, { duration: 8000 });
  };
  window.addEventListener('error', (e) => show(e.message || e.error?.message || ''));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    show(typeof r === 'string' ? r : r instanceof Error ? r.message : String(r ?? ''));
  });
}

// Apply persisted theme + text-size synchronously before React mounts
// to prevent FOUC where the wrong theme flashes on first paint.
// hydrateTheme also wires the OS-preference listener so 'system' mode
// follows live OS flips.
hydrateTheme();
// Restore user color overrides (UI Designer) after base theme classes land.
hydrateUiCustomization();
// Restore chat-font / reduce-motion data attributes (General → Preferences).
applyStoredPreferences();

// Instant backend→frontend push (sessions, chat active, plans, catalog, …)
startRealtimeBridge();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* Last line of defense: a render throw anywhere shows a recoverable
            error card with the message instead of a black webview. */}
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
        <Toaster position="bottom-right" theme="system" richColors />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);

// Defer non-critical cold-start work until after first paint / idle.
// KaTeX CSS is only needed when math renders; voice builtins register
// command handlers that chat can live without for the first frame.
function deferNonCritical() {
  void import('katex/dist/katex.min.css');
  void import('./api/voice/builtins');
}

if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
  window.requestIdleCallback(() => deferNonCritical(), { timeout: 2000 });
} else {
  setTimeout(deferNonCritical, 0);
}
