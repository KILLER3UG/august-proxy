import { useStore } from '@nanostores/react';
import { $gateway } from '@/store/gateway';
import { StatusPill } from '@/components/StatusPill';
import { Separator } from '@/components/ui/separator';
import type { StatusTone } from '@/components/StatusDot';

export function Statusbar() {
  const g = useStore($gateway);
  const tone: StatusTone = g.status === 'open' ? 'good' : g.status === 'connecting' ? 'muted' : 'bad';
  const label = g.status === 'open' ? `running :${g.port || '?'}` : g.status;

  return (
    <footer className="h-7 flex items-center gap-3 border-t border-border bg-background/80 px-3 text-[11px] text-muted-foreground shrink-0">
      <StatusPill tone={tone} label={label} />
      <Separator orientation="vertical" className="h-3" />
      <span className="font-mono">v2.0.0</span>
      <span className="ml-auto font-mono">
        {g.status === 'open' && g.uptime > 0 ? `uptime ${formatUptime(g.uptime)}` : 'localhost'}
      </span>
    </footer>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
