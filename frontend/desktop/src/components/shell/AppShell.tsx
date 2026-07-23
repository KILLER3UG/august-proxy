import { Outlet, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { Titlebar } from './Titlebar';
import { Statusbar } from './Statusbar';
import { CommandPalette } from '@/components/overlays/CommandPalette';
import { ShortcutsModal } from '@/components/overlays/ShortcutsModal';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { toggleCommandPalette } from '@/store/command-palette';
import { toggleShortcutsModal } from '@/store/shortcuts-modal';

/** True when keystrokes belong to a text-editing surface (skip global hotkeys). */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

export function AppShell() {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'p')) {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }
      if (cmd || e.altKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;
      // `?` — shortcuts reference; `,` — settings (advertised in the palette footer).
      if (e.key === '?') {
        e.preventDefault();
        toggleShortcutsModal();
      } else if (e.key === ',') {
        e.preventDefault();
        void navigate('/settings');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden bg-background text-foreground">
      <Titlebar />
      <div className="flex flex-1 min-h-0">
        <main className="flex-1 overflow-auto">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      <Statusbar />
      <CommandPalette />
      <ShortcutsModal />
      {/* Proxy overlay lives in App via BackendBootstrapGate — AppShell is unused. */}
    </div>
  );
}
