import { useStore } from '@nanostores/react';
import { NavLink } from 'react-router-dom';
import { SECTION_NAV_ITEMS } from '@/routes';
import { cn } from '@/lib/utils';
import { $gateway } from '@/store/gateway';
import type { StatusTone } from '@/components/StatusDot';

export function Sidebar() {
  const g = useStore($gateway);
  const gatewayTone: StatusTone = g.status === 'open' ? 'good' : g.status === 'connecting' ? 'muted' : 'bad';

  return (
    <aside className="w-60 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground flex flex-col">
      <div className="px-4 py-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5">
          <span className="size-7 rounded-md bg-primary text-primary-foreground grid place-items-center text-[12px] font-bold">CP</span>
          <div className="leading-tight">
            <h1 className="text-base font-bold">August Proxy</h1>
            <p className="text-[12px] text-muted-foreground">Local gateway</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className={cn(
            'inline-block size-1.5 rounded-full',
            gatewayTone === 'good'  && 'bg-primary',
            gatewayTone === 'muted' && 'bg-muted-foreground/40',
            gatewayTone === 'bad'   && 'bg-destructive',
          )} />
          <span className="font-mono">
            {g.status === 'open' ? `running :${g.port || '?'}` : g.status}
          </span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        <ul className="flex flex-col gap-0.5">
          {SECTION_NAV_ITEMS.map(({ to, label, Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === '/'}
                className={({ isActive }) => cn(
                  'group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                )}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="px-4 py-3 border-t border-sidebar-border text-[12px] text-muted-foreground font-mono">
        v2.0.0 · port 8085
      </div>
    </aside>
  );
}
