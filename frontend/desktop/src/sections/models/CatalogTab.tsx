import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Search } from 'lucide-react';
import {
  getAggregatedModels,
  isFreeModelId,
  type AggregatedModel,
} from '@/api/api-client';
import { EmptyState } from './modelsShared';

function CatalogCard({ m }: { m: AggregatedModel }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 transition hover:border-white/[0.12] hover:bg-card">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium font-mono text-foreground break-all leading-snug">{m.id}</p>
        {m.isFree && (
          <Badge variant="outline" className="shrink-0 text-[9px] border-success/40 text-success">
            free
          </Badge>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {m.supportsReasoning && (
          <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-muted-foreground">
            reasoning
          </span>
        )}
        {m.supportsThinking && (
          <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-muted-foreground">
            thinking
          </span>
        )}
        {m.contextWindow ? (
          <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
            {(m.contextWindow / 1000).toFixed(0)}k ctx
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Paginated provider-grouped model catalog with free-first sort. */
export function CatalogTab() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;
  const { data: _skeletonData } = useQuery({
    queryKey: ['aggregated-models-skeleton'],
    queryFn: () => getAggregatedModels({ skeleton: true }),
    staleTime: 30_000,
  });
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['aggregated-models', page],
    queryFn: () => getAggregatedModels({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  });
  const showSkeleton = isLoading || (isFetching && (data?.models?.length ?? 0) === 0);

  // Free models first, then alphabetical — mirrors the server sort but
  // applied client-side so the search filter stays stable.
  const grouped = useMemo(() => {
    const all = (data?.models ?? []).map((m) => ({ ...m, isFree: m.isFree ?? isFreeModelId(m.id) }));
    const filtered = q
      ? all.filter((m) => `${m.id} ${m.provider}`.toLowerCase().includes(q.toLowerCase()))
      : all;
    filtered.sort((a, b) => {
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
      return (a.id || '').localeCompare(b.id || '');
    });
    const byProvider = new Map<string, AggregatedModel[]>();
    for (const m of filtered) {
      if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
      byProvider.get(m.provider)!.push(m);
    }
    // Sort providers so free-heavy ones float up.
    return Array.from(byProvider.entries()).sort(([, a], [, b]) => {
      const fa = a.filter((m) => m.isFree).length;
      const fb = b.filter((m) => m.isFree).length;
      if (fa !== fb) return fb - fa;
      return (a[0]?.provider || '').localeCompare(b[0]?.provider || '');
    });
  }, [data, q]);

  const total = grouped.reduce((sum, [, list]) => sum + list.length, 0);
  const freeCount = grouped.reduce((sum, [, list]) => sum + list.filter((m) => m.isFree).length, 0);

  if (isLoading || showSkeleton) return (
    <div className="space-y-2 p-3" data-testid="models-skeleton">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
        Warming model cache…
      </div>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="h-10 rounded-md bg-muted/30 animate-pulse" />
      ))}
    </div>
  );

  return (
    <div className="space-y-5 h-full flex flex-col">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search models…"
            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/30"
          />
        </div>
        <span className="text-[11px] text-muted-foreground font-mono shrink-0">
          {total} models · {freeCount} free
        </span>
      </div>
      {total === 0 ? (
        <EmptyState label="No models available — configure a provider API key to populate the list" />
      ) : (
        <div className="space-y-6 flex-1 overflow-auto">
          {grouped.map(([provider, list]) => (
            <section key={provider} className="space-y-3">
              <div className="flex items-center gap-2 px-0.5">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {provider}
                </h4>
                <span className="text-[10px] font-mono text-muted-foreground/70">
                  {list.filter((m) => m.isFree).length}/{list.length} free
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {list.map((m) => (
                  <CatalogCard key={`${provider}-${m.id}`} m={m} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {data?.hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPage((p) => p + 1)}
            disabled={isFetching}
          >
            {isFetching ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
