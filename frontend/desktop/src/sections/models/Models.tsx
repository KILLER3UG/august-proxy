import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, Boxes, ArrowRightLeft, Calculator, Inbox, Gauge, Tag, Plus, Trash2, Save, RefreshCw, Power } from 'lucide-react';
import { quotaApi, type ModelQuota } from '@/api/quota';
import {
  getModelCatalog,
  getModelCapabilities,
  getModelAliases,
  estimateModelCost,
  getAggregatedModels,
  getUserModelAliases,
  updateUserModelAliases,
  restartBackend,
  isFreeModelId,
  type CatalogModel,
  type ModelAlias,
  type ModelCostEstimate,
  type AggregatedModel,
  type UserModelAlias,
} from '@/api/api-client';

type Tab = 'catalog' | 'capabilities' | 'aliases' | 'user-aliases' | 'cost' | 'quotas';

const TABS: { key: Tab; label: string; Icon: typeof Boxes }[] = [
  { key: 'catalog', label: 'Catalog', Icon: Boxes },
  { key: 'capabilities', label: 'Capabilities', Icon: Search },
  { key: 'aliases', label: 'Aliases', Icon: ArrowRightLeft },
  { key: 'user-aliases', label: 'User Aliases', Icon: Tag },
  { key: 'cost', label: 'Cost estimator', Icon: Calculator },
  { key: 'quotas', label: 'Per-model quota', Icon: Gauge },
];

export function Models() {
  const [tab, setTab] = useState<Tab>('catalog');

  return (
    <div className="p-6 space-y-4 flex flex-col h-full">
      <SectionHeader
        title="Models"
        subtitle="All models from every configured provider. Models are listed under the provider that serves them — e.g. deepseek/kimi models appear under opencode-zen when served through it."
        actions={
          <div className="flex items-center gap-1 text-[10px]">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-md px-2 py-1 font-mono transition inline-flex items-center gap-1 ${
                  tab === t.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                <t.Icon className="size-3" /> {t.label}
              </button>
            ))}
          </div>
        }
      />
      <div className="flex-1 min-h-0">
        {tab === 'catalog' && <CatalogTab />}
        {tab === 'capabilities' && <CapabilitiesTab />}
        {tab === 'aliases' && <AliasesTab />}
        {tab === 'user-aliases' && <UserAliasesTab />}
        {tab === 'cost' && <CostTab />}
        {tab === 'quotas' && <QuotasTab />}
      </div>
    </div>
  );
}

