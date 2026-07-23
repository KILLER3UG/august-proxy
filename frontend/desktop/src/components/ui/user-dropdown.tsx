import { type ComponentType, type ReactNode, type SVGProps } from 'react';
import { motion, type Variants } from 'framer-motion';

import {
  Bell,
  CircleHelp,
  Download,
  ExternalLink,
  LogOut,
  Moon,
  RefreshCw,
  Settings,
  Smile,
  Sun,
  UserCircle,
  UserPlus,
  Users,
  Mail,
} from 'lucide-react';
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

type LucideIcon = ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;

interface MenuItemBase {
  Icon: LucideIcon;
  label: string;
  action: UserDropdownAction;
  iconClass?: string;
  badge?: { text: string; className: string };
  RightIcon?: LucideIcon;
  showAvatar?: boolean;
}

interface StatusMenuItem {
  value: string;
  Icon: LucideIcon;
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
  update: {
    rest: { scale: 1, y: 0 },
    hover: { scale: 1.12, y: -2, transition: t.spring },
    tap: { scale: 0.92, y: 0, transition: t.fast },
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
    { value: 'focus', Icon: Smile, label: 'Focus' },
    { value: 'offline', Icon: Moon, label: 'Appear Offline' },
  ],
  profile: [
    { Icon: UserCircle, label: 'Your profile', action: 'profile' },
    { Icon: Sun, label: 'Appearance', action: 'appearance' },
    { Icon: Settings, label: 'Settings', action: 'settings' },
    { Icon: Bell, label: 'Notifications', action: 'notifications' },
  ],
  support: [
    { Icon: Download, label: 'Download app', action: 'download' },
    { Icon: Mail, label: "What's new?", action: 'whats-new' },
    { Icon: CircleHelp, label: 'Get help?', action: 'help', RightIcon: ExternalLink },
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

const iconClass = 'size-4 shrink-0 text-muted-foreground';

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
  /** When set, shows an update notice in the menu (Notifications badge + row). */
  updateAvailable?: { version: string } | null;
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
  updateAvailable = null,
}: UserDropdownProps) {
  const profileItems: MenuItemBase[] = MENU_ITEMS.profile.map((item) => {
    if (item.action === 'notifications' && updateAvailable) {
      return {
        ...item,
        badge: {
          text: 'Update',
          className:
            'rounded-sm border-0 bg-amber-500/20 text-amber-400 text-[10px] px-1.5 py-0',
        },
      };
    }
    return item;
  });

  const supportItems: MenuItemBase[] = [
    ...(updateAvailable
      ? [
          {
            Icon: RefreshCw,
            label: `Update to v${updateAvailable.version}`,
            action: 'update' as const,
            badge: {
              text: 'New',
              className:
                'rounded-sm border-0 bg-amber-500/20 text-amber-400 text-[10px] px-1.5 py-0',
            },
          },
        ]
      : []),
    ...MENU_ITEMS.support,
  ];

  const accountItems: MenuItemBase[] = signedIn
    ? [
        {
          Icon: Users,
          label: 'Switch account',
          action: 'switch',
          showAvatar: false,
        },
        { Icon: LogOut, label: 'Log out', action: 'logout' },
      ]
    : [
        {
          Icon: UserPlus,
          label: 'Create account',
          action: 'create-account',
        },
      ];

  const renderMenuItem = (item: MenuItemBase, index: number) => {
    const iconMotion = ICON_MOTION[item.action] ?? defaultIconMotion;
    const ItemIcon = item.Icon;
    const ItemRightIcon = item.RightIcon;
    return (
      <DropdownMenuItem
        key={`${item.action}-${index}`}
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
            item.badge || item.showAvatar || item.RightIcon ? 'justify-between' : '',
            'data-[highlighted]:bg-accent/70',
          )}
        >
          <span className="flex items-center gap-1.5 font-medium">
            <motion.span className="inline-flex shrink-0" variants={iconMotion}>
              <ItemIcon className={cn(iconClass, item.iconClass)} />
            </motion.span>
            {item.label}
          </span>
          {item.badge && <Badge className={item.badge.className}>{item.badge.text}</Badge>}
          {ItemRightIcon && <ItemRightIcon className="size-3.5 shrink-0 text-muted-foreground" />}
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
    <DropdownMenu modal={false}>
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
                  className="flex w-full items-center gap-1.5 p-2 font-medium text-muted-foreground"
                  initial="rest"
                  whileHover="hover"
                  whileTap="tap"
                  variants={rowMotion}
                >
                  <motion.span
                    className="inline-flex shrink-0"
                    variants={ICON_MOTION.status}
                  >
                    <Smile className={iconClass} />
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
                    {MENU_ITEMS.status.map((status, index) => {
                      const StatusIcon = status.Icon;
                      return (
                        <DropdownMenuRadioItem
                          className="august-menu-item gap-2 rounded-lg"
                          style={{ animationDelay: `${30 + index * 35}ms` }}
                          key={status.value}
                          value={status.value}
                        >
                          <motion.span
                            className="inline-flex shrink-0"
                            initial="rest"
                            whileHover="hover"
                            variants={defaultIconMotion}
                          >
                            <StatusIcon className={iconClass} />
                          </motion.span>
                          {status.label}
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />
          <DropdownMenuGroup>{profileItems.map(renderMenuItem)}</DropdownMenuGroup>

          <DropdownMenuSeparator />
          <DropdownMenuGroup>{supportItems.map(renderMenuItem)}</DropdownMenuGroup>
        </section>

        <section className="mt-1 rounded-2xl p-1">
          <DropdownMenuGroup>
            {accountItems.map((item, index) =>
              renderMenuItem(item, profileItems.length + supportItems.length + index),
            )}
          </DropdownMenuGroup>
        </section>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default UserDropdown;
