/* ── SettingsFrame — the settings page chrome, in ONE place ────────────
 *
 * Settings is a PAGE in the Signal Desk port (the mockup's settings screen
 * replaces the chat surface). The rail, content region and reading column are
 * shared by the real page and its loading skeleton, so the two cannot
 * disagree about width, border or scroll ownership.
 *
 * The old modal backdrop/panel classes are gone with the overlay route. The
 * shell is now a normal surface inside ChatLayout's main column. */

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Page frame: fills the main column below the titlebar. */
export const SETTINGS_PAGE_CLASS =
  'flex h-full min-h-0 w-full overflow-hidden bg-background';

/** The left rail. `min-h-0` + `overflow-hidden` so its own `nav` is the
 *  scroller; a rail that grew instead of scrolling would push the profile
 *  footer out of the page. */
export const SETTINGS_RAIL_CLASS =
  'flex h-full min-h-0 w-44 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar sm:w-60';

/** The scrolling content region — centred in the space the rail leaves. */
export const SETTINGS_CONTENT_CLASS =
  'flex h-full min-h-0 flex-1 justify-center overflow-y-auto overflow-x-hidden';

export const SETTINGS_COLUMN_CLASS = 'flex min-h-full w-full max-w-[1080px] flex-col';

const RAIL_ROW_FADE = [
  'opacity-100',
  'opacity-90',
  'opacity-80',
  'opacity-70',
  'opacity-60',
  'opacity-50',
  'opacity-45',
  'opacity-40',
  'opacity-35',
  'opacity-30',
  'opacity-25',
];

export function SettingsFrameSkeleton() {
  return (
    <div className={SETTINGS_PAGE_CLASS} data-testid="settings-page" data-loading="true">
      <aside className={SETTINGS_RAIL_CLASS} aria-label="Settings sections">
        <div className="px-3 pb-2 pt-3">
          <Skeleton className="h-8 w-full rounded-lg" />
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-hidden px-2 py-2" aria-hidden="true">
          {Array.from({ length: RAIL_ROW_FADE.length }).map((_, index) => (
            <Skeleton key={index} className={cn('h-7 w-full rounded-md', RAIL_ROW_FADE[index])} />
          ))}
        </div>
        <div className="min-h-0 shrink-0 border-t border-sidebar-border p-2">
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      </aside>
      <div className={SETTINGS_CONTENT_CLASS} data-testid="settings-content-region">
        <div className={SETTINGS_COLUMN_CLASS} data-testid="settings-content-column">
          <div className="w-full px-8 pt-8" aria-hidden="true">
            <Skeleton className="h-8 w-44" />
            <Skeleton className="mt-3 h-3 w-72 max-w-full" />
          </div>
          <div
            className="flex min-h-0 flex-1 items-center justify-center"
            role="status"
            data-testid="settings-frame-loader"
          >
            <span className="sr-only">Loading settings</span>
            <div className="size-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          </div>
        </div>
      </div>
    </div>
  );
}
