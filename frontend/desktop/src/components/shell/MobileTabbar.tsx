/* ── MobileTabbar — the phone's primary navigation ───────────────────── */
/* Ported from docs/design/signal-desk-mobile.html: four tabs, icon over a
 * small mono label, the active one marked by an ink label, a blue glyph and a
 * 1px mark on the bar's top edge.
 *
 * These four are the mockup's four, and they are the destinations a phone
 * actually needs: chat, charts, artifacts, settings. Everything else stays in
 * the threads drawer's own rows, exactly as the desktop rail's "More" group
 * keeps the long tail reachable. */

import { Button } from '@/components/ui/button';
import { SignalIcon, type SignalIconName } from '@/components/ui/SignalIcon';

const TABS: ReadonlyArray<{ key: string; label: string; icon: SignalIconName; path: string }> = [
  { key: 'chat', label: 'Chat', icon: 'chat', path: '/' },
  { key: 'charts', label: 'Charts', icon: 'chart', path: '/charts' },
  { key: 'artifacts', label: 'Artifacts', icon: 'grid', path: '/artifacts' },
  { key: 'settings', label: 'Settings', icon: 'settings', path: '/settings' },
];

function isTabActive(path: string, pathname: string): boolean {
  const lowered = pathname.toLowerCase();
  if (path === '/') return pathname === '/' || lowered.startsWith('/c/');
  return lowered === path || lowered.startsWith(`${path}/`);
}

export function MobileTabbar({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <nav className="august-mobile-tabbar" aria-label="Primary">
      {TABS.map((tab) => {
        const active = isTabActive(tab.path, pathname);
        return (
          <Button
            key={tab.key}
            variant="bare"
            type="button"
            className="august-mobile-tab"
            data-active={String(active)}
            aria-current={active ? 'page' : undefined}
            onClick={() => onNavigate(tab.path)}
          >
            <SignalIcon name={tab.icon} />
            <span>{tab.label}</span>
          </Button>
        );
      })}
    </nav>
  );
}
