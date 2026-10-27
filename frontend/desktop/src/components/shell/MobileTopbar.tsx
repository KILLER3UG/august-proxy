/* ── MobileTopbar — the phone's only titlebar ─────────────────────────── */
/* Ported from docs/design/signal-desk-mobile.html: menu · title + subtitle ·
 * live dot · more. It replaces ChatTitlebar below 760px — the desktop bar
 * carries breadcrumbs, a command search, theme and canvas toggles, which a
 * 390px row cannot hold and a thumb cannot reach.
 *
 * The title is the same string the desktop bar prints (lib/route-labels), so
 * the two chromes cannot disagree about what page is open; the subtitle is
 * the mobile design's second line — the workspace on a chat, the section's
 * own ground on a page. */

import { Button } from '@/components/ui/button';
import { SignalIcon } from '@/components/ui/SignalIcon';

export function MobileTopbar({
  title,
  subtitle,
  live,
  onMenu,
  onMore,
}: {
  title: string;
  subtitle: string;
  /** A turn is streaming — the mockup's one solid dot. */
  live: boolean;
  onMenu: () => void;
  onMore?: () => void;
}) {
  return (
    <header className="august-mobile-topbar" data-testid="mobile-topbar">
      <Button
        variant="bare"
        type="button"
        className="icon-button"
        aria-label="Open threads"
        onClick={onMenu}
      >
        <SignalIcon name="menu" />
      </Button>

      <div className="min-w-0 flex-1">
        <div className="august-mobile-topbar-title truncate" title={title}>
          {title}
        </div>
        <div className="august-mobile-topbar-sub truncate">{subtitle}</div>
      </div>

      {live ? <span className="august-mobile-live" role="status" aria-label="August is working" /> : null}

      {onMore ? (
        <Button
          variant="bare"
          type="button"
          className="icon-button"
          aria-label="More actions"
          onClick={onMore}
        >
          <SignalIcon name="more" />
        </Button>
      ) : null}
    </header>
  );
}
