/* ── App entry ─────────────────────────────────────────────────────── */
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { hydrateTheme } from './lib/theme';
import { queryClient } from './query-client';
import { startRealtimeBridge } from './realtime/bridge';
import App from './App';
import './styles.css';

// Apply persisted theme + text-size synchronously before React mounts
// to prevent FOUC where the wrong theme flashes on first paint.
// hydrateTheme also wires the OS-preference listener so 'system' mode
// follows live OS flips.
hydrateTheme();

// Instant backend→frontend push (sessions, chat active, plans, catalog, …)
startRealtimeBridge();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster position="bottom-right" theme="dark" />
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
