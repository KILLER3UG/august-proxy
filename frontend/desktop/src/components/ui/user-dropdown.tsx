import type { ReactNode } from 'react';
import { motion, type Variants } from 'framer-motion';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { t } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { Icon } from '@iconify/react';

export type UserStatus = 'online' | 'focus' | 'offline' | 'busy';

export type UserDropdownAction =
  | 'profile'
  | 'appearance'
  | 'settings'
  | 'notifications'
  | 'download'
  | 'whats-new'
  | 'help'
  | 'switch'
  | 'logout'
  | 'create-account';

export interface UserDropdownUser {
  name: string;
  username: string;
  avatar: string;
  initials: string;
  status: UserStatus | string;
}

export interface UserDropdownAccount {
  id: string;
  name: string;
  avatar?: string;
  initials?: string;
}

interface MenuItemBase {
  icon: string;
  label: string;
  action: UserDropdownAction;
  iconClass?: string;
  badge?: { text: string; className: string };
  rightIcon?: string;
  showAvatar?: boolean;
}

interface StatusMenuItem {
  value: string;
  icon: string;
  label: string;
}

/** Same row nudge as New chat / Skills & Tools in SessionListNav. */
const rowMotion = {
  rest: { x: 0 },
  hover: { x: 3, transition: t.fast },
  tap: { scale: 0.98, transition: t.fast },
};

const defaultIconMotion: Variants = {
  rest: { scale: 1, rotate: 0 },
  hover: { scale: 1.12, rotate: -18, transition: t.spring },
  tap: { scale: 0.92, transition: t.fast },
};

const ICON_MOTION: Partial<Record<UserDropdownAction | 'status', Variants>> = {
  profile: {
    rest: { scale: 1, y: 0 },
    hover: { scale: 1.12, y: -2, transition: t.spring },
    tap: { scale: 0.92, y: 0, transition: t.fast },
  },
  appearance: {
    rest: { scale: 1, rotate: 0 },
    hover: { scale: 1.15, rotate: 45, transition: t.spring },
    tap: { scale: 0.9, rotate: 45, transition: t.fast },
  },
  settings: {
    rest: { scale: 1, rotate: 0 },
    hover: { scale: 1.12, rotate: -18, transition: t.spring },
    tap: { scale: 0.92, transition: t.fast },
  },
  notifications: {
    rest: { scale: 1, rotate: 0 },
    hover: { scale: 1.15, rotate: 12, transition: t.spring },
    tap: { scale: 0.9, transition: t.fast },
  },
  download: {
    rest: { scale: 1, y: 0 },
    hover: { scale: 1.12, y: 2, transition: t.spring },
    tap: { scale: 0.92, y: 0, transition: t.fast },
  },
  'whats-new': {
    rest: { scale: 1, rotate: 0 },
    hover: { scale: 1.15, rotate: -8, transition: t.spring },
    tap: { scale: 0.9, transition: t.fast },
  },
  help: {
    rest: { scale: 1, rotate: 0 },
    hover: { scale: 1.15, rotate: 0, transition: t.spring },
    tap: { scale: 0.9, transition: t.fast },
  },
  switch: defaultIconMotion,
  logout: defaultIconMotion,
  'create-account': {
    rest: { scale: 1, rotate: 0 },
    hover: { scale: 1.15, rotate: 90, transition: t.spring },
    tap: { scale: 0.9, rotate: 90, transition: t.fast },
  },
  status: {
    rest: { scale: 1, rotate: 0 },
    hover: { scale: 1.15, rotate: 12, transition: t.spring },
    tap: { scale: 0.9, transition: t.fast },
  },
};

const MENU_ITEMS: {
  status: StatusMenuItem[];
  profile: MenuItemBase[];
  support: MenuItemBase[];
} = {
  status: [
    { value: 'focus', icon: 'solar:emoji-funny-circle-line-duotone', label: 'Focus' },
    { value: 'offline', icon: 'solar:moon-sleep-line-duotone', label: 'Appear Offline' },
  ],
  profile: [
    { icon: 'solar:user-circle-line-duotone', label: 'Your profile', action: 'profile' },
    { icon: 'solar:sun-line-duotone', label: 'Appearance', action: 'appearance' },
    { icon: 'solar:settings-line-duotone', label: 'Settings', action: 'settings' },
    { icon: 'solar:bell-line-duotone', label: 'Notifications', action: 'notifications' },
  ],
  support: [
    { icon: 'solar:download-line-duotone', label: 'Download app', action: 'download' },
    {
      icon: 'solar:letter-unread-line-duotone',
      label: "What's new?",
      action: 'whats-new',
    },
    {
      icon: 'solar:question-circle-line-duotone',
      label: 'Get help?',
      action: 'help',
      rightIcon: 'solar:square-top-down-line-duotone',
    },
  ],
};

