/* ── App entry (Phase 1.6) ─────────────────────────────────────────── */
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { hydrateTheme } from './lib/theme';
import App from './App';
import './styles.css';

// Apply persisted theme + text-size synchronously before React mounts
// to prevent FOUC where the wrong theme flashes on first paint.
// hydrateTheme also wires the OS-preference listener so 'system' mode
// follows live OS flips.
hydrateTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

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
