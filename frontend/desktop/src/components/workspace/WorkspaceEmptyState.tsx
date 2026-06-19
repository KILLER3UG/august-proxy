/* ── WorkspaceEmptyState — shared empty placeholder for workspace ────── */
/* Always renders a title + description (never icon-only) so screen
 * readers and new users get a clear explanation. */

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function WorkspaceEmptyState({ icon: Icon, title, description, action, className }: Props) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-white/[0.08] bg-card/40 px-6 py-12 text-center',
        className,
      )}
    >
      {Icon && (
        <div className="mb-3 grid size-10 place-items-center rounded-full bg-white/[0.04] text-muted-foreground">
          <Icon className="size-5" />
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
