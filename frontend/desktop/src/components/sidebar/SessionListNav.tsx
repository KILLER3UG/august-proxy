/* ── Session list nav — the mockup's sidebar head and destinations ─────
 *
 * Copied from docs/design/signal-desk-complete.html: the brand row, New
 * thread, and the four primary destinations. The mockup shows exactly four;
 * every other surface stays reachable under "More", which uses the same row
 * so the rail has one voice.
 *
 * The mockup's quick-search field is deliberately NOT here. It only opened the
 * command palette, which the titlebar's "Search or run" button and the Ctrl+K
 * binding already reach, so the rail carried a third door to one thing — and
 * its `⌘K` chip advertised the macOS binding on a Windows-only app.
 *
 * The mockup's workspace card is deliberately NOT here: the project decision
 * belongs beside the composer, and that is where the picker already lives
 * (`ComposerWorkspaceChips`, which also receives the sidebar's
 * `august:open-project-picker` event). A second selector in the rail stated
 * the same binding twice and its full path read like a file manager.
 *
 * Behaviour is unchanged from the Tailwind version this replaced: the same
 * onNew / onNavigate / onToggleCollapsed props, the same workspace picker
 * event.
 */

import { useEffect, useRef, useState } from 'react';
import { SignalIcon, type SignalIconName } from '@/components/ui/SignalIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  // Starts closed even when a destination inside it is current: the trigger
  // carries `data-active`, and a menu that opens itself at launch is a popup
  // the user did not ask for.
  const [moreOpen, setMoreOpen] = useState(false);
  // The card must portal INTO `.sd-app`, not to document.body: the mockup's
  // stylesheet is scoped to that subtree and declares its colour tokens
  // there, so a body-level card loses `.nav-item`, `.icon-sm` and every
  // `--panel-*` at once and renders as an unstyled menu with oversized icons.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortal(rootRef.current?.closest<HTMLElement>('.sd-app') ?? null);
  }, []);

  // Hover opened the card, so the pointer leaving it must close it. The close
  // is delayed rather than immediate: the card sits 6px clear of the trigger
  // and the pointer crosses that gap, so an instant leave would kill the menu
  // on the way from the row into the list. Entering either half cancels it.
  const leaveTimer = useRef<number | null>(null);
  const cancelLeave = () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };
  // Radix hands focus back to the trigger when the menu closes, which paints a
  // focus ring on a row the user only ever hovered — the box that stayed
  // behind after the cursor left. It has to be refused at Radix's own
  // close-auto-focus hook: blurring the button from the leave timer runs
  // first, and Radix then focuses it again. The keyboard path must keep its
  // ring, so the origin is tracked rather than guessed.
  const hoverOpened = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const setMore = (next: boolean) => {
    // The flag is read by the card's own close-focus handler, so it is not
    // cleared here — pointerenter sets it and a keyboard open clears it.
    if (!next && hoverOpened.current) triggerRef.current?.blur();
    setMoreOpen(next);
  };
  const scheduleLeave = () => {
    cancelLeave();
    leaveTimer.current = window.setTimeout(() => setMore(false), 140);
  };
  useEffect(() => cancelLeave, []);

  return (
    <div ref={rootRef} className="august-sidebar-nav shrink-0">
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

          {/* "More" opens the way the composer's model menu does: a card to
              the RIGHT of the rail, not rows that push the list down. Radix
              owns open/close, so click, Escape, outside-click and the arrow
              keys all drive one piece of state — the hand-rolled pair of
              handlers this replaced fought each other, because a click
              arrives after pointerenter and toggled the menu straight back
              shut. `modal={false}` keeps the rail live underneath it. Radix
              tracks the pointer for SUB-menus only, so a top-level menu that
              opens on hover has to report its own leave: the trigger and the
              card each hand their enter/leave to the same grace timer. */}
          <DropdownMenu open={moreOpen} onOpenChange={setMore} modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="bare"
                ref={triggerRef}
                type="button"
                className="nav-item"
                data-active={moreActive}
                onPointerEnter={(event) => {
                  // Hover opens for a mouse only: a tap dispatches pointerenter
                  // as well, and would pre-open the menu before its own click.
                  if (event.pointerType === 'mouse') {
                    hoverOpened.current = true;
                    cancelLeave();
                    setMore(true);
                  }
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType === 'mouse') scheduleLeave();
                }}
                onKeyDown={() => {
                  // Opened from the keyboard: the ring is wanted here, so the
                  // close handler must not refuse the focus return.
                  hoverOpened.current = false;
                }}
              >
                <SignalIcon name="more" />
                <span>More</span>
                <span className="nav-count">
                  <SignalIcon name={moreOpen ? 'chev' : 'chev-right'} />
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="nav-more-panel"
              container={portal}
              onPointerEnter={(event) => {
                if (event.pointerType === 'mouse') cancelLeave();
              }}
              onPointerLeave={(event) => {
                if (event.pointerType === 'mouse') scheduleLeave();
              }}
              side="right"
              align="start"
              sideOffset={6}
              onCloseAutoFocus={(event) => {
                // Refuse Radix's focus return when the menu was only ever
                // hovered; that focus is what painted the ring box on the row
                // after the cursor had gone.
                if (hoverOpened.current) event.preventDefault();
              }}
            >
              {MORE.map(({ label, icon, to }) => (
                <DropdownMenuItem
                  key={to}
                  className="nav-item"
                  data-active={isActive(to, activePath)}
                  onSelect={() => onNavigate(to)}
                >
                  <SignalIcon name={icon} />
                  <span>{label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>
        )}
      </div>
    </div>
  );
}
