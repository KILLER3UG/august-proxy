/* ── SettingsSectionShell — standard page layout for sections ──────── */
/* Generous title/subtitle + optional sticky action row + scroll body.
 * New Settings sections prefer this over <SectionHeader>; the old sections
 * that we wrap verbatim keep SectionHeader. */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SettingsSectionShellProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned actions (refresh, export, presets…). */
  actions?: ReactNode;
  /** Extra content under the header but above the body (e.g. tabs/filters). */
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function SettingsSectionShell({
  title,
  subtitle,
  actions,
  toolbar,
  children,
  className,
  bodyClassName,
}: SettingsSectionShellProps) {
  return (
    <div className={cn('flex h-full flex-col', className)}>
      <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 shrink-0">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
          {subtitle && (
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {toolbar && (
        <div className="flex flex-wrap items-center gap-2 px-6 pb-3 shrink-0">
          {toolbar}
        </div>
      )}
      <div className={cn('flex-1 overflow-auto px-6 pb-6', bodyClassName)}>
        {children}
      </div>
    </div>
  );
}