const DEFAULT_USER: UserDropdownUser = {
  name: 'Guest',
  username: '@guest',
  avatar:
    'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=96&h=96&fit=crop&crop=face',
  initials: 'G',
  status: 'online',
};

const itemButtonClass =
  'w-full flex items-center gap-1.5 rounded-lg p-2 text-sm outline-none cursor-pointer select-none';

export interface UserDropdownProps {
  user?: UserDropdownUser;
  onAction?: (action: UserDropdownAction) => void;
  onStatusChange?: (status: string) => void;
  selectedStatus?: string;
  /** When false, show Create account instead of Switch / Log out. */
  signedIn?: boolean;
  accounts?: UserDropdownAccount[];
  /** Custom trigger (e.g. settings row). Defaults to avatar button. */
  trigger?: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  matchTriggerWidth?: boolean;
  contentWidth?: number;
  contentClassName?: string;
  alignOffset?: number;
  sideOffset?: number;
  className?: string;
  triggerClassName?: string;
}

export function UserDropdown({
  user = DEFAULT_USER,
  onAction = () => {},
  onStatusChange = () => {},
  selectedStatus = 'online',
  signedIn = false,
  accounts: _accounts = [],
  trigger,
  align = 'end',
  side = 'bottom',
  matchTriggerWidth = false,
  contentWidth,
  contentClassName,
  alignOffset,
  sideOffset,
  className,
  triggerClassName,
}: UserDropdownProps) {
  const accountItems: MenuItemBase[] = signedIn
    ? [
        {
          icon: 'solar:users-group-rounded-bold-duotone',
          label: 'Switch account',
          action: 'switch',
          showAvatar: false,
        },
        { icon: 'solar:logout-2-bold-duotone', label: 'Log out', action: 'logout' },
      ]
    : [
        {
          icon: 'solar:user-plus-bold-duotone',
          label: 'Create account',
          action: 'create-account',
        },
      ];

  const renderMenuItem = (item: MenuItemBase, index: number) => {
    const iconMotion = ICON_MOTION[item.action] ?? defaultIconMotion;
    return (
      <DropdownMenuItem
        key={index}
        asChild
        className="august-menu-item p-0 focus:bg-transparent"
        style={{ animationDelay: `${40 + index * 35}ms` }}
        onSelect={() => onAction(item.action)}
      >
        <motion.button
          type="button"
          initial="rest"
          whileHover="hover"
          whileTap="tap"
          variants={rowMotion}
          className={cn(
            itemButtonClass,
            item.badge || item.showAvatar || item.rightIcon ? 'justify-between' : '',
            'data-[highlighted]:bg-accent/70',
          )}
        >
          <span className="flex items-center gap-1.5 font-medium">
            <motion.span className="inline-flex shrink-0" variants={iconMotion}>
              <Icon
                icon={item.icon}
                className={`size-5 ${item.iconClass || 'text-gray-500 dark:text-gray-400'}`}
              />
            </motion.span>
            {item.label}
          </span>
          {item.badge && <Badge className={item.badge.className}>{item.badge.text}</Badge>}
          {item.rightIcon && (
            <Icon
              icon={item.rightIcon}
              className="size-4 text-gray-500 dark:text-gray-400"
            />
          )}
          {item.showAvatar && (
            <Avatar className="size-6 cursor-pointer border border-white shadow dark:border-gray-700">
              <AvatarImage src={user.avatar} alt={user.name} />
              <AvatarFallback>{user.initials}</AvatarFallback>
            </Avatar>
          )}
        </motion.button>
      </DropdownMenuItem>
    );
  };

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      online:
        'text-green-600 bg-green-100 border-green-300 dark:text-green-400 dark:bg-green-900/30 dark:border-green-500/50',
      offline:
        'text-gray-600 bg-gray-100 border-gray-300 dark:text-gray-400 dark:bg-gray-800 dark:border-gray-600',
      busy:
        'text-red-600 bg-red-100 border-red-300 dark:text-red-400 dark:bg-red-900/30 dark:border-red-500/50',
      focus:
        'text-amber-600 bg-amber-100 border-amber-300 dark:text-amber-400 dark:bg-amber-900/30 dark:border-amber-500/50',
    };
    return colors[status.toLowerCase()] || colors.online;
  };

  const defaultTrigger = (
    <button
      type="button"
      className={cn(
        'rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        className,
      )}
      title="Account menu"
      aria-label="Open account menu"
    >
      <Avatar
        className={cn(
          'size-7 cursor-pointer border border-white dark:border-gray-700',
          triggerClassName,
        )}
      >
        <AvatarImage src={user.avatar} alt={user.name} />
        <AvatarFallback className="text-[10px]">{user.initials}</AvatarFallback>
      </Avatar>
    </button>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? defaultTrigger}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className={cn(
          'august-menu-panel no-scrollbar rounded-2xl bg-gray-50 p-0 dark:bg-black/90',
          'data-[state=open]:duration-200 data-[state=closed]:duration-150',
          contentWidth == null &&
            (matchTriggerWidth
              ? 'w-[var(--radix-dropdown-menu-trigger-width)]'
              : 'w-[310px]'),
          contentClassName,
        )}
        style={contentWidth != null ? { width: contentWidth } : undefined}
        align={align}
        side={side}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
      >
        <section className="rounded-2xl border border-gray-200 bg-white p-1 shadow backdrop-blur-lg dark:border-gray-700/20 dark:bg-gray-100/10">
          <div
            className="august-menu-item flex items-center p-2"
            style={{ animationDelay: '20ms' }}
          >
            <div className="flex flex-1 items-center gap-2">
              <Avatar className="size-10 cursor-pointer border border-white dark:border-gray-700">
                <AvatarImage src={user.avatar} alt={user.name} />
                <AvatarFallback>{user.initials}</AvatarFallback>
              </Avatar>
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {user.name}
                </h3>
                <p className="text-xs text-muted-foreground">{user.username}</p>
              </div>
            </div>
            <Badge
              className={`${getStatusColor(user.status)} rounded-sm border-[0.5px] text-[11px] capitalize`}
            >
              {user.status}
            </Badge>
          </div>

          <DropdownMenuGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                className="august-menu-item cursor-pointer rounded-lg p-0 focus:bg-transparent data-[state=open]:bg-accent/50"
                style={{ animationDelay: '55ms' }}
              >
                <motion.span
                  className="flex w-full items-center gap-1.5 p-2 font-medium text-gray-500 dark:text-gray-400"
                  initial="rest"
                  whileHover="hover"
                  whileTap="tap"
                  variants={rowMotion}
                >
                  <motion.span
                    className="inline-flex shrink-0"
                    variants={ICON_MOTION.status}
                  >
                    <Icon
                      icon="solar:smile-circle-line-duotone"
                      className="size-5 text-gray-500 dark:text-gray-400"
                    />
                  </motion.span>
                  Update status
                </motion.span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="august-menu-panel bg-white backdrop-blur-lg dark:bg-white/10 data-[state=open]:duration-200">
                  <DropdownMenuRadioGroup
                    value={selectedStatus}
                    onValueChange={onStatusChange}
                  >
                    {MENU_ITEMS.status.map((status, index) => (
                      <DropdownMenuRadioItem
                        className="august-menu-item gap-2 rounded-lg"
                        style={{ animationDelay: `${30 + index * 35}ms` }}
                        key={index}
                        value={status.value}
                      >
                        <motion.span
                          className="inline-flex shrink-0"
                          initial="rest"
                          whileHover="hover"
                          variants={defaultIconMotion}
                        >
                          <Icon
                            icon={status.icon}
                            className="size-5 text-gray-500 dark:text-gray-400"
                          />
                        </motion.span>
                        {status.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />
          <DropdownMenuGroup>{MENU_ITEMS.profile.map(renderMenuItem)}</DropdownMenuGroup>

          <DropdownMenuSeparator />
          <DropdownMenuGroup>{MENU_ITEMS.support.map(renderMenuItem)}</DropdownMenuGroup>
        </section>

        <section className="mt-1 rounded-2xl p-1">
          <DropdownMenuGroup>
            {accountItems.map((item, index) =>
              renderMenuItem(item, MENU_ITEMS.profile.length + MENU_ITEMS.support.length + index),
            )}
          </DropdownMenuGroup>
        </section>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default UserDropdown;
