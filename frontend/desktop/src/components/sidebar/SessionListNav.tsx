/* ── Session list nav — the mockup's sidebar head and destinations ─────
 *
 * Copied from docs/design/signal-desk-complete.html: the brand row, New
 * thread, the quick-search field, and the four primary destinations. The
 * mockup shows exactly four; every other surface stays reachable under
 * "More", which uses the same row so the rail has one voice.
 *
 * The mockup's workspace card is deliberately NOT here: the project decision
 * belongs beside the composer, and that is where the picker already lives
 * (`ComposerWorkspaceChips`, which also receives the sidebar's
 * `august:open-project-picker` event). A second selector in the rail stated
 * the same binding twice and its full path read like a file manager.
 *
 * Behaviour is unchanged from the Tailwind version this replaced: the same
 * onNew / onNavigate / onToggleCollapsed props, the same command-palette
 * door, the same workspace picker event.
 */

import { useEffect, useState } from 'react';
import { toggleCommandPalette } from '@/store/command-palette';
import { SignalIcon, type SignalIconName } from '@/components/ui/SignalIcon';
import { Button } from "@/components/ui/button";

export interface SessionListNavProps {
  onNew: () => void;
  onNavigate: (path: string) => void;
  onToggleCollapsed: () => void;
  /** Current location pathname — the matching nav row gets aria-current. */
  activePath?: string;
  /** Open chats, printed beside Threads the way the mockup prints its count. */
  threadCount?: number;
  /** The phone tier: the bottom tabbar owns Chat/Charts/Artifacts/Settings,
   *  so the drawer does not repeat them (the mockup's drawer is threads and a
   *  way out, not a second nav). */
  mobile?: boolean;
}

/** Primary destinations — the mockup's four, in its order. */
const PRIMARY: ReadonlyArray<{
  key: string;
  label: string;
  icon: SignalIconName;
  to: string;
  pill?: string;
}> = [
  { key: 'threads', label: 'Threads', icon: 'chat', to: '/' },
  { key: 'charts', label: 'Charts', icon: 'chart', to: '/charts', pill: 'NEW' },
  { key: 'artifacts', label: 'Artifacts', icon: 'grid', to: '/artifacts' },
  { key: 'settings', label: 'Settings', icon: 'settings', to: '/settings' },
];

/** Every surface the mockup does not show stays reachable here. */
const MORE: ReadonlyArray<{ label: string; icon: SignalIconName; to: string }> = [
  { label: 'Automations', icon: 'clock', to: '/automations' },
  { label: 'Runs', icon: 'play', to: '/runs' },
  { label: 'Board', icon: 'grid', to: '/board' },
  { label: 'Live', icon: 'mic', to: '/live' },
  { label: 'History', icon: 'clock', to: '/history' },
  { label: 'Learning', icon: 'layers', to: '/learning' },
  { label: 'Docs', icon: 'file', to: '/docs' },
];

function isActive(to: string, path: string): boolean {
  if (to === '/') return path === '/' || path === '' || path.startsWith('/c/');
  return path === to || path.startsWith(`${to}/`);
}

export function SessionListNav({
  onNew,
  onNavigate,
  onToggleCollapsed,
  activePath = '',
  threadCount,
  mobile = false,
}: SessionListNavProps) {
  const moreActive = MORE.some((item) => isActive(item.to, activePath));
  const [moreOpen, setMoreOpen] = useState(moreActive);

  useEffect(() => {
    if (moreActive) setMoreOpen(true);
  }, [moreActive]);

  return (
    <div className="august-sidebar-nav shrink-0">
      <div className="sidebar-head">
        <div className="brand-copy">
          <span className="brand-name">August</span>
        </div>
        <Button variant="bare"
          type="button"
          className="icon-button"
          onClick={onToggleCollapsed}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <SignalIcon name="panel" />
        </Button>
      </div>

      <div className="sd-sidebar-top">
        <Button variant="bare" type="button" className="new-thread" onClick={onNew}>
          <span className="plus-box">
            <SignalIcon name="plus" />
          </span>
          <span>New thread</span>
        </Button>

        <Button variant="bare"
          type="button"
          className="quick-search"
          onClick={() => toggleCommandPalette()}
          title="Search or run a command (Ctrl+K)"
          aria-keyshortcuts="Control+K"
        >
          <SignalIcon name="search" />
          <span>Search or jump to…</span>
          <kbd>⌘K</kbd>
        </Button>

        {!mobile && (
        <nav className="nav" aria-label="Workspace">
          {PRIMARY.map(({ key, label, icon, to, pill }) => {
            const active = isActive(to, activePath);
            return (
              <Button variant="bare"
                key={key}
                type="button"
                className="nav-item"
                data-active={active}
                aria-current={active ? 'page' : undefined}
                onClick={() => onNavigate(to)}
              >
                <SignalIcon name={icon} />
                <span>{label}</span>
                {key === 'threads' && threadCount ? (
                  <span className="nav-count">{threadCount}</span>
                ) : null}
                {pill ? <span className="new-pill">{pill}</span> : null}
              </Button>
            );
          })}

          <Button variant="bare"
            type="button"
            className="nav-item"
            data-active={moreActive}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <SignalIcon name="more" />
            <span>More</span>
            <span className="nav-count">
              <SignalIcon name={moreOpen ? 'chev' : 'chev-right'} />
            </span>
          </Button>
          {moreOpen
            ? MORE.map(({ label, icon, to }) => {
                const active = isActive(to, activePath);
                return (
                  <Button variant="bare"
                    key={to}
                    type="button"
                    className="nav-item"
                    data-active={active}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onNavigate(to)}
                  >
                    <SignalIcon name={icon} />
                    <span>{label}</span>
                  </Button>
                );
              })
            : null}
        </nav>
        )}
      </div>
    </div>
  );
}
