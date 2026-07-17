/* ── IntegrationCard — tile in Your integrations list ──────────────── */

import { useState, type ComponentType } from 'react';
import {
  BadgeCheck,
  Plus,
  Check,
  Pencil,
  RotateCw,
  Loader2,
  type LucideIcon,
  FolderOpen,
  Brain,
  Globe,
} from 'lucide-react';
import { SiGithub, SiGoogle, SiSlack } from 'react-icons/si';
import { cn } from '@/lib/utils';
import type { IntegrationItem, IntegrationLogoSpec } from './useIntegrations';

interface IntegrationCardProps {
  item: IntegrationItem;
  onOpen: (item: IntegrationItem) => void;
  onPrimaryAction?: (item: IntegrationItem) => void;
  busy?: boolean;
}

const BRAND_ICONS: Record<
  string,
  ComponentType<{ className?: string; style?: React.CSSProperties }>
> = {
  google: SiGoogle,
  github: SiGithub,
  slack: SiSlack,
  filesystem: FolderOpen,
  memory: Brain,
  browser: Globe,
};

export function IntegrationCard({ item, onOpen, onPrimaryAction, busy }: IntegrationCardProps) {
  const { primary, icon: ActionIcon, label } = actionFor(item, busy);
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'group relative w-full rounded-xl border border-border/60 bg-card p-4 text-left',
        'transition hover:border-border hover:bg-card/90',
        'focus:outline-none focus:ring-1 focus:ring-primary/40',
      )}
    >
      <div className="flex items-start gap-3">
        <BrandLogo logo={item.logo} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-foreground">{item.name}</span>
            {item.verified && (
              <BadgeCheck
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-label="Verified publisher"
              />
            )}
            {item.isNew && (
              <span className="rounded text-[10px] font-medium text-rose-400/90">New</span>
            )}
            {item.isCommunity && (
              <span className="rounded border border-border bg-muted/40 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                Community
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.tagline}</p>
        </div>

        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            // Prefer the explicit action; fall back to opening detail so
            // Connect / Manage never silently no-ops in the lobby.
            if (onPrimaryAction) onPrimaryAction(item);
            else onOpen(item);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              if (onPrimaryAction) onPrimaryAction(item);
              else onOpen(item);
            }
          }}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition',
            primary
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : hovered
                ? 'border border-border bg-muted/50 text-foreground'
                : 'border border-border/60 bg-muted/30 text-muted-foreground',
            busy && 'pointer-events-none opacity-60',
          )}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <ActionIcon className="size-3" />}
          {label}
        </span>
      </div>
    </button>
  );
}

function BrandLogo({
  logo,
  size = 'md',
}: {
  logo: IntegrationLogoSpec;
  size?: 'lg' | 'md';
}) {
  const dim = size === 'lg' ? 'size-14 rounded-xl' : 'size-10 rounded-lg';
  const iconDim = size === 'lg' ? 'size-7' : 'size-5';

  if (logo.kind === 'brand' && logo.brand) {
    const Icon = BRAND_ICONS[logo.brand];
    if (Icon) {
      return (
        <div
          className={cn(
            'grid shrink-0 place-items-center border border-border/50 bg-muted/40',
            dim,
          )}
          title={logo.brand}
        >
          <Icon className={iconDim} style={{ color: logo.color }} />
        </div>
      );
    }
  }

  return (
    <div
      className={cn(
        'grid shrink-0 place-items-center font-semibold text-foreground',
        dim,
        size === 'lg' ? 'text-lg' : 'text-sm',
        logo.bg || 'bg-muted/50',
        logo.fg,
      )}
    >
      {(logo.letter || '?').slice(0, 2)}
    </div>
  );
}

export function IntegrationLogo({
  logo,
  letter,
  bg,
  fg,
  size = 'lg',
}: {
  logo?: IntegrationLogoSpec;
  letter?: string;
  bg?: string;
  fg?: string;
  size?: 'lg' | 'md';
}) {
  const resolved: IntegrationLogoSpec =
    logo ??
    ({
      kind: 'letter',
      letter: letter || '?',
      bg: bg || 'bg-muted/50',
      fg: fg || 'text-foreground',
    });
  return <BrandLogo logo={resolved} size={size} />;
}

interface ActionDescriptor {
  primary: boolean;
  icon: LucideIcon;
  label: string;
}

function actionFor(item: IntegrationItem, busy: boolean | undefined): ActionDescriptor {
  if (busy) {
    return { primary: false, icon: Loader2, label: 'Working…' };
  }
  if (item.kind === 'account-facet') {
    if (item.connected) {
      return { primary: false, icon: Check, label: 'Connected' };
    }
    return { primary: true, icon: Plus, label: 'Connect' };
  }
  switch (item.status) {
    case 'running':
      return { primary: false, icon: Pencil, label: 'Manage' };
    case 'starting':
      return { primary: false, icon: Loader2, label: 'Starting…' };
    case 'error':
      return { primary: true, icon: RotateCw, label: 'Restart' };
    case 'disabled':
      return { primary: true, icon: Plus, label: 'Enable' };
    default:
      return { primary: false, icon: Pencil, label: 'Manage' };
  }
}
