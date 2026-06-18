/* ── SettingsEmptyState — shared empty/no-data placeholder ─────────── */
/* Dashed-border centered layout for "no providers", "no logs", "no
 * agents", etc. Always includes text (not just an icon) so it reads well
 * to assistive tech and new users. */

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SettingsEmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function SettingsEmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: SettingsEmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/20 px-6 py-10 text-center',
        className,
      )}
    >
      {Icon && (
        <div className="mb-3 grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
