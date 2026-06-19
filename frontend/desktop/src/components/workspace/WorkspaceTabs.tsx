/* ── WorkspaceTabs — segmented tab control matching the workspace style ─ */
/* Lighter, more compact than SettingsTabs. Designed for the chat-side
 * workspace panel where screens are taller but the rail chrome already
 * carries visual weight. */

import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface WorkspaceTabItem {
  key: string;
  label: string;
  icon?: LucideIcon;
}

interface WorkspaceTabsProps {
  value: string;
  onChange: (key: string) => void;
  items: readonly WorkspaceTabItem[];
  className?: string;
  label?: string;
}

export function WorkspaceTabs({
  value,
  onChange,
  items,
  className,
  label = 'Tabs',
}: WorkspaceTabsProps) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-1',
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
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition',
              active
                ? 'bg-white/[0.06] text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-white/[0.04]',
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
