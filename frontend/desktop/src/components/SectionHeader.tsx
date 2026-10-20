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
 *
 * THE SETTINGS PAGE-HEADER STANDARD, in one place, because six panels
 * were taking FOUR title sizes and TWO weights between them:
 *
 *   title    20px semibold  (text-xl font-semibold tracking-tight)
 *   subtitle 13px muted     (text-[0.8125rem] text-muted-foreground)
 *
 * A panel that wants a different header does not roll its own <h2> with
 * its own icon and its own sizes - it uses this component, or
 * `SettingsSectionShell`, which is set to the same pair. The reference's
 * settings header is one shape, and the point of a shared component is
 * that the shape cannot drift.
 */
export function SectionHeader({ title, subtitle, actions, className }: Props) {
  return (
    <header className={cn('flex items-start justify-between gap-4 mb-6', className)}>
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
        {subtitle && <p className="mt-1 text-[0.8125rem] text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}
