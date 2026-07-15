/* ── WorkspaceStatCard — stat tile for the workspace data sections ──── */
/* Card with icon, label, value, optional sub-line, and accent colors. */

import { type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type WorkspaceAccent = 'default' | 'emerald' | 'amber' | 'blue';

const ACCENT_CLASSES: Record<WorkspaceAccent, string> = {
  default: 'text-foreground',
  emerald: 'text-success',
  amber: 'text-warning',
  blue: 'text-info',
};

interface Props {
  icon?: LucideIcon;
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  accent?: WorkspaceAccent;
  className?: string;
}

export function WorkspaceStatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent = 'default',
  className,
}: Props) {
  return (
    <div
      className={cn(
        'rounded-xl border border-white/[0.06] bg-card/60 p-4 flex flex-col gap-1.5',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {Icon && <Icon className={cn('size-3.5', ACCENT_CLASSES[accent])} />}
        <span>{label}</span>
      </div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
