/* ── SettingsTabs — modern segmented / rail sub-navigation ─────────── */
/* Horizontal pill for ≤4 items; vertical rail for denser sections so
 * tabs do not pile into an unreadable horizontal row.
 *
 * ARIA tabs pattern (§4.4): roving focus (only the active tab is in the
 * tab order), Arrow/Home/End navigation with automatic activation, and —
 * when the consumer passes `panelIdPrefix` — `aria-controls`/`id` wiring so
 * each tab names the panel it drives. The matching panel id is
 * `settingsTabPanelId(prefix, key)`; the consumer's content wrapper carries
 * `role="tabpanel"` + that id. */

import { useCallback, type KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { settingsTabPanelId, settingsTabTriggerId } from './settingsTabIds';

export interface SettingsTabItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  description?: string;
  /** Trailing count badge (e.g. skill total). Additive — omit for none. */
  count?: number;
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
  /** When set, every tab carries `aria-controls="<prefix>-panel-<key>"` and
   *  `id="<prefix>-tab-<key>"`; the consumer marks its content with
   *  `role="tabpanel"` + `settingsTabPanelId(prefix, activeKey)`. */
  panelIdPrefix?: string;
}

export function SettingsTabs({
  value,
  onChange,
  items,
  className,
  label = 'Tabs',
  orientation = 'auto',
  panelIdPrefix,
}: SettingsTabsProps) {
  const vertical =
    orientation === 'vertical' || (orientation === 'auto' && items.length >= 5);

  /** ARIA tabs automatic activation: arrows/Home/End move the selection and
   *  carry DOM focus with it. Vertical lists use Up/Down, horizontal rows
   *  Left/Right, so the keys match the reading direction of the layout. */
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const keys = vertical ? ['ArrowDown', 'ArrowUp'] : ['ArrowRight', 'ArrowLeft'];
      if (!keys.includes(e.key) && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const tabs = Array.from(
        e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
      );
      if (tabs.length === 0) return;
      const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
      let next: HTMLButtonElement;
      if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      else {
        const forward = e.key === (vertical ? 'ArrowDown' : 'ArrowRight');
        const from = index === -1 ? 0 : index + (forward ? 1 : -1);
        next = tabs[(from + tabs.length) % tabs.length];
      }
      next?.focus();
      const key = next?.getAttribute('data-tab-key');
      if (key && key !== value) onChange(key);
    },
    [onChange, value, vertical],
  );

  const tabProps = (key: string) => {
    const panelId = settingsTabPanelId(panelIdPrefix, key);
    return {
      'data-tab-key': key,
      tabIndex: value === key ? 0 : -1,
      ...(panelId && panelIdPrefix
        ? { id: settingsTabTriggerId(panelIdPrefix, key), 'aria-controls': panelId }
        : {}),
    };
  };

  if (vertical) {
    return (
      <div
        role="tablist"
        aria-label={label}
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        className={cn(
          // `border-white/[0.06]` is INVISIBLE over a light background -- the
          // hairline simply did not exist there. `border-border/60` is
          // theme-aware, which is what the rest of the app's hairlines use.
          'flex flex-col gap-0.5 rounded-xl border border-border/60 bg-card/40 p-1.5 min-w-[11rem]',
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
              {...tabProps(key)}
              onClick={() => onChange(key)}
              className={cn(
                'flex items-start gap-2 rounded-lg px-2.5 py-2 text-left transition',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                active
                  ? 'bg-primary/15 text-foreground border border-primary/30'
                  : 'border border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
            >
              {Icon && (
                <Icon
                  className={cn(
                    'size-3 mt-0.5 shrink-0',
                    active ? 'text-primary' : 'text-muted-foreground',
                  )}
                />
              )}
              <span className="min-w-0">
                <span className="block text-xs font-medium leading-tight">{tabLabel}</span>
                {description && (
                  <span className="mt-0.5 block text-2xs text-muted-foreground line-clamp-2">
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
      onKeyDown={onKeyDown}
      className={cn(
        'inline-flex max-w-full items-center gap-0.5 rounded-xl border border-border/60',
        'bg-card/40 p-1 overflow-x-auto scrollbar-none',
        className,
      )}
    >
      {items.map(({ key, label: tabLabel, icon: Icon, count }) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            {...tabProps(key)}
            onClick={() => onChange(key)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              active
                ? 'bg-primary/15 text-foreground shadow-sm ring-1 ring-primary/25'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            )}
          >
            {Icon && <Icon className="size-3" />}
            {tabLabel}
            {count != null && (
              <span
                className={cn(
                  'tabular-nums',
                  active ? 'text-foreground/60' : 'text-muted-foreground/50',
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
