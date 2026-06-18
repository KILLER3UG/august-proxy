/* ── SettingsTabs — shared segmented control ──────────────────────── */
/* Used by every merged section that collapses multiple old tabs into one
 * (Traffic & Activity, Conversation Inspector, Memory, …). Matches the
 * pill style already used in Memory.tsx so the redesign feels native. */

import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SettingsTabItem {
  key: string;
  label: string;
  icon?: LucideIcon;
}

interface SettingsTabsProps {
  value: string;
  onChange: (key: string) => void;
  items: readonly SettingsTabItem[];
  className?: string;
  /** aria-label for the tablist; defaults to "Tabs". */
  label?: string;
}

export function SettingsTabs({
  value,
  onChange,
  items,
  className,
  label = 'Tabs',
}: SettingsTabsProps) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        'flex items-center gap-1 rounded-lg bg-muted/30 p-1 flex-wrap',
        className,
      )}
    >
      {items.map(({ key, label: tabLabel, icon: Icon }) => {
        const active = value === key;
        return (
          <button
            key={key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-background/50 hover:text-foreground',
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
