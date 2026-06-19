/* ── WorkspaceField — labeled form field for workspace forms ────────── */
/* Wraps an input/select with consistent label + helper text + error
 * spacing. Used in the Model settings provider editor. */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  label: ReactNode;
  /** Optional helper text shown below the input. */
  hint?: ReactNode;
  /** Optional error message; replaces hint when present. */
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Optional badge rendered next to the label (e.g. "Required"). */
  badge?: ReactNode;
}

export function WorkspaceField({ label, hint, error, children, className, badge }: Props) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-medium text-foreground/80">{label}</label>
        {badge}
      </div>
      {children}
      {(error || hint) && (
        <p className={cn('text-[11px]', error ? 'text-destructive' : 'text-muted-foreground')}>
          {error || hint}
        </p>
      )}
    </div>
  );
}
