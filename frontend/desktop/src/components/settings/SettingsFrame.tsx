/* ── SettingsFrame — the settings dialog's own chrome, in ONE place ───────
 *
 * The frame lives HERE, not inside `SettingsPage`, because `SettingsPage` is a
 * lazy route element. While its chunk is in flight React renders the Suspense
 * fallback, and a fallback that is a generic page skeleton paints IN FLOW —
 * inside ChatLayout's dialog sibling slot, below the still-visible background
 * route. Measured in Chromium at localhost:5173/artifacts → Customize: the
 * Artifacts page stayed on screen with five fading full-width bars under it
 * (`PageLoader`'s list variant) and no dialog at all. The user's words: "this
 * UI appear first before the settings".
 *
 * So the rule this file encodes: a dialog's loading state IS the dialog. The
 * backdrop, the panel box and the rail column render immediately and only the
 * section body waits for its chunk.
 *
 * `SettingsPage`'s shell imports the same class constants below, so the
 * placeholder and the real frame cannot disagree about size, radius, layer or
 * rail width — a fallback that has to be re-tuned whenever the panel changes is
 * a fallback nobody keeps true. */

import { Skeleton } from '@/components/ui/skeleton';
import { MODAL_LAYER, modalLayerClass } from '@/components/overlays/modal-layers';
import { cn } from '@/lib/utils';

/** The dimmed, centred backdrop. `bg-scrim` is the app's own scrim token and
 *  the layer is the USER-OWNED rung of the modal ladder — a surface the user
 *  navigated to sits above the app-owned first-run surfaces, which yield to it.
 *  The z-index class is written via `modalLayerClass` whose table is literals,
 *  so Tailwind's source scanner still sees it. */
export const SETTINGS_BACKDROP_CLASS = cn(
  'fixed inset-0 flex items-center justify-center bg-scrim p-3 sm:p-8',
  modalLayerClass(MODAL_LAYER.userOwned),
);

/** The panel: wide (the reference's settings panel is ~1600px across, and a
 *  920px panel squeezed every three-column row's VALUE into ~300px) and capped
 *  in height so it stays a centred modal rather than a full-viewport page. */
export const SETTINGS_PANEL_CLASS =
  'relative flex max-h-[min(880px,calc(100vh-3rem))] w-full max-w-[1440px] overflow-hidden rounded-2xl border border-hairline-strong bg-background shadow-2xl';

/** The left rail. No `h-full`: the panel's height is content-driven, so a
 *  percentage height resolves against an indefinite parent and the profile
 *  footer gets clipped. `align-items: stretch` + `min-h-0` is what makes the
 *  rail exactly the panel height. */
export const SETTINGS_RAIL_CLASS =
  'flex min-h-0 w-44 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar sm:w-60';

/** The scrolling content region — centred in the space the rail LEAVES, which
 *  is how every reference with a left rail inside a centred dialog reads. */
export const SETTINGS_CONTENT_CLASS =
  'flex min-h-0 flex-1 justify-center overflow-y-auto overflow-x-hidden';

export const SETTINGS_COLUMN_CLASS = 'flex min-h-full w-full max-w-[1080px] flex-col';

/** The frame with no content in it: rail rows and a body heading as skeletons,
 *  plus the spinner the section body already uses when ITS chunk is cold
 *  (SettingsPage's `SettingsSectionLoader`), so the two loading states —
 *  shell cold, section cold — look like one continuous thing.
 *
 *  The panel carries an explicit height here, which the real dialog does not.
 *  `SETTINGS_PANEL_CLASS` caps at `min(880px, 100vh-3rem)` but is otherwise
 *  content-driven, and the content that holds it up is the 17-row rail — which
 *  a placeholder does not have. Measured with the height left out: the frame
 *  came up 1600×347 and the real panel landed 1440×880, so the fix removed one
 *  jump and left another. The same `min()` expression, on both sides, is what
 *  makes the swap size-neutral. */
const FRAME_PANEL_CLASS = cn(SETTINGS_PANEL_CLASS, 'h-[min(880px,calc(100vh-3rem))]');

/** The rail rows fade toward the bottom of the list, which is what reads as
 *  "more rows continue here". Written as literal classes rather than a computed
 *  inline `opacity` on each row: an inline style object cannot carry a theme
 *  token, is rebuilt on every parent render, and `check:design` refuses it on
 *  purpose. */
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
    <div
      className={SETTINGS_BACKDROP_CLASS}
      data-testid="settings-backdrop"
      data-loading="true"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className={FRAME_PANEL_CLASS}
      >
        <aside className={SETTINGS_RAIL_CLASS} aria-label="Settings sections">
          <div className="px-3 pb-2 pt-3">
            <Skeleton className="h-8 w-full rounded-lg" />
          </div>
          <div
            className="min-h-0 flex-1 space-y-1 overflow-hidden px-2 py-2"
            aria-hidden="true"
          >
            {Array.from({ length: RAIL_ROW_FADE.length }).map((_, i) => (
              <Skeleton
                key={i}
                className={cn('h-7 w-full rounded-md', RAIL_ROW_FADE[i])}
              />
            ))}
          </div>
          <div className="min-h-0 shrink-0 border-t border-sidebar-border p-2">
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        </aside>
        <div className={SETTINGS_CONTENT_CLASS} data-testid="settings-content-region">
          <div className={SETTINGS_COLUMN_CLASS} data-testid="settings-content-column">
            {/* The heading placeholder sits where a section heading actually
                goes — top of the column, same `px-8 pt-6` measure as
                SettingsPage's `SectionHeader` — and only the spinner is
                centred. Centring the whole block made the heading jump ~250px
                upward the moment the section mounted. */}
            <div className="w-full px-8 pt-6" aria-hidden="true">
              <Skeleton className="h-6 w-44" />
              <Skeleton className="mt-2 h-3 w-72 max-w-full" />
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
    </div>
  );
}
