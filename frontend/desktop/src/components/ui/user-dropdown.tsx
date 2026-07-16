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
import { cn } from '@/lib/utils';
import { Icon } from '@iconify/react';

export type UserStatus = 'online' | 'focus' | 'offline' | 'busy';

export type UserDropdownAction =
  | 'profile'
  | 'appearance'
  | 'settings'
  | 'notifications'
  | 'upgrade'
  | 'referrals'
  | 'download'
  | 'whats-new'
  | 'help'
  | 'switch'
  | 'logout';

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

const MENU_ITEMS: {
  status: StatusMenuItem[];
  profile: MenuItemBase[];
  premium: MenuItemBase[];
  support: MenuItemBase[];
  account: MenuItemBase[];
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
  premium: [
    {
      icon: 'solar:star-bold',
      label: 'Upgrade to Pro',
      action: 'upgrade',
      iconClass: 'text-amber-600',
      badge: { text: '20% off', className: 'bg-amber-600 text-white text-[11px]' },
    },
    { icon: 'solar:gift-line-duotone', label: 'Referrals', action: 'referrals' },
  ],
  support: [
    { icon: 'solar:download-line-duotone', label: 'Download app', action: 'download' },
    {
      icon: 'solar:letter-unread-line-duotone',
      label: "What's new?",
      action: 'whats-new',
      rightIcon: 'solar:square-top-down-line-duotone',
    },
    {
      icon: 'solar:question-circle-line-duotone',
      label: 'Get help?',
      action: 'help',
      rightIcon: 'solar:square-top-down-line-duotone',
    },
  ],
  account: [
    {
      icon: 'solar:users-group-rounded-bold-duotone',
      label: 'Switch account',
      action: 'switch',
      showAvatar: false,
    },
    { icon: 'solar:logout-2-bold-duotone', label: 'Log out', action: 'logout' },
  ],
};

const DEFAULT_USER: UserDropdownUser = {
  name: 'August User',
  username: '@august',
  avatar:
    'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=96&h=96&fit=crop&crop=face',
  initials: 'AU',
  status: 'online',
};

export interface UserDropdownProps {
  user?: UserDropdownUser;
  onAction?: (action: UserDropdownAction) => void;
  onStatusChange?: (status: string) => void;
  selectedStatus?: string;
  promoDiscount?: string;
  accounts?: UserDropdownAccount[];
  className?: string;
  triggerClassName?: string;
}

export function UserDropdown({
  user = DEFAULT_USER,
  onAction = () => {},
  onStatusChange = () => {},
  selectedStatus = 'online',
  promoDiscount = '20% off',
  accounts: _accounts = [],
  className,
  triggerClassName,
}: UserDropdownProps) {
  const renderMenuItem = (item: MenuItemBase, index: number) => (
    <DropdownMenuItem
      key={index}
      className={cn(
        item.badge || item.showAvatar || item.rightIcon ? 'justify-between' : '',
        'cursor-pointer rounded-lg p-2',
      )}
      onClick={() => onAction(item.action)}
    >
      <span className="flex items-center gap-1.5 font-medium">
        <Icon
          icon={item.icon}
          className={`size-5 ${item.iconClass || 'text-gray-500 dark:text-gray-400'}`}
        />
        {item.label}
      </span>
      {item.badge && (
        <Badge className={item.badge.className}>
          {promoDiscount || item.badge.text}
        </Badge>
      )}
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
    </DropdownMenuItem>
  );

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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
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
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="no-scrollbar w-[310px] rounded-2xl bg-gray-50 p-0 dark:bg-black/90"
        align="end"
      >
        <section className="rounded-2xl border border-gray-200 bg-white p-1 shadow backdrop-blur-lg dark:border-gray-700/20 dark:bg-gray-100/10">
          <div className="flex items-center p-2">
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
              <DropdownMenuSubTrigger className="cursor-pointer rounded-lg p-2">
                <span className="flex items-center gap-1.5 font-medium text-gray-500 dark:text-gray-400">
                  <Icon
                    icon="solar:smile-circle-line-duotone"
                    className="size-5 text-gray-500 dark:text-gray-400"
                  />
                  Update status
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="bg-white backdrop-blur-lg dark:bg-white/10">
                  <DropdownMenuRadioGroup
                    value={selectedStatus}
                    onValueChange={onStatusChange}
                  >
                    {MENU_ITEMS.status.map((status, index) => (
                      <DropdownMenuRadioItem
                        className="gap-2"
                        key={index}
                        value={status.value}
                      >
                        <Icon
                          icon={status.icon}
                          className="size-5 text-gray-500 dark:text-gray-400"
                        />
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
          <DropdownMenuGroup>{MENU_ITEMS.premium.map(renderMenuItem)}</DropdownMenuGroup>

          <DropdownMenuSeparator />
          <DropdownMenuGroup>{MENU_ITEMS.support.map(renderMenuItem)}</DropdownMenuGroup>
        </section>

        <section className="mt-1 rounded-2xl p-1">
          <DropdownMenuGroup>{MENU_ITEMS.account.map(renderMenuItem)}</DropdownMenuGroup>
        </section>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default UserDropdown;
