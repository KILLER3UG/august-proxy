/* ── Settings overlay — replaces the old 12-section dashboard ─────── */
/* Pressed via Cmd+, or the Settings button in the titlebar.            */

import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { X, Heart, Link2, Users, Database, Plug, Bot } from 'lucide-react';
import { Backdrop } from '@/components/overlays/Backdrop';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useStore } from '@nanostores/react';
import { $gateway } from '@/store/gateway';
import { Health } from '@/sections/health/Health';
import { Providers } from '@/sections/providers/Providers';
import { Services } from '@/sections/services/Services';
import { Mcp } from '@/sections/mcp/Mcp';
import { Memory } from '@/sections/memory/Memory';
import { August } from '@/sections/august/August';

interface TabItem {
  key: string;
  label: string;
  Icon: any;
  Component: React.ComponentType<any>;
  advanced?: boolean;
}

const TABS: TabItem[] = [
  { key: 'health',    label: 'Health',      Icon: Heart,     Component: Health },
  { key: 'providers', label: 'Providers',   Icon: Users,     Component: Providers },
  { key: 'services',  label: 'Services',    Icon: Link2,     Component: Services },
  { key: 'mcp',       label: 'MCP & Skills',Icon: Plug,      Component: Mcp },
  { key: 'memory',    label: 'Memory',      Icon: Database,  Component: Memory },
  { key: 'advanced',  label: 'August console', Icon: Bot,    Component: August, advanced: true },
];

export function SettingsOverlay() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const tab = params.get('tab') ?? 'health';
  const g = useStore($gateway);

  const close = () => {
    const preSettingsPath = sessionStorage.getItem('pre-settings-path') || '/';
    navigate(preSettingsPath);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const active = TABS.find((t) => t.key === tab) ?? TABS[0];

  return (
    <Backdrop onClose={close}>
      <div className="w-[min(95vw,1100px)] h-[min(90vh,720px)] rounded-xl border border-border bg-card shadow-2xl flex overflow-hidden">
        <aside className="w-56 border-r border-border bg-sidebar text-sidebar-foreground p-3 flex flex-col">
          <div className="px-2 py-2 mb-2">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <span className="size-6 rounded-md bg-primary text-primary-foreground grid place-items-center text-[10px]">A</span>
              Settings
            </h2>
            <p className="text-[10px] text-muted-foreground mt-1 font-mono">
              {g.status === 'open' ? `running :${g.port || '?'}` : g.status}
            </p>
          </div>
          <nav className="flex-1 space-y-0.5">
            {TABS.filter((t) => !t.advanced || g.status === 'open').map((t) => (
              <button
                key={t.key}
                onClick={() => setParams({ tab: t.key })}
                className={cn(
                  'w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition',
                  tab === t.key ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50',
                )}
              >
                <t.Icon className="size-3.5" />
                {t.label}
              </button>
            ))}
          </nav>
          <div className="pt-2 border-t border-sidebar-border text-[10px] text-muted-foreground font-mono">
            <kbd className="rounded border border-sidebar-border bg-muted px-1">esc</kbd> to close
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-12 border-b border-border px-4 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <active.Icon className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{active.label}</h3>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close settings">
              <X />
            </Button>
          </header>
          <div className="flex-1 overflow-auto">
            <active.Component />
          </div>
        </div>
      </div>
    </Backdrop>
  );
}
