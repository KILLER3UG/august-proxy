import { Outlet } from 'react-router-dom';
import { useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { Titlebar } from './Titlebar';
import { Statusbar } from './Statusbar';
import { CommandPalette } from '@/components/overlays/CommandPalette';
import { ProxyStatusOverlay } from '@/components/overlays/ProxyStatusOverlay';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { toggleCommandPalette } from '@/store/command-palette';

export function AppShell() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'p')) {
        e.preventDefault();
        toggleCommandPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <Titlebar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      <Statusbar />
      <CommandPalette />
      <ProxyStatusOverlay />
    </div>
  );
}
