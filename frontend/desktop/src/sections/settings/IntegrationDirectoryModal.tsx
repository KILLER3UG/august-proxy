/* ── Add Integrations modal — directory of installable extensions ──── */

import { useMemo, useState } from 'react';
import {
  X,
  Search,
  Plus,
  Check,
  Loader2,
  BadgeCheck,
  Package,
  Wrench,
  AlertTriangle,
} from 'lucide-react';
import { SiGithub, SiGoogle, SiSlack } from 'react-icons/si';
import { FolderOpen, Brain, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  INTEGRATION_DIRECTORY,
  type IntegrationCatalogEntry,
} from './integrationDirectory';
import { INTEGRATION_FIELD_CLASS } from './IntegrationsSection';

interface Props {
  open: boolean;
  onClose: () => void;
  installedIds: Set<string>;
  onAdd: (entry: IntegrationCatalogEntry) => Promise<void>;
  busyId?: string | null;
}

const BRAND_ICON: Record<
  string,
  React.ComponentType<{ className?: string; style?: React.CSSProperties }>
> = {
  google: SiGoogle,
  github: SiGithub,
  slack: SiSlack,
  filesystem: FolderOpen,
  memory: Brain,
  browser: Globe,
};

export function IntegrationDirectoryModal({
  open,
  onClose,
  installedIds,
  onAdd,
  busyId,
}: Props) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'account' | 'mcp'>('all');
  const [selected, setSelected] = useState<IntegrationCatalogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return INTEGRATION_DIRECTORY.filter((e) => {
      if (filter === 'account' && e.kind !== 'account-facet') return false;
      if (filter === 'mcp' && e.kind !== 'mcp-extension') return false;
      if (!ql) return true;
      return (
        e.name.toLowerCase().includes(ql) ||
        e.tagline.toLowerCase().includes(ql) ||
        e.description.toLowerCase().includes(ql) ||
        e.categories.some((c) => c.toLowerCase().includes(ql)) ||
        e.developer.toLowerCase().includes(ql)
      );
    });
  }, [q, filter]);

  if (!open) return null;

  const add = async (entry: IntegrationCatalogEntry) => {
    setError(null);
    try {
      await onAdd(entry);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add integration');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex h-[min(720px,90vh)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add integrations"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Add integrations</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Browse extensions for August. Add only what you need — Gmail and Calendar are separate.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Search + filters */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search directory…"
              className={cn('w-full py-2 pl-9 pr-3 text-sm', INTEGRATION_FIELD_CLASS)}
            />
          </div>
          {(['all', 'account', 'mcp'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-medium transition',
                filter === f
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/50 text-muted-foreground hover:text-foreground',
              )}
            >
              {f === 'all' ? 'All' : f === 'account' ? 'Accounts' : 'MCP extensions'}
            </button>
          ))}
        </div>

        {error && (
          <div className="mx-5 mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* Body: list + detail */}
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-5">
          <div className="min-h-0 overflow-auto border-r border-border md:col-span-2">
            {list.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">No matches.</p>
            ) : (
              <ul className="divide-y divide-border/60 p-2">
                {list.map((entry) => {
                  const installed = installedIds.has(entry.id);
                  const busy = busyId === entry.id;
                  const Icon = BRAND_ICON[entry.brand] ?? Package;
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(entry)}
                        className={cn(
                          'flex w-full items-start gap-3 rounded-xl p-3 text-left transition',
                          selected?.id === entry.id
                            ? 'bg-muted/60 ring-1 ring-primary/30'
                            : 'hover:bg-muted/40',
                        )}
                      >
                        <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-border/50 bg-muted/40">
                          <Icon
                            className="size-5"
                            style={
                              entry.brand === 'google'
                                ? { color: '#4285F4' }
                                : entry.brand === 'github'
                                  ? { color: '#E6EDF3' }
                                  : entry.brand === 'slack'
                                    ? { color: '#E01E5A' }
                                    : undefined
                            }
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-foreground">
                              {entry.name}
                            </span>
                            {entry.verified && (
                              <BadgeCheck className="size-3.5 text-muted-foreground" />
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
                        <span className="shrink-0">
                          {busy ? (
                            <Loader2 className="size-4 animate-spin text-muted-foreground" />
                          ) : installed ? (
                            <Check className="size-4 text-emerald-400" />
                          ) : (
                            <Plus className="size-4 text-muted-foreground" />
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="min-h-0 overflow-auto p-5 md:col-span-3">
            {!selected ? (
              <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
                <Package className="mb-2 size-8 opacity-40" />
                Select an integration to see details and add it to August.
              </div>
            ) : (
              <CatalogDetail
                entry={selected}
                installed={installedIds.has(selected.id)}
                busy={busyId === selected.id}
                onAdd={() => void add(selected)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CatalogDetail({
  entry,
  installed,
  busy,
  onAdd,
}: {
  entry: IntegrationCatalogEntry;
  installed: boolean;
  busy: boolean;
  onAdd: () => void;
}) {
  const tools = entry.tools ?? [];
  const shown = tools.slice(0, 8);
  const more = Math.max(0, tools.length - shown.length);

  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xl font-semibold text-foreground">{entry.name}</h3>
          {entry.verified && <BadgeCheck className="size-4 text-muted-foreground" />}
          {entry.isNew && (
            <span className="text-[11px] font-medium text-rose-400/90">New</span>
          )}
          {entry.isCommunity && (
            <Badge variant="outline" className="text-[10px]">
              Community
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{entry.tagline}</p>
      </div>

      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
        {entry.description}
      </p>

      {entry.packageName && (
        <p className="text-xs text-muted-foreground">
          Under the hood it uses{' '}
          <span className="font-mono text-foreground/80">
            {entry.packageName}
            {entry.packageVersion ? ` v${entry.packageVersion}` : ''}
          </span>
          .
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Developed by <span className="text-foreground/80">{entry.developer}</span>
      </p>

      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <AlertTriangle className="mb-1 inline size-3.5 text-amber-400/90" /> Only use extensions
        from developers you trust. August does not control third-party MCP tools and cannot verify
        they will work as intended or that they won&apos;t change.
      </div>

      {tools.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Wrench className="size-3.5" /> Tools
            <span className="font-mono font-normal text-muted-foreground">{tools.length}</span>
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {shown.map((t) => (
              <li
                key={t}
                className="rounded-md border border-border/50 bg-muted/30 px-2 py-0.5 font-mono text-[11px] text-foreground/90"
              >
                {t}
              </li>
            ))}
            {more > 0 && (
              <li className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground">
                +{more} more
              </li>
            )}
          </ul>
        </div>
      )}

      {entry.requirements && (
        <div>
          <p className="mb-1 text-xs font-semibold text-foreground">Requirements</p>
          <p className="text-xs text-muted-foreground">{entry.requirements}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {entry.categories.map((c) => (
          <Badge key={c} variant="outline" className="text-[10px]">
            {c}
          </Badge>
        ))}
      </div>

      <div className="pt-2">
        <Button onClick={onAdd} disabled={installed || busy} className="min-w-[140px]">
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : installed ? (
            <Check className="size-3.5" />
          ) : (
            <Plus className="size-3.5" />
          )}
          {installed ? 'Already added' : entry.kind === 'mcp-extension' ? 'Install' : 'Add'}
        </Button>
      </div>
    </div>
  );
}
