import { Plus, Check, Loader2, BadgeCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  catalogCapabilityLabel,
  type IntegrationCatalogEntry,
} from '../integrationDirectory';
import { brandIconStyle, resolveBrandIcon } from './brandIcons';

interface DirectoryCardProps {
  entry: IntegrationCatalogEntry;
  installed: boolean;
  busy: boolean;
  /** Backend view of this recipe: which launcher it needs, and whether it exists here. */
  launcher?: { command?: string; launcherAvailable?: boolean };
  onSelect: () => void;
}

/** Single catalog tile in the Add Integrations grid — opens detail on click. */
export function DirectoryCard({
  entry,
  installed,
  busy,
  launcher,
  onSelect,
}: DirectoryCardProps) {
  const Icon = resolveBrandIcon(entry.brand);
  /* A recipe whose launcher is missing cannot start on this machine. Say so
   * on the tile, where the choice is made — not only after the click. */
  const launcherMissing = launcher?.launcherAvailable === false;
  const launcherCommand = launcher?.command || entry.mcp?.command || '';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group flex w-full flex-col rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 text-left transition',
        'hover:border-white/[0.12] hover:bg-white/[0.05]',
        'focus:outline-none focus:ring-1 focus:ring-primary/40',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.06]">
          <Icon className="size-5" style={brandIconStyle(entry.brand)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-foreground">
              {entry.name}
            </span>
            {entry.verified && (
              <BadgeCheck className="size-3 shrink-0 text-muted-foreground" />
            )}
            {installed && (
              <span className="rounded bg-success/15 px-1.5 py-px text-2xs font-medium text-success-fg">
                Added
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {entry.tagline}
          </p>
          {launcherMissing && (
            <p className="mt-1 text-2xs font-medium text-destructive">
              Cannot run here — no {launcherCommand} on PATH
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        {/* The state is said in words here, not only carried by a badge —
            "Sign-in only" is the difference between a credential and a
            capability. */}
        <span className="text-2xs text-muted-foreground">
          {catalogCapabilityLabel(entry.capability)} · {entry.developer}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-2xs font-medium',
            installed
              ? 'bg-white/[0.06] text-muted-foreground'
              : 'bg-primary/15 text-primary',
          )}
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : installed ? (
            <Check className="size-3" />
          ) : (
            <Plus className="size-3" />
          )}
          {installed ? 'Added' : 'View'}
        </span>
      </div>
    </button>
  );
}
