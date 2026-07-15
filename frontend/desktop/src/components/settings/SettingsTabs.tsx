/* ── SettingsTabs — modern segmented / rail sub-navigation ─────────── */
/* Horizontal pill for ≤4 items; vertical rail for denser sections so
 * tabs do not pile into an unreadable horizontal row. */

import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SettingsTabItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  description?: string;
}

interface SettingsTabsProps {
  value: string;
  onChange: (key: string) => void;
  items: readonly SettingsTabItem[];
  className?: string;
  /** aria-label for the tablist; defaults to "Tabs". */
  label?: string;
  /**
   * Layout:
   *  - auto: vertical rail when 5+ items, else horizontal pills
   *  - horizontal | vertical: force
   */
  orientation?: 'auto' | 'horizontal' | 'vertical';
}

export function SettingsTabs({
  value,
  onChange,
  items,
  className,
  label = 'Tabs',
  orientation = 'auto',
}: SettingsTabsProps) {
  const vertical =
    orientation === 'vertical' || (orientation === 'auto' && items.length >= 5);

  if (vertical) {
    return (
      <div
        role="tablist"
        aria-label={label}
        aria-orientation="vertical"
        className={cn(
          'flex flex-col gap-0.5 rounded-xl border border-white/[0.06] bg-card/40 p-1.5 min-w-[11rem]',
          className,
        )}
      >
        {items.map(({ key, label: tabLabel, icon: Icon, description }) => {
          const active = value === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(key)}
              className={cn(
                'flex items-start gap-2 rounded-lg px-2.5 py-2 text-left transition',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                active
                  ? 'bg-primary/15 text-foreground border border-primary/30'
                  : 'border border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground',
              )}
            >
              {Icon && (
                <Icon
                  className={cn(
                    'size-3.5 mt-0.5 shrink-0',
                    active ? 'text-primary' : 'text-muted-foreground',
                  )}
                />
              )}
              <span className="min-w-0">
                <span className="block text-xs font-medium leading-tight">{tabLabel}</span>
                {description && (
                  <span className="mt-0.5 block text-[10px] text-muted-foreground line-clamp-2">
                    {description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        'inline-flex max-w-full items-center gap-0.5 rounded-xl border border-white/[0.06]',
        'bg-white/[0.02] p-1 overflow-x-auto scrollbar-none',
        className,
      )}
    >
      {items.map(({ key, label: tabLabel, icon: Icon }) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              active
                ? 'bg-primary/15 text-foreground shadow-sm ring-1 ring-primary/25'
                : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground',
            )}
          >
            {Icon && <Icon className="size-3.5" />}
            {tabLabel}
          </button>
        );
      })}
    </div>
  );
}
