/* ── UserDropdown — the sidebar profile footer's account popover ────────
 *
 * Restyled to the mockup's `.account-popover`: one compact panel anchored
 * above the profile row, icon rows only — no avatar header, no status
 * picker. The three mockup rows come first (Account settings / Switch
 * workspace / Sign out); the rows below are the app's OWN live surfaces
 * that the mockup has no opinion about (update, appearance, what's new,
 * help), kept so no real entry point is deleted to make the mockup fit.
 * The old template menu (status badge, "Update status" submenu, generic
 * profile/support groups) is gone with the redesign it imitated.
 */

import { motion, type Variants } from 'framer-motion';

import { ExternalLink } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SignalIcon, type SignalIconName } from '@/components/ui/SignalIcon';
import { t } from '@/lib/motion';
import { cn } from '@/lib/utils';

export type UserStatus = 'online' | 'focus' | 'offline' | 'busy';

export type UserDropdownAction =
  | 'profile'
  | 'appearance'
  | 'settings'
  | 'notifications'
  | 'whats-new'
  | 'help'
  | 'switch'
  | 'logout'
  | 'create-account'
  | 'update';

export interface UserDropdownUser {
  name: string;
  username: string;
  avatar: string;
  initials: string;
  status: UserStatus;
}

export interface UserDropdownAccount {
  id: string;
  name: string;
  avatar?: string;
  initials?: string;
}

interface AccountRow {
  signal: SignalIconName;
  label: string;
  action: UserDropdownAction;
  danger?: boolean;
  badge?: { text: string; className: string };
  RightIcon?: typeof ExternalLink;
}

/** Same row nudge as New chat / Skills & Tools in SessionListNav. */
const rowMotion: Variants = {
  rest: { x: 0 },
  hover: { x: 2, transition: t.fast },
  tap: { scale: 0.98, transition: t.fast },
};

const DEFAULT_USER: UserDropdownUser = {
  name: 'Guest',
  username: '@guest',
  avatar: '',
  initials: 'G',
  status: 'online',
};

const rowClass =
  'flex w-full cursor-pointer select-none items-center gap-[7px] rounded-[5px] px-2 py-[7px] text-left text-xs text-foreground/85 outline-none transition-colors data-[highlighted]:bg-muted/70 data-[highlighted]:text-foreground';

export interface UserDropdownProps {
  user?: UserDropdownUser;
  onAction?: (action: UserDropdownAction) => void;
  onStatusChange?: (status: string) => void;
  selectedStatus?: string;
  /** When false, show Create account instead of Switch / Sign out. */
  signedIn?: boolean;
  accounts?: UserDropdownAccount[];
  /** Custom trigger (e.g. settings row). Defaults to avatar button. */
  trigger?: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  matchTriggerWidth?: boolean;
  contentWidth?: number;
  contentClassName?: string;
  alignOffset?: number;
  sideOffset?: number;
  className?: string;
  triggerClassName?: string;
  /** When set, shows an update row in the menu. */
  updateAvailable?: { version: string } | null;
}

export function UserDropdown({
  user: _user = DEFAULT_USER,
  onAction = () => {},
  signedIn = false,
  trigger,
  align = 'end',
  side = 'bottom',
  matchTriggerWidth = false,
  contentWidth,
  contentClassName,
  alignOffset,
  sideOffset,
  className: _className,
  triggerClassName: _triggerClassName,
  updateAvailable = null,
}: UserDropdownProps) {
  // The mockup's three rows, then the app's own live surfaces.
  const rows: AccountRow[] = [
    { signal: 'settings', label: 'Account settings', action: 'profile' },
    signedIn
      ? { signal: 'folder', label: 'Switch workspace', action: 'switch' }
      : { signal: 'user', label: 'Create account', action: 'create-account' },
    ...(signedIn
      ? [{ signal: 'close' as const, label: 'Sign out', action: 'logout' as const, danger: true }]
      : []),
    ...(updateAvailable
      ? [
          {
            signal: 'refresh' as const,
            label: `Update to v${updateAvailable.version}`,
            action: 'update' as const,
            badge: {
              text: 'New',
              className: 'rounded-sm border-0 bg-warning/20 text-warning-fg text-2xs px-1.5 py-0',
            },
          },
        ]
      : []),
    { signal: 'sun', label: 'Appearance', action: 'appearance' },
    { signal: 'info', label: "What's new?", action: 'whats-new' },
    {
      signal: 'globe',
      label: 'Get help',
      action: 'help',
      RightIcon: ExternalLink,
    },
  ];

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{trigger ?? null}</DropdownMenuTrigger>

      <DropdownMenuContent
        className={cn(
          'august-menu-panel rounded-lg border border-border bg-popover p-1 shadow-lg',
          'data-[state=open]:duration-200 data-[state=closed]:duration-150',
          contentWidth == null &&
            (matchTriggerWidth
              ? 'w-[var(--radix-dropdown-menu-trigger-width)]'
              : 'w-[220px]'),
          contentClassName,
        )}
        style={contentWidth != null ? { width: contentWidth } : undefined}
        align={align}
        side={side}
        alignOffset={alignOffset}
        sideOffset={sideOffset ?? 8}
        onPointerDownOutside={(e) => {
          if (
            e.target instanceof Element &&
            e.target.closest('[data-brain-popup-root]')
          ) {
            e.preventDefault();
          }
        }}
        onFocusOutside={(e) => {
          if (
            e.target instanceof Element &&
            e.target.closest('[data-brain-popup-root]')
          ) {
            e.preventDefault();
          }
        }}
      >
        <DropdownMenuGroup>
          {rows.map((row, index) => {
            const RightIcon = row.RightIcon;
            return (
              <DropdownMenuItem
                key={`${row.action}-${index}`}
                asChild
                className="p-0 focus:bg-transparent"
                onSelect={() => onAction(row.action)}
              >
                <motion.button
                  type="button"
                  initial="rest"
                  whileHover="hover"
                  whileTap="tap"
                  variants={rowMotion}
                  className={cn(rowClass, row.danger && 'text-danger-fg')}
                >
                  {/* Explicit size: this popover portals to document.body,
                      outside .sd-app, so the stylesheet's .icon-sm sizing
                      never reaches it. */}
                  <SignalIcon name={row.signal} className="size-3.5 shrink-0 opacity-70" />
                  <span className="block min-w-0 flex-1 truncate">{row.label}</span>
                  {row.badge && (
                    <span className={cn('rounded-sm px-1.5 py-0 text-2xs', row.badge.className)}>
                      {row.badge.text}
                    </span>
                  )}
                  {RightIcon && <RightIcon className="size-3 shrink-0 opacity-50" />}
                </motion.button>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default UserDropdown;
