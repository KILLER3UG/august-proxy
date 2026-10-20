/* All models view — the whole catalog, one row per model.
 *
 * It was a card grid: a rounded card per model, a hover-revealed pin, and
 * nothing else. The reference is a LIST — a row per model, a context-window
 * chip, and a right-aligned cluster of four actions (pin · test · edit ·
 * delete). The row itself already existed (`ModelRow`, the provider's own
 * model list), so this view renders THAT rather than a second card: one model
 * row, used by both lists, so a model pinned in one is the same row in the
 * other.
 *
 * Provider groups are kept (the reference's flat list is not adopted), and
 * within a group the order is pinned → free → name — the same rule the
 * provider's own list uses, so one model cannot sit in two places at once.
 */

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  Search,
  Asterisk,
  Server,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { providersApi, type Provider } from '@/api/providers';
import { WorkspaceEmptyState } from '@/components/workspace/WorkspaceEmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import { compareProviderModels } from './modelSettingsShared';
import { ModelRow } from './ModelRow';

/**
 * How many rows ONE provider group renders.
 *
 * This tab is the only surface that mounts the whole catalog in one tree: the
 * catalog on the machine this was measured on holds 982 models across four
 * providers (OpenRouter 470, KiloCode 402, B.A.I 61, OpenCode Zen 49), and
 * every row carries an edit dialog, a test flow and a delete confirmation.
 * A provider's own model list is bounded by one provider and already mounts
 * 470 of them, so the cost is not new — but the WHOLE catalog in one tree is,
 * and the cap is what keeps it honest.
 *
 * The filter above the list searches ids, names and provider names, so a
 * capped-out model is one query away, and the footer says exactly what was
 * held back rather than quietly truncating.
 */
const GROUP_ROW_CAP = 100;

