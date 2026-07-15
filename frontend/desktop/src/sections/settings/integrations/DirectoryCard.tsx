import { Plus, Check, Loader2, BadgeCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { IntegrationCatalogEntry } from '../integrationDirectory';
import { brandIconStyle, resolveBrandIcon } from './brandIcons';

interface DirectoryCardProps {
  entry: IntegrationCatalogEntry;
  installed: boolean;
  busy: boolean;
  onSelect: () => void;
}

/** Single catalog tile in the Add Integrations grid — opens detail on click. */
export function DirectoryCard({
  entry,
  installed,
  busy,
  onSelect,
}: DirectoryCardProps) {
  const Icon = resolveBrandIcon(entry.brand);

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
              <BadgeCheck className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {installed && (
              <span className="rounded bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium text-emerald-400">
                Added
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {entry.tagline}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground">
          {entry.kind === 'mcp-extension' ? 'MCP' : 'Account'} · {entry.developer}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium',
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
