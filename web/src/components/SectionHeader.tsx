import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/**
 * Standardized header used by every section.
 * Renders an icon-less title row + optional subtitle + optional right-aligned actions.
 * Section icons belong in the sidebar nav, not here.
 */
export function SectionHeader({ title, subtitle, actions, className }: Props) {
  return (
    <header className={cn('flex items-start justify-between gap-4 mb-6', className)}>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}