export function AllModelsTab() {
  const qc = useQueryClient();
  const listQ = useQuery({
    queryKey: ['ws-providers'],
    queryFn: () => providersApi.list(),
  });
  const [query, setQuery] = useState('');
  const [discovering, setDiscovering] = useState(false);

  // Memoised, not `listQ.data ?? []` inline: an empty array is a NEW object
  // on every render, so every memo keyed on it would rebuild on every render
  // — which is how a 982-model catalog turns into a re-sort on each keystroke.
  const providers = useMemo(() => listQ.data ?? [], [listQ.data]);

  /** Provider groups, each ordered by the shared rule, each filtered by the
   *  query. The provider's own model list sorts the same way, so the same
   *  model is in the same place in both. */
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers.map((provider) => {
      const models = [...(provider.models ?? [])].sort(compareProviderModels);
      const filtered = q
        ? models.filter(
            (m) =>
              m.id.toLowerCase().includes(q) ||
              (m.name ?? '').toLowerCase().includes(q) ||
              provider.name.toLowerCase().includes(q) ||
              provider.id.toLowerCase().includes(q),
          )
        : models;
      return { provider, models: filtered };
    });
  }, [providers, query]);

  const totalModels = useMemo(
    () => providers.reduce((n, p) => n + (p.models?.length ?? 0), 0),
    [providers],
  );
  const totalVisible = useMemo(
    () => groups.reduce((n, g) => n + g.models.length, 0),
    [groups],
  );
  const fetchedCount = useMemo(
    () =>
      providers.reduce(
        (n, p) => n + (p.models ?? []).filter((m) => m.source === 'fetched').length,
        0,
      ),
    [providers],
  );
  const manualCount = useMemo(
    () =>
      providers.reduce(
        (n, p) => n + (p.models ?? []).filter((m) => m.source === 'manual').length,
        0,
      ),
    [providers],
  );
  const reasoningCount = useMemo(
    () =>
      providers.reduce(
        (n, p) => n + (p.models ?? []).filter((m) => m.reasoning).length,
        0,
      ),
    [providers],
  );

  /** Every mutation on a row — pin, edit, delete — pushes the change to the
   *  rest of the app: the composer dropdown, the aliases, the fleet and the
   *  provider list all read the same catalog. */
  const invalidate = useCallback(() => {
    void refreshProviderCatalog(qc);
  }, [qc]);

  const refreshAll = useMutation({
    mutationFn: async () => {
      const list = (listQ.data ?? []).filter(
        (p) => p.enabled && p.apiKeySet && p.baseUrl,
      );
      const results: Array<{ provider: string; added: number; updated: number; removed: number; error?: string }> = [];
      for (const p of list) {
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
    <div className="space-y-3 flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Summary + actions */}
      <div className="rounded-xl border border-border/60 bg-card/60 p-4 flex items-center justify-between gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-6 flex-wrap">
          <div>
            <p className="text-2xs uppercase tracking-wider text-muted-foreground">All models</p>
            <p className="text-xl font-semibold tabular-nums">{totalModels.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wider text-muted-foreground">Discovered</p>
            <p className="text-xl font-semibold tabular-nums text-blue-400">{fetchedCount.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wider text-muted-foreground">Manual</p>
            <p className="text-xl font-semibold tabular-nums">{manualCount.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wider text-muted-foreground">Reasoning</p>
            <p className="text-xl font-semibold tabular-nums text-warning">{reasoningCount.toLocaleString()}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
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
            title="Fetch each provider's baseUrl/models and merge into the catalog"
          >
            {discovering || refreshAll.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Asterisk className="size-3" />
            )}
            {discovering || refreshAll.isPending ? 'Discovering…' : 'Discover all'}
          </Button>
        </div>
      </div>

      {totalModels === 0 ? (
        <WorkspaceEmptyState
          icon={Boxes}
          title="No models yet"
          description={
            providersDiscoverable(listQ.data ?? [])
              ? 'Click Discover all to fetch baseUrl/models from every configured provider. Manual models can also be added per provider.'
              : 'No providers configured yet. Add a provider first, then discover models.'
          }
          action={
            providersDiscoverable(listQ.data ?? []) ? (
              <Button onClick={startDiscoverAll}>
                <Asterisk className="size-3" /> Discover all
              </Button>
            ) : null
          }
          className="py-8"
        />
      ) : totalVisible === 0 ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center text-sm text-muted-foreground">
          No models match &quot;{query}&quot;.
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1">
          {groups.map((g) => {
            const shown = g.models.slice(0, GROUP_ROW_CAP);
            const held = g.models.length - shown.length;
            return (
              <section key={g.provider.id} className="mb-4">
                {/* The group label: a quiet uppercase muted name, the gateway
                    id beside it, the count at the far right. */}
                <div className="flex items-center gap-2 px-0.5 pb-1.5">
                  <Server className="size-3 shrink-0 text-muted-foreground/60" />
                  <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {g.provider.name}
                  </h4>
                  <span className="text-2xs font-mono text-muted-foreground/50">{g.provider.id}</span>
                  {!g.provider.enabled && (
                    <span className="rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                      disabled
                    </span>
                  )}
                  <span className="ml-auto text-2xs font-mono text-muted-foreground/60">
                    {g.models.length} model{g.models.length === 1 ? '' : 's'}
                  </span>
                </div>
                {/* The rows. Hairline-separated, no card chrome, and the
                    reference's action cluster lives on each row. */}
                <div className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60 bg-card/30">
                  {shown.map((m) => (
                    <ModelRow
                      key={m.id}
                      providerId={g.provider.id}
                      model={m}
                      onChanged={invalidate}
                    />
                  ))}
                </div>
                {held > 0 && (
                  <p className="px-0.5 pt-1.5 text-2xs text-muted-foreground">
                    Showing the first {GROUP_ROW_CAP} of {g.models.length} models — filter
                    to narrow.
                  </p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function providersDiscoverable(providers: Provider[]): boolean {
  return providers.some((p) => p.enabled && p.apiKeySet && !!p.baseUrl);
}
