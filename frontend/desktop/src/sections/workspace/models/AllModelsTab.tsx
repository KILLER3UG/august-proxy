/* All models view — flat catalog of every model across providers.
 * Supports search/filter, per-provider grouping, and Discover all (refresh
 * /v1/models on each configured provider and merge into the catalog).
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  Search,
  Sparkles,
  Server,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { providersApi, type Provider } from '@/api/providers';
import { WorkspaceEmptyState } from '@/components/workspace/WorkspaceEmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import { fmtContextWindow } from './modelSettingsShared';

interface AllModelRow {
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  free?: boolean;
  source: 'manual' | 'fetched';
  providerId: string;
  providerName: string;
  enabled: boolean;
  apiKeySet: boolean;
  baseUrl: string;
}

export function AllModelsTab() {
  const qc = useQueryClient();
  const listQ = useQuery({
    queryKey: ['ws-providers'],
    queryFn: () => providersApi.list(),
  });
  const [query, setQuery] = useState('');
  const [discovering, setDiscovering] = useState(false);

  const rows = useMemo<AllModelRow[]>(() => {
    const out: AllModelRow[] = [];
    for (const p of listQ.data ?? []) {
      for (const m of p.models ?? []) {
        out.push({
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          reasoning: !!m.reasoning,
          free: !!m.free,
          source: m.source,
          providerId: p.id,
          providerName: p.name,
          enabled: !!p.enabled,
          apiKeySet: !!p.apiKeySet,
          baseUrl: p.baseUrl,
        });
      }
    }
    out.sort((a, b) => {
      if (a.providerName !== b.providerName) return a.providerName.localeCompare(b.providerName);
      return a.id.localeCompare(b.id);
    });
    return out;
  }, [listQ.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.id.toLowerCase().includes(q) ||
        (r.name?.toLowerCase().includes(q) ?? false) ||
        r.providerName.toLowerCase().includes(q) ||
        r.providerId.toLowerCase().includes(q),
    );
  }, [rows, query]);

  // Group filtered rows by provider for display
  const grouped = useMemo(() => {
    const map = new Map<string, AllModelRow[]>();
    for (const r of filtered) {
      if (!map.has(r.providerId)) map.set(r.providerId, []);
      map.get(r.providerId)!.push(r);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const totalModels = rows.length;
  const fetchedCount = rows.filter((r) => r.source === 'fetched').length;
  const manualCount = rows.filter((r) => r.source === 'manual').length;
  const reasoningCount = rows.filter((r) => r.reasoning).length;

  const refreshAll = useMutation({
    mutationFn: async () => {
      const providers = (listQ.data ?? []).filter(
        (p) => p.enabled && p.apiKeySet && p.baseUrl,
      );
      const results: Array<{ provider: string; added: number; updated: number; removed: number; error?: string }> = [];
      for (const p of providers) {
        try {
          const res = await providersApi.refreshModels(p.id);
          results.push({ provider: p.name, added: res.added.length, updated: res.updated.length, removed: res.removed.length });
        } catch (e: unknown) {
          results.push({
            provider: p.name,
            added: 0,
            updated: 0,
            removed: 0,
            error: e instanceof Error ? e.message : 'refresh failed',
          });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      const ok = results.filter((r) => !r.error);
      const fail = results.filter((r) => r.error);
      if (ok.length) {
        const totalAdded = ok.reduce((s, r) => s + r.added, 0);
        const totalUpdated = ok.reduce((s, r) => s + r.updated, 0);
        toast.success(
          `Discovered: +${totalAdded} new, ${totalUpdated} updated across ${ok.length} provider${ok.length === 1 ? '' : 's'}`,
        );
      }
      if (fail.length) {
        toast.error(`Failed for ${fail.length} provider${fail.length === 1 ? '' : 's'}: ${fail.map((f) => f.provider).join(', ')}`);
      }
      void refreshProviderCatalog(qc).finally(() => setDiscovering(false));
    },
    onError: () => {
      setDiscovering(false);
      toast.error('Discover all failed');
    },
  });

  function startDiscoverAll() {
    if (!providersDiscoverable(listQ.data ?? [])) {
      toast.error('No providers are configured yet. Add a provider and a key first.');
      return;
    }
    setDiscovering(true);
    refreshAll.mutate();
  }

  return (
    <div className="space-y-3 h-full flex flex-col">
      {/* Summary + actions */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 flex items-center justify-between gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-6 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">All models</p>
            <p className="text-xl font-semibold tabular-nums">{totalModels.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Discovered</p>
            <p className="text-xl font-semibold tabular-nums text-blue-400">{fetchedCount.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Manual</p>
            <p className="text-xl font-semibold tabular-nums">{manualCount.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Reasoning</p>
            <p className="text-xl font-semibold tabular-nums text-warning">{reasoningCount.toLocaleString()}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by id, name, or provider…"
              aria-label="Filter models"
              className="pl-7 w-64"
            />
          </div>
          <Button
            onClick={startDiscoverAll}
            disabled={discovering || refreshAll.isPending}
            title="Fetch every provider's /v1/models and merge into the catalog"
          >
            {discovering || refreshAll.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {discovering || refreshAll.isPending ? 'Discovering…' : 'Discover all'}
          </Button>
        </div>
      </div>

      {/* Card grid (skills / integrations style — no heavy white rules) */}
      {totalModels === 0 ? (
        <WorkspaceEmptyState
          icon={Boxes}
          title="No models yet"
          description={
            providersDiscoverable(listQ.data ?? [])
              ? 'Click Discover all to fetch /v1/models from every configured provider. Manual models can also be added per provider.'
              : 'No providers configured yet. Add a provider first, then discover models.'
          }
          action={
            providersDiscoverable(listQ.data ?? []) ? (
              <Button onClick={startDiscoverAll}>
                <Sparkles className="size-3.5" /> Discover all
              </Button>
            ) : null
          }
          className="py-8"
        />
      ) : grouped.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-card/40 p-8 text-center text-sm text-muted-foreground">
          No models match &quot;{query}&quot;.
        </div>
      ) : (
        <div className="space-y-6 flex-1 overflow-auto">
          {grouped.map(([providerId, providerRows]) => {
            const first = providerRows[0];
            return (
              <section key={providerId} className="space-y-3">
                <div className="flex items-center gap-2 px-0.5">
                  <Server className="size-3.5 text-muted-foreground" />
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {first.providerName}
                  </h4>
                  <span className="text-[10px] font-mono text-muted-foreground/60">{providerId}</span>
                  {!first.enabled && (
                    <span className="rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      disabled
                    </span>
                  )}
                  <span className="ml-auto text-[10px] font-mono text-muted-foreground/70">
                    {providerRows.length} model{providerRows.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {providerRows.map((r) => (
                    <AllModelCard key={`${r.providerId}::${r.id}`} row={r} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AllModelCard({ row }: { row: AllModelRow }) {
  const ctx = fmtContextWindow(row.contextWindow);
  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 transition hover:border-white/[0.12] hover:bg-card">
      <p className="text-sm font-medium font-mono text-foreground break-all leading-snug">
        {row.name || row.id}
      </p>
      {row.name && row.name !== row.id && (
        <p className="mt-0.5 text-[10px] font-mono text-muted-foreground/70 truncate">{row.id}</p>
      )}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {ctx && (
          <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
            {ctx} ctx
          </span>
        )}
        <span
          className={cn(
            'rounded-md px-1.5 py-0.5 text-[10px] font-mono',
            row.source === 'fetched'
              ? 'bg-sky-500/15 text-sky-300'
              : 'bg-white/[0.04] text-muted-foreground',
          )}
        >
          {row.source}
        </span>
        {row.reasoning && (
          <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-[10px] font-mono text-warning">
            reasoning
          </span>
        )}
        {row.free && (
          <span className="rounded-md border border-success/30 px-1.5 py-0.5 text-[10px] text-success">
            free
          </span>
        )}
      </div>
    </div>
  );
}

function providersDiscoverable(providers: Provider[]): boolean {
  return providers.some((p) => p.enabled && p.apiKeySet && !!p.baseUrl);
}