function CatalogTab() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;
  const { data: skeletonData } = useQuery({
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
    <div className="space-y-3 h-full flex flex-col">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search models across all providers…"
            className="pl-7"
          />
        </div>
        <span className="text-[10px] text-muted-foreground font-mono shrink-0">
          {total} models · {freeCount} free
        </span>
      </div>
      {total === 0 ? (
        <EmptyState label="No models available — configure a provider API key to populate the list" />
      ) : (
        <Card className="flex-1 overflow-auto">
          <div className="divide-y divide-border/40">
            {grouped.map(([provider, list]) => (
              <div key={provider}>
                <div className="sticky top-0 z-10 bg-popover/95 backdrop-blur px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground font-semibold border-b border-border/40">
                  {provider}
                  <span className="ml-2 text-[9px] lowercase font-mono text-muted-foreground/60">
                    {list.filter((m) => m.isFree).length}/{list.length} free
                  </span>
                </div>
                {list.map((m) => (
                  <CatalogRow key={`${provider}-${m.id}`} m={m} />
                ))}
              </div>
            ))}
          </div>
        </Card>
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

function CatalogRow({ m }: { m: AggregatedModel }) {
  return (
    <div className="px-3 py-2.5 flex items-start gap-3 hover:bg-accent/20">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium font-mono">{m.id}</span>
          {m.isFree && (
            <Badge variant="outline" className="text-[9px] border-success/50 text-success">free</Badge>
          )}
          {m.supportsReasoning && (
            <Badge variant="outline" className="text-[9px]">reasoning</Badge>
          )}
          {m.supportsThinking && (
            <Badge variant="outline" className="text-[9px]">thinking</Badge>
          )}
        </div>
        {m.contextWindow ? (
          <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
            {(m.contextWindow / 1000).toFixed(0)}k context
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CapabilitiesTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['model-capabilities'],
    queryFn: () => getModelCapabilities(),
  });
  const caps = data?.capabilities ?? [];
  if (isLoading) return <div className="text-sm text-muted-foreground p-6">Loading…</div>;
  if (caps.length === 0) return <EmptyState label="No capabilities registered" />;
  return (
    <Card className="p-4">
      <CardHeader className="p-0 mb-3">
        <CardTitle className="text-sm">Available capabilities</CardTitle>
      </CardHeader>
      <CardContent className="p-0 flex flex-wrap gap-2">
        {caps.map((c) => (
          <Badge key={c} variant="outline">{c}</Badge>
        ))}
      </CardContent>
    </Card>
  );
}

function AliasesTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['model-aliases'],
    queryFn: () => getModelAliases(),
  });
  const aliases = data?.aliases ?? [];
  if (isLoading) return <div className="text-sm text-muted-foreground p-6">Loading…</div>;
  if (aliases.length === 0) return <EmptyState label="No model aliases defined" />;
  return (
    <Card className="overflow-auto">
      <div className="grid grid-cols-[1fr_24px_1fr_120px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border font-mono">
        <span>Alias</span><span /><span>Resolves to</span><span>Provider</span>
      </div>
      <div className="divide-y divide-border/40">
        {aliases.map((a: ModelAlias) => (
          <div key={a.alias} className="grid grid-cols-[1fr_24px_1fr_120px] gap-2 px-3 py-2 text-xs items-center font-mono">
            <span className="truncate">{a.alias}</span>
            <ArrowRightLeft className="size-3 text-muted-foreground/50" />
            <span className="truncate text-foreground">{a.resolvesTo}</span>
            <span className="text-muted-foreground truncate">{a.provider}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function UserAliasesTab() {
  const { data: aliasData, isLoading: aliasesLoading } = useQuery({
    queryKey: ['user-model-aliases'],
    queryFn: () => getUserModelAliases(),
  });
  const { data: modelsData, refetch: refetchModels } = useQuery({
    queryKey: ['aggregated-models'],
    queryFn: () => getAggregatedModels(),
  });

  const [aliases, setAliases] = useState<UserModelAlias[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Initialise from server data once loaded.
  if (!dirty && aliasData && aliases.length === 0 && aliasData.aliases.length > 0) {
    setAliases(aliasData.aliases);
  }

  const availableModels = useMemo(() => {
    const all = modelsData?.models ?? [];
    // Deduplicate by id so the dropdown is clean.
    const seen = new Set<string>();
    return all.filter((m) => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
  }, [modelsData]);

  function addAlias() {
    setAliases((prev) => [...prev, { alias: '', targetModel: '', targetProvider: '' }]);
    setDirty(true);
  }

  function updateAlias(index: number, field: keyof UserModelAlias, value: string) {
    setAliases((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      // Auto-fill provider when target model changes.
      if (field === 'targetModel') {
        const model = availableModels.find((m) => m.id === value);
        if (model) next[index].targetProvider = model.provider;
      }
      return next;
    });
    setDirty(true);
  }

  function removeAlias(index: number) {
    setAliases((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const valid = aliases.filter((a) => a.alias.trim() && a.targetModel.trim());
      await updateUserModelAliases(valid);
      setDirty(false);
    } catch (e) {
      console.error('Failed to save aliases:', e);
    } finally {
      setSaving(false);
    }
  }

  async function handleRestart() {
    if (!window.confirm('Restart the backend? This will briefly interrupt active requests.')) return;
    setRestarting(true);
    try {
      await restartBackend();
    } catch {
      // Backend will disconnect — that's expected.
    } finally {
      setRestarting(false);
    }
  }

  if (aliasesLoading) return <div className="text-sm text-muted-foreground p-6">Loading…</div>;

  return (
    <div className="space-y-3 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Define custom model IDs that route to your chosen backend models. These will appear in the model list and can be selected in the chat dropdown.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={() => refetchModels()} title="Refresh model list">
            <RefreshCw className="size-3" /> Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={addAlias}>
            <Plus className="size-3" /> Add alias
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            <Save className="size-3" /> {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="destructive" onClick={handleRestart} disabled={restarting} title="Restart backend to pick up all changes">
            <Power className="size-3" /> {restarting ? 'Restarting…' : 'Restart'}
          </Button>
        </div>
      </div>

      {aliases.length === 0 ? (
        <EmptyState label="No user-defined aliases yet — click 'Add alias' to create one." />
      ) : (
        <Card className="overflow-auto flex-1">
          <div className="grid grid-cols-[1fr_2fr_100px_36px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border font-mono">
            <span>Alias name</span>
            <span>Target model</span>
            <span>Provider</span>
            <span />
          </div>
          <div className="divide-y divide-border/40">
            {aliases.map((a, i) => (
              <div key={i} className="grid grid-cols-[1fr_2fr_100px_36px] gap-2 px-3 py-2 text-xs items-center font-mono">
                <Input
                  value={a.alias}
                  onChange={(e) => updateAlias(i, 'alias', e.target.value)}
                  placeholder="my-fake-model"
                  className="h-7 text-xs font-mono"
                />
                <select
                  value={a.targetModel}
                  onChange={(e) => updateAlias(i, 'targetModel', e.target.value)}
                  className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="" disabled>Select a model…</option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}{m.isFree ? ' (free)' : ''}
                    </option>
                  ))}
                </select>
                <span className="text-muted-foreground truncate text-[10px]">{a.targetProvider || '—'}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => removeAlias(i)}
                  className="text-destructive/60 hover:text-destructive"
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function CostTab() {
  const [modelId, setModelId] = useState('');
  const [inputTokens, setInputTokens] = useState('1000');
  const [outputTokens, setOutputTokens] = useState('500');

  const estimate = useMutation<ModelCostEstimate>({
    mutationFn: () =>
      estimateModelCost(modelId, Number(inputTokens) || 0, Number(outputTokens) || 0),
  });

  return (
    <div className="space-y-4 max-w-xl">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Model ID</label>
            <Input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="e.g. claude-sonnet-4-5"
              className="mt-1 font-mono text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Input tokens</label>
              <Input
                value={inputTokens}
                onChange={(e) => setInputTokens(e.target.value)}
                type="number"
                className="mt-1 font-mono text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Output tokens</label>
              <Input
                value={outputTokens}
                onChange={(e) => setOutputTokens(e.target.value)}
                type="number"
                className="mt-1 font-mono text-sm"
              />
            </div>
          </div>
          <Button
            size="sm"
            disabled={!modelId.trim() || estimate.isPending}
            onClick={() => estimate.mutate()}
          >
            <Calculator className="size-3" /> Estimate cost
          </Button>
        </CardContent>
      </Card>

      {estimate.data && (
        <Card>
          <CardContent className="p-4 space-y-2">
            {estimate.data.error ? (
              <p className="text-sm text-destructive">{estimate.data.error}</p>
            ) : (
              <>
                <Row label="Model" value={estimate.data.model} />
                <div className="border-t border-border pt-2">
                  <Row label="Total" value={`$${(estimate.data.cost || 0).toFixed(6)}`} strong />
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono tabular-nums ${strong ? 'font-semibold' : ''}`}>{value}</span>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <Card className="border-dashed">
      <CardContent className="p-10 grid place-items-center text-center text-muted-foreground">
        <Inbox className="size-8 text-muted-foreground/40 mb-2" />
        <p className="text-sm">{label}</p>
      </CardContent>
    </Card>
  );
}

function formatQuotaNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** Per-provider / per-model daily quota cards. */
function QuotasTab() {
  const all = useQuery({
    queryKey: ['quota', 'all'],
    queryFn: () => quotaApi.all(),
    refetchInterval: 30_000,
  });

  if (all.isLoading) return <div className="text-sm text-muted-foreground">Loading quota…</div>;
  const data = all.data?.results || [];

  if (data.length === 0) {
    return (
      <EmptyState label="No quota data yet. Once adapters record usage, your daily model quotas will appear here." />
    );
  }

  return (
    <div className="space-y-4 overflow-auto">
      {data.map(({ provider, quotas }) => (
        <Card key={provider}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">{provider}</CardTitle>
              <span className="text-[10px] text-muted-foreground font-mono">
                {quotas.length} model{quotas.length === 1 ? '' : 's'} · resets at {new Date(quotas[0]?.resetsAt || Date.now()).toUTCString().slice(17, 22)} UTC
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {quotas.map((q) => (
              <QuotaRow key={q.model} q={q} />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function QuotaRow({ q }: { q: ModelQuota }) {
  const hasLimit = q.limit != null && q.limit > 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-foreground truncate">{q.model || 'unknown'}</span>
          <Badge variant="outline" className="text-[9px] py-0 h-4">
            {q.source}
          </Badge>
        </div>
        <div className="font-mono tabular-nums text-muted-foreground shrink-0 text-[11px]">
          {hasLimit
            ? <><span className="text-foreground">{formatQuotaNumber(q.used)}</span> / {formatQuotaNumber(q.limit!)} ({q.percent.toFixed(1)}%)</>
            : <span className="text-foreground">{formatQuotaNumber(q.used)}</span>}
        </div>
      </div>
      {hasLimit && (
        <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${Math.max(1, Math.min(100, q.percent))}%`,
              backgroundColor: q.percent > 90 ? '#f87171' : q.percent > 70 ? '#f59e0b' : '#4ade80',
            }}
          />
        </div>
      )}
    </div>
  );
}
