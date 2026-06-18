/* ── SettingsCard — modern card wrapper for merged sections ────────── */
/* Every redesigned Settings surface uses this so icon/title/description/
 * status layout stays consistent. Hover + icon color shift give the panel
 * a livelier feel than the raw <Card> primitive. */

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface SettingsCardProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned status pill / badge / toggle. */
  status?: ReactNode;
  /** Optional small action row rendered above the body (e.g. filters). */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Disable hover lift (useful inside scroll lists). */
  inert?: boolean;
}

export function SettingsCard({
  icon: Icon,
  title,
  description,
  status,
  actions,
  children,
  className,
  inert,
}: SettingsCardProps) {
  return (
    <Card
      className={cn(
        'group relative overflow-hidden border-border/80 bg-card/95 shadow-sm transition',
        !inert && 'hover:border-primary/20 hover:shadow-md',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div className="flex items-start gap-3 min-w-0">
          {Icon && (
            <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl border border-border bg-muted text-muted-foreground transition group-hover:border-primary/20 group-hover:text-primary">
              <Icon className="size-4" />
            </div>
          )}
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight text-foreground">{title}</div>
            {description && (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
        {status && <div className="shrink-0">{status}</div>}
      </div>
      {actions && (
        <div className="flex items-center justify-end gap-2 px-5 pb-3">{actions}</div>
      )}
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}
