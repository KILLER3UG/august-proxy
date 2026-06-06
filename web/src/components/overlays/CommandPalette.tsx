import { useStore } from '@nanostores/react';
import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Command } from 'cmdk';
import {
  Plus, RefreshCw, Sun, Moon, Settings, MessageSquare, Activity, FileSearch, Brain,
  Database, Server, Sparkles, Copy, BarChart3,
} from 'lucide-react';
import { $commandPaletteOpen, closeCommandPalette } from '@/store/command-palette';
import { $theme, toggleTheme } from '@/store/theme';
import { NAV_ITEMS } from '@/routes';
import { Backdrop } from './Backdrop';
import { useQueryClient } from '@tanstack/react-query';

export function CommandPalette() {
  const open = useStore($commandPaletteOpen);
  const theme = useStore($theme);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const location = useLocation();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeCommandPalette(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  const isDark = theme === 'dark';
  const run = (fn: () => void) => () => { fn(); closeCommandPalette(); };

  return (
    <Backdrop onClose={closeCommandPalette} className="items-start pt-[15vh]">
      <Command
        className="w-[min(90vw,600px)] rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        label="Command palette"
      >
        <Command.Input
          autoFocus
          placeholder="Type a command, search sessions, or jump to a section…"
          className="w-full bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground border-b border-border"
        />
        <Command.List className="max-h-[55vh] overflow-y-auto p-2">
          <Command.Empty className="py-6 text-center text-xs text-muted-foreground">No results found.</Command.Empty>

          <Command.Group heading="Actions" className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Command.Item value="action new chat" onSelect={run(() => navigate('/'))}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent">
              <Plus className="size-3.5" /> New chat
            </Command.Item>
            <Command.Item value="action open settings" onSelect={run(() => navigate('/settings'))}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent">
              <Settings className="size-3.5" /> Settings…
            </Command.Item>
            <Command.Item value="action refresh all data" onSelect={run(() => qc.invalidateQueries())}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent">
              <RefreshCw className="size-3.5" /> Refresh all data
            </Command.Item>
            <Command.Item value="action toggle theme" onSelect={run(toggleTheme)}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent">
              {isDark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />} Toggle theme
            </Command.Item>
            <Command.Item value="action copy current path" onSelect={run(() => void navigator.clipboard?.writeText(location.pathname))}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent">
              <Copy className="size-3.5" /> Copy current path
            </Command.Item>
          </Command.Group>

          <Command.Separator className="my-2 border-t border-border" />

          <Command.Group heading="Settings tabs" className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {[
              { key: 'health',    label: 'Health',         Icon: Activity },
              { key: 'providers', label: 'Providers',      Icon: Server },
              { key: 'services',  label: 'Services',       Icon: MessageSquare },
              { key: 'mcp',       label: 'MCP & Skills',   Icon: Database },
              { key: 'memory',    label: 'Memory',         Icon: Brain },
            ].map(({ key, label, Icon }) => (
              <Command.Item key={key} value={`settings ${label}`} onSelect={run(() => navigate(`/settings/${key}`))}
                className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent">
                <Icon className="size-3.5" /> {label}
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Separator className="my-2 border-t border-border" />

          <Command.Group heading="Tools" className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {[
              { path: '/dashboard',     label: 'Dashboard',     Icon: BarChart3 },
              { path: '/traffic',       label: 'Traffic',       Icon: Activity },
              { path: '/conversations', label: 'Conversations', Icon: MessageSquare },
              { path: '/inspector',     label: 'Inspector',     Icon: FileSearch },
              { path: '/thinking',      label: 'Thinking',      Icon: Sparkles },
              { path: '/workbench',     label: 'Workbench',     Icon: Brain },
            ].map(({ path, label, Icon }) => (
              <Command.Item key={path} value={`tool ${label}`} onSelect={run(() => navigate(path))}
                className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent">
                <Icon className="size-3.5" /> {label}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>

        <div className="border-t border-border px-3 py-2 flex items-center gap-3 text-[10px] text-muted-foreground font-mono">
          <span><kbd className="rounded border border-border bg-muted px-1">↑↓</kbd> navigate</span>
          <span><kbd className="rounded border border-border bg-muted px-1">↵</kbd> select</span>
          <span><kbd className="rounded border border-border bg-muted px-1">esc</kbd> close</span>
          <span className="ml-auto"><kbd className="rounded border border-border bg-muted px-1">,</kbd> settings</span>
        </div>
      </Command>
    </Backdrop>
  );
}
