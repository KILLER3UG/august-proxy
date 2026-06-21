/* ── WorkspaceModelsSection — full Model settings CRUD ───────────────── */
/* Three subtabs in a top-level tab strip:
 *   • Providers — the existing two-column CRUD (left rail + per-provider
 *     editor) — every entry on the left comes from /api/providers. Shows
 *     a one-time "restart backend" hint when the list is empty so users
 *     discover that the built-in registry seed runs on backend startup.
 *   • Aliases — user-defined model aliases that route to a real model
 *     + provider. Replaces the lost "user-aliases" tab from the old
 *     Models.tsx. Stored in config.json via /api/config/model-aliases.
 *   • Quotas — per-model daily token usage. Uses QuotasPanel (lifted
 *     from the old Models section).
 *
 * API format options match the screenshot exactly:
 *   - Anthropic messages (/v1/messages)
 *   - Chat completions (/chat/completions)
 *   - Responses (/responses)
 *
 * All writes go through providersApi (Providers) or updateUserModelAliases
 * (Aliases). No hardcoded providers in the frontend — every entry comes
 * from the backend. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw,
  Plus,
  Trash2,
  Pencil,
  Eye,
  EyeOff,
  Check,
  Server,
  Loader2,
  ArrowRightLeft,
  Gauge,
  Boxes,
  Search,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  providersApi,
  type Provider,
  type ApiFormat,
} from '@/api/providers';
import {
  getUserModelAliases,
  updateUserModelAliases,
  getAggregatedModels,
  restartBackend,
  type UserModelAlias,
  type AggregatedModel,
} from '@/api/backend-ui';
import { WorkspaceField } from '@/components/workspace/WorkspaceField';
import { WorkspaceSelect } from '@/components/workspace/WorkspaceSelect';
import { WorkspaceToggle } from '@/components/workspace/WorkspaceToggle';
import { WorkspaceEmptyState } from '@/components/workspace/WorkspaceEmptyState';
import { WorkspaceTabs } from '@/components/workspace/WorkspaceTabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { QuotasPanel } from '@/sections/settings/QuotasPanel';
import { cn } from '@/lib/utils';

/* ── API format dropdown options — match the screenshot EXACTLY ──────── */
const API_FORMATS: { value: ApiFormat; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic messages (/v1/messages)' },
  { value: 'openai-chat', label: 'Chat completions (/chat/completions)' },
  { value: 'openai-responses', label: 'Responses (/responses)' },
];

const DEFAULT_API_FORMAT: ApiFormat = 'anthropic';

const SUBTABS: { key: 'providers' | 'aliases' | 'quotas' | 'all-models'; label: string; icon: LucideIcon }[] = [
  { key: 'providers', label: 'Providers', icon: Server },
  { key: 'all-models', label: 'All models', icon: Boxes },
  { key: 'aliases',   label: 'Aliases',   icon: ArrowRightLeft },
  { key: 'quotas',    label: 'Quotas',    icon: Gauge },
];

function fmtContextWindow(n?: number) {
  if (!n) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}

export function WorkspaceModelsSection() {
  const [subtab, setSubtab] = useState<'providers' | 'aliases' | 'quotas' | 'all-models'>('providers');

  return (
    <div className="px-8 py-6 space-y-4 h-full flex flex-col">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Model settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage custom model providers. Once configured, they can be selected during chat.
          </p>
        </div>
      </div>

      <div className="shrink-0">
        <WorkspaceTabs
          value={subtab}
          onChange={(k) => setSubtab(k as 'providers' | 'aliases' | 'quotas' | 'all-models')}
          items={SUBTABS}
          label="Model settings subtabs"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {subtab === 'providers' && <ProvidersTab />}
        {subtab === 'all-models' && <AllModelsTab />}
        {subtab === 'aliases'   && <AliasesTab />}
        {subtab === 'quotas'    && <QuotasTab />}
      </div>
    </div>
  );
}

/* ── Providers subtab — existing two-column CRUD ────────────────────── */

function ProvidersTab() {
  const qc = useQueryClient();
  const listQ = useQuery({
    queryKey: ['ws-providers'],
    queryFn: () => providersApi.list(),
  });
  const providers = listQ.data ?? [];

  const [mode, setMode] = useState<'add' | 'edit' | 'empty'>('empty');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAddModel, setShowAddModel] = useState(false);
  // Track whether the initial auto-select has happened so the effect
  // doesn't run again when the user clicks "Add provider" (which sets
  // selectedId to null) and immediately re-selects the first provider.
  const didInitRef = useRef(false);

  // Auto-select the first provider on the initial load only.
  useEffect(() => {
    if (didInitRef.current) return;
    if (listQ.isLoading) return;
    didInitRef.current = true;
    if (providers.length > 0) {
      setSelectedId(providers[0].id);
      setMode('edit');
    } else {
      setMode('add');
    }
    // Only re-run when the providers query transitions out of loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listQ.isLoading]);

  const selected = providers.find((p) => p.id === selectedId) ?? null;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['ws-providers'] });
  };

  function selectProvider(id: string) {
    setSelectedId(id);
    setMode('edit');
    setShowAddModel(false);
  }

  function openAddProvider() {
    setMode('add');
    setSelectedId(null);
    setShowAddModel(false);
  }

  const showRestartHint =
    !listQ.isLoading && providers.length === 0;

  return (
    <div className="space-y-3 h-full flex flex-col">
      {showRestartHint && (
        <WorkspaceEmptyState
          icon={Server}
          title="No providers configured yet"
          description="Restart the backend once — the built-in registry (Anthropic, OpenAI, Gemini, DeepSeek, …) will be seeded into providers.json automatically."
          action={
            <button
              onClick={() => listQ.refetch()}
              className="text-xs font-medium text-primary hover:underline"
            >
              Refresh now
            </button>
          }
          className="py-6"
        />
      )}

      <div className="grid grid-cols-[260px_1fr] gap-4 flex-1 min-h-0">
        {/* LEFT: provider list */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Providers</p>
            <button
              onClick={() => listQ.refetch()}
              aria-label="Refresh providers"
              className="text-muted-foreground hover:text-foreground transition"
            >
              <RefreshCw className={cn('size-3', listQ.isFetching && 'animate-spin')} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
            {providers.length === 0 ? null : (
              providers.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectProvider(p.id)}
                  className={cn(
                    'w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm text-left transition',
                    selectedId === p.id
                      ? 'bg-white/[0.06] text-foreground'
                      : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground',
                  )}
                >
                  <Server className="size-3.5 shrink-0" />
                  <span className="flex-1 truncate">{p.name}</span>
                  {p.enabled && <span className="size-2 rounded-full bg-emerald-500" title="enabled" />}
                </button>
              ))
            )}
          </div>
          <div className="border-t border-white/[0.06] p-2">
            <button
              onClick={openAddProvider}
              className="w-full flex items-center justify-center gap-1.5 rounded-md border border-white/[0.08] px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-white/[0.04] transition"
            >
              <Plus className="size-3.5" />
              Add provider
            </button>
          </div>
        </div>

        {/* RIGHT: editor / add form / empty state */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 flex flex-col overflow-hidden">
          {mode === 'add' ? (
            <AddProviderForm
              onCancel={() => {
                if (selected) {
                  setMode('edit');
                } else {
                  setMode('empty');
                }
              }}
              onCreated={(p) => {
                invalidate();
                selectProvider(p.id);
              }}
            />
          ) : mode === 'edit' && selected ? (
            <ProviderEditor
              key={selected.id}
              provider={selected}
              onChanged={invalidate}
              showAddModel={showAddModel}
              setShowAddModel={setShowAddModel}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ── Quotas subtab — lifted from the old Models section ─────────────── */

function QuotasTab() {
  return <QuotasPanel />;
}

/* ── All models subtab — every model from every provider, with Discover all */

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

function AllModelsTab() {
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
      qc.invalidateQueries({ queryKey: ['ws-providers'] });
      setDiscovering(false);
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
            <p className="text-xl font-semibold tabular-nums text-amber-400">{reasoningCount.toLocaleString()}</p>
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

      {/* Table */}
      {totalModels === 0 ? (
        <WorkspaceEmptyState
          icon={Boxes}
          title="No models yet"
          description={
            providersDiscoverable(listQ.data ?? [])
              ? 'Click Discover all to fetch /v1/models from every configured provider. Manual models can also be added per provider.'
              : 'No providers configured yet. Add a provider on the Providers tab first, then come back here to discover models.'
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
      ) : (
        <div className="rounded-xl border border-white/[0.06] bg-card/60 flex-1 overflow-auto">
          {grouped.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No models match "{query}".
            </div>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {grouped.map(([providerId, providerRows]) => {
                const first = providerRows[0];
                return (
                  <div key={providerId}>
                    <div className="sticky top-0 z-10 bg-card/95 backdrop-blur px-4 py-2 border-b border-white/[0.06] flex items-center gap-3">
                      <Server className="size-3.5 text-muted-foreground" />
                      <span className="text-sm font-semibold">{first.providerName}</span>
                      <span className="text-[10px] font-mono text-muted-foreground/70">{providerId}</span>
                      {!first.enabled && (
                        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                          disabled
                        </span>
                      )}
                      <span className="ml-auto text-[10px] text-muted-foreground/70 font-mono">
                        {providerRows.length} model{providerRows.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="divide-y divide-white/[0.06]/50">
                      {providerRows.map((r) => (
                        <AllModelRow key={`${r.providerId}::${r.id}`} row={r} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AllModelRow({ row }: { row: AllModelRow }) {
  const ctx = fmtContextWindow(row.contextWindow);
  return (
    <div className="grid grid-cols-[1fr_80px_90px_90px_70px] gap-3 items-center px-4 py-2 text-sm">
      <div className="min-w-0">
        <span className="font-mono truncate block">{row.name || row.id}</span>
        {row.name && row.name !== row.id && (
          <span className="font-mono text-[10px] text-muted-foreground/70 truncate block">{row.id}</span>
        )}
      </div>
      {ctx ? (
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground text-center">
          {ctx}
        </span>
      ) : (
        <span className="text-[10px] text-muted-foreground/40 text-center">—</span>
      )}
      <span
        className={cn(
          'rounded px-1.5 py-0.5 text-[10px] font-mono text-center',
          row.source === 'fetched'
            ? 'bg-blue-500/15 text-blue-400'
            : 'bg-white/[0.06] text-muted-foreground',
        )}
        title={`source: ${row.source}`}
      >
        {row.source}
      </span>
      <span className="text-[10px] text-muted-foreground text-center font-mono">
        {row.providerId}
      </span>
      <span className="text-center">
        {row.reasoning ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-mono text-amber-400">
            reasoning
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground/40">—</span>
        )}
      </span>
    </div>
  );
}

function providersDiscoverable(providers: Provider[]): boolean {
  return providers.some((p) => p.enabled && p.apiKeySet && !!p.baseUrl);
}

/* ── Aliases subtab — user-defined model aliases (replaces lost feature) */

function AliasesTab() {
  const qc = useQueryClient();
  const aliasQ = useQuery({
    queryKey: ['user-model-aliases'],
    queryFn: () => getUserModelAliases(),
  });
  const modelsQ = useQuery({
    queryKey: ['aggregated-models'],
    queryFn: () => getAggregatedModels(),
  });

  // Local edits buffer — only persisted on Save.
  const [edits, setEdits] = useState<UserModelAlias[] | null>(null);
  const [aliases, setAliases] = useState<UserModelAlias[]>([]);
  useEffect(() => {
    if (aliasQ.data && edits === null) {
      setAliases(aliasQ.data.aliases ?? []);
    }
  }, [aliasQ.data, edits]);
  const visible = edits ?? aliases;
  const dirty = edits !== null && JSON.stringify(edits) !== JSON.stringify(aliases);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const restartMut = useMutation({
    mutationFn: () => restartBackend(),
    onSuccess: () => toast.success('Backend restart requested'),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Restart failed'),
  });

  function startEdit() {
    setEdits(aliases.map((a) => ({ ...a })));
  }
  function cancelEdit() {
    setEdits(null);
  }
  function commitAliasChange(idx: number, patch: Partial<UserModelAlias>) {
    const base = edits ?? aliases;
    const next = base.map((a, i) => (i === idx ? { ...a, ...patch } : a));
    if (edits === null) setEdits(next);
    else setEdits(next);
  }
  function addAlias() {
    const next = [...(edits ?? aliases), { alias: '', targetModel: '', targetProvider: '' }];
    if (edits === null) setEdits(next);
    else setEdits(next);
  }
  function removeAlias(idx: number) {
    const base = edits ?? aliases;
    const next = base.filter((_, i) => i !== idx);
    if (edits === null) setEdits(next);
    else setEdits(next);
  }

  async function save() {
    const payload = (edits ?? aliases).filter((a) => a.alias.trim() && a.targetModel.trim());
    setSaving(true);
    try {
      await updateUserModelAliases(payload);
      setAliases(payload);
      setEdits(null);
      qc.invalidateQueries({ queryKey: ['user-model-aliases'] });
      qc.invalidateQueries({ queryKey: ['aggregated-models'] });
      toast.success(`Saved ${payload.length} alias${payload.length === 1 ? '' : 'es'}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleRestart() {
    if (!window.confirm('Restart the backend? This will briefly interrupt active requests.')) return;
    setRestarting(true);
    try {
      await restartMut.mutateAsync();
    } finally {
      setRestarting(false);
    }
  }

  const models: AggregatedModel[] = (modelsQ.data?.models ?? []).map((m) => ({
    ...m,
    isFree: m.isFree ?? false,
  }));
  const seen = new Set<string>();
  const availableModels = models.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  return (
    <div className="space-y-3 h-full flex flex-col">
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3 flex-1 overflow-auto">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-semibold">User-defined model aliases</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Map a custom alias (e.g. <code className="text-[10px] font-mono">my-claude-opus</code>) to
              any real model. The alias shows up in the chat dropdown and proxies to the target provider.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" variant="outline" onClick={() => aliasQ.refetch()} title="Refresh model list">
              <RefreshCw className="size-3" /> Refresh
            </Button>
            {!dirty && (
              <Button size="sm" variant="outline" onClick={startEdit}>
                <Pencil className="size-3" /> Edit
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={addAlias} disabled={!edits && false}>
              <Plus className="size-3" /> Add alias
            </Button>
            {dirty && (
              <>
                <Button size="sm" variant="outline" onClick={cancelEdit}>
                  Cancel
                </Button>
                <Button size="sm" onClick={save} disabled={saving}>
                  {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </>
            )}
            <Button size="sm" variant="destructive" onClick={handleRestart} disabled={restarting} title="Restart backend to pick up alias changes">
              <RefreshCw className="size-3" /> {restarting ? 'Restarting…' : 'Restart'}
            </Button>
          </div>
        </div>

        {visible.length === 0 ? (
          <WorkspaceEmptyState
            icon={ArrowRightLeft}
            title="No aliases yet"
            description="Click 'Add alias' to create one. Useful for naming a specific model+provider combo behind a memorable id."
            className="py-6"
          />
        ) : (
          <div className="rounded-lg border border-white/[0.06] overflow-hidden">
            <div className="grid grid-cols-[1fr_2fr_120px_36px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-white/[0.06] font-mono">
              <span>Alias name</span>
              <span>Target model</span>
              <span>Provider</span>
              <span />
            </div>
            <div className="divide-y divide-white/[0.06]">
              {visible.map((a, i) => {
                const editing = edits !== null;
                return (
                  <div key={i} className="grid grid-cols-[1fr_2fr_120px_36px] gap-2 px-3 py-2 text-xs items-center font-mono">
                    <Input
                      value={a.alias}
                      onChange={(e) => commitAliasChange(i, { alias: e.target.value })}
                      placeholder="my-fake-model"
                      className="h-7 text-xs font-mono"
                      disabled={!editing}
                    />
                    <select
                      value={a.targetModel}
                      onChange={(e) => {
                        const v = e.target.value;
                        const m = availableModels.find((x) => x.id === v);
                        commitAliasChange(i, {
                          targetModel: v,
                          targetProvider: m?.provider ?? a.targetProvider,
                        });
                      }}
                      className="h-7 w-full rounded-md border border-white/[0.06] bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
                      disabled={!editing}
                    >
                      <option value="" disabled>Select a model…</option>
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}{m.isFree ? ' (free)' : ''}
                        </option>
                      ))}
                    </select>
                    <span className="text-muted-foreground truncate text-[10px]">
                      {a.targetProvider || '—'}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeAlias(i)}
                      disabled={!editing}
                      className="text-destructive/60 hover:text-destructive"
                      aria-label="Remove alias"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!dirty && aliases.length > 0 && (
          <p className="text-[10px] text-muted-foreground font-mono">
            Aliases persist to <code className="text-[10px]">config.json → modelAliases</code>.
            Restart the backend for changes to take effect.
          </p>
        )}
        {dirty && (
          <Badge variant="warning" className="text-[10px]">unsaved changes</Badge>
        )}
      </div>
    </div>
  );
}

/* ── Add provider form (matches the screenshot "Add model provider") ──── */

function AddProviderForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (p: Provider) => void;
}) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [apiFormat, setApiFormat] = useState<ApiFormat>(DEFAULT_API_FORMAT);

  const create = useMutation({
    mutationFn: () =>
      providersApi.create({ name, baseUrl, apiFormat, apiKey, enabled: true }),
    onSuccess: (p) => {
      toast.success(`Created ${p.name}`);
      onCreated(p);
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Failed to create provider');
    },
  });

  const valid = name.trim() && baseUrl.trim();

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header — matches screenshot */}
      <div className="px-5 pt-4 pb-3 border-b border-white/[0.06] flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Add model provider</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Configure a custom API endpoint and initial model.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <div className="p-5 space-y-4">
        <WorkspaceField label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. DeepSeek"
            autoFocus
          />
        </WorkspaceField>

        <WorkspaceField label="Base URL">
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </WorkspaceField>

        <WorkspaceField label="API key">
          <div className="relative">
            <Input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter API key"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? 'Hide API key' : 'Show API key'}
              className="absolute right-2 top-1/2 -translate-y-1/2 grid size-7 place-items-center rounded text-muted-foreground hover:text-foreground transition"
            >
              {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
        </WorkspaceField>

        <WorkspaceField label="API format">
          <WorkspaceSelect
            value={apiFormat}
            onChange={(e) => setApiFormat(e.target.value as ApiFormat)}
            options={API_FORMATS}
          />
        </WorkspaceField>

        {/* Footer — matches screenshot: Create filled + Add provider outline */}
        <div className="flex items-center justify-end gap-2 pt-4">
          <Button
            variant="outline"
            onClick={() => create.mutate()}
            disabled={!valid || create.isPending}
          >
            {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            Add provider
          </Button>
          <Button onClick={() => create.mutate()} disabled={!valid || create.isPending}>
            {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Create
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Provider editor (right pane) ────────────────────────────────────── */

function ProviderEditor({
  provider,
  onChanged,
  showAddModel,
  setShowAddModel,
}: {
  provider: Provider;
  onChanged: () => void;
  showAddModel: boolean;
  setShowAddModel: (v: boolean) => void;
}) {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiFormat, setApiFormat] = useState<ApiFormat>(provider.apiFormat);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [confirmClearKey, setConfirmClearKey] = useState(false);
  const [autoFetch, setAutoFetch] = useState(!!provider.autoFetch);

  // Re-sync local state when the selected provider changes.
  useEffect(() => {
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setApiFormat(provider.apiFormat);
    setApiKey('');
    setAutoFetch(!!provider.autoFetch);
    setShowAddModel(false);
    setConfirmClearKey(false);
  }, [provider.id, provider.name, provider.baseUrl, provider.apiFormat, provider.autoFetch, setShowAddModel]);

  const update = useMutation({
    mutationFn: (patch: Partial<{ name: string; baseUrl: string; apiFormat: ApiFormat; apiKey: string; enabled: boolean; autoFetch: boolean }>) =>
      providersApi.update(provider.id, patch),
    onSuccess: () => {
      toast.success('Saved');
      onChanged();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    },
  });

  const remove = useMutation({
    mutationFn: () => providersApi.remove(provider.id),
    onSuccess: () => {
      toast.success(`Deleted ${provider.name}`);
      onChanged();
    },
  });

  const refresh = useMutation({
    mutationFn: () => providersApi.refreshModels(provider.id),
    onSuccess: (res) => {
      toast.success(`Refreshed: ${res.added.length} added, ${res.updated.length} updated, ${res.removed.length} removed`);
      onChanged();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Refresh failed');
    },
  });

  const clearKeyMutation = useMutation({
    mutationFn: () => providersApi.update(provider.id, { apiKey: '' }),
    onSuccess: () => {
      toast.success('API key cleared');
      setConfirmClearKey(false);
      onChanged();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Failed to clear key');
    },
  });

  // Auto-fetch when the toggle is turned on.
  useEffect(() => {
    if (autoFetch && provider.apiKeySet && provider.baseUrl && !refresh.isPending) {
      refresh.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFetch]);

  function flushField<K extends 'name' | 'baseUrl' | 'apiKey'>(field: K, value: string) {
    if (field === 'name') setName(value);
    if (field === 'baseUrl') setBaseUrl(value);
    if (field === 'apiKey') setApiKey(value);
    update.mutate({ [field]: value } as never);
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Provider header */}
      <div className="px-5 pt-4 pb-3 border-b border-white/[0.06] flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold">{name || provider.name}</span>
          <Pencil className="size-3.5 text-muted-foreground" />
        </div>
        <div className="flex items-center gap-2">
          <WorkspaceToggle
            enabled={provider.enabled}
            onToggle={(next) => update.mutate({ enabled: next })}
            disabled={update.isPending}
          />
          <button
            onClick={() => {
              if (confirm(`Delete provider "${provider.name}" and all its models?`)) remove.mutate();
            }}
            aria-label="Delete provider"
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>

      <div className="p-5 space-y-4">
        <WorkspaceField label="Base URL">
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => baseUrl !== provider.baseUrl && flushField('baseUrl', baseUrl)}
            placeholder="https://api.example.com/v1"
          />
        </WorkspaceField>

        <WorkspaceField label="API format">
          <WorkspaceSelect
            value={apiFormat}
            onChange={(e) => {
              const v = e.target.value as ApiFormat;
              setApiFormat(v);
              update.mutate({ apiFormat: v });
            }}
            options={API_FORMATS}
          />
        </WorkspaceField>

        <WorkspaceField
          label="API key"
          hint={provider.apiKeySet ? 'A key is set. Enter a new one to replace it. Stored keys take precedence over environment variables.' : undefined}
        >
          <div className="space-y-2">
            <div className="relative">
              <Input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={() => apiKey && flushField('apiKey', apiKey)}
                placeholder={provider.apiKeySet ? '••••••••••••••••' : 'sk-…'}
                autoComplete="off"
              />
              {provider.apiKeySet && (
                <button
                  type="button"
                  onClick={() => setConfirmClearKey(true)}
                  className="absolute right-9 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:text-destructive transition"
                  aria-label="Clear stored API key"
                >
                  <Trash2 className="size-3" />
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
                className="absolute right-2 top-1/2 -translate-y-1/2 grid size-7 place-items-center rounded text-muted-foreground hover:text-foreground transition"
              >
                {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
            {confirmClearKey && provider.apiKeySet && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                <p className="text-xs text-amber-100">
                  Clear the stored API key? The provider will fall back to the
                  <code className="mx-1 px-1 rounded bg-black/30 text-[10px] font-mono">
                    {provider.id.toUpperCase().replace(/-/g, '_')}_API_KEY
                  </code>
                  environment variable if it is set.
                </p>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmClearKey(false)}
                    disabled={clearKeyMutation.isPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => clearKeyMutation.mutate()}
                    disabled={clearKeyMutation.isPending}
                  >
                    {clearKeyMutation.isPending ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Trash2 className="size-3" />
                    )}
                    Clear key
                  </Button>
                </div>
              </div>
            )}
          </div>
        </WorkspaceField>

        {/* Model discovery */}
        <div className="flex items-center justify-between rounded-lg border border-white/[0.06] p-3">
          <div>
            <p className="text-sm font-medium">Model discovery from <code className="text-xs font-mono">/v1/models</code></p>
            <p className="text-xs text-muted-foreground mt-0.5">
              When on, August finds every model the provider exposes and adds them here.
              Use the refresh icon to re-discover now.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending || !provider.apiKeySet}
              aria-label="Refresh models now"
              className="text-muted-foreground hover:text-foreground transition disabled:opacity-50"
            >
              <RefreshCw className={cn('size-3.5', refresh.isPending && 'animate-spin')} />
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={autoFetch}
              onClick={() => {
                const next = !autoFetch;
                setAutoFetch(next);
                update.mutate({ autoFetch: next });
              }}
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition',
                autoFetch ? 'bg-primary' : 'bg-white/[0.15]',
              )}
            >
              <span
                className={cn(
                  'inline-block size-4 transform rounded-full bg-white shadow transition',
                  autoFetch ? 'translate-x-4' : 'translate-x-0.5',
                )}
              />
            </button>
          </div>
        </div>

        {/* Model list */}
        <div>
          <p className="text-sm font-medium mb-2">Model list</p>
          {provider.models.length === 0 ? (
            <p className="text-xs text-muted-foreground italic py-4">No models yet. Add one below or enable Model discovery.</p>
          ) : (
            <div className="rounded-lg border border-white/[0.06] divide-y divide-white/[0.06] overflow-hidden">
              {provider.models.map((m) => (
                <ModelRow
                  key={m.id}
                  providerId={provider.id}
                  model={m}
                  onChanged={onChanged}
                />
              ))}
            </div>
          )}
          <div className="mt-2 flex">
            <button
              onClick={() => setShowAddModel(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-white/[0.15] px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-white/[0.3] transition"
            >
              <Plus className="size-3" />
              Add model
            </button>
          </div>
          {showAddModel && (
            <AddModelForm
              providerId={provider.id}
              onCancel={() => setShowAddModel(false)}
              onCreated={() => {
                onChanged();
                setShowAddModel(false);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Model row ───────────────────────────────────────────────────────── */

function ModelRow({
  providerId,
  model,
  onChanged,
}: {
  providerId: string;
  model: Provider['models'][number];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(model.name ?? model.id);
  const [contextWindow, setContextWindow] = useState(model.contextWindow?.toString() ?? '');
  const [reasoning, setReasoning] = useState(!!model.reasoning);

  const update = useMutation({
    mutationFn: () => providersApi.updateModel(providerId, model.id, {
      name,
      contextWindow: contextWindow ? Number(contextWindow) : undefined,
      reasoning,
    }),
    onSuccess: () => {
      onChanged();
      toast.success('Saved');
    },
  });
  const remove = useMutation({
    mutationFn: () => providersApi.removeModel(providerId, model.id),
    onSuccess: () => {
      onChanged();
      toast.success(`Removed ${model.id}`);
    },
  });

  const ctx = fmtContextWindow(model.contextWindow);

  if (editing) {
    return (
      <div className="px-3 py-3 space-y-2">
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" />
          <Input value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} placeholder="context window" type="number" />
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
          Supports reasoning
        </label>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => update.mutate()} disabled={update.isPending}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <div className="flex-1 min-w-0">
        <span className="font-medium truncate">{model.name || model.id}</span>
      </div>
      <span
        className={cn(
          'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono',
          model.source === 'fetched'
            ? 'bg-blue-500/15 text-blue-400'
            : 'bg-white/[0.06] text-muted-foreground',
        )}
        title={`source: ${model.source}`}
      >
        {model.source}
      </span>
      {ctx && (
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          {ctx}
        </span>
      )}
      {model.reasoning && (
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-mono text-amber-400">
          reasoning
        </span>
      )}
      <button
        onClick={() => setEditing(true)}
        aria-label="Edit model"
        className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground transition"
      >
        <Pencil className="size-3.5" />
      </button>
      <button
        onClick={() => {
          if (confirm(`Remove model "${model.id}"?`)) remove.mutate();
        }}
        aria-label="Delete model"
        className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

/* ── Add model form ──────────────────────────────────────────────────── */

function AddModelForm({
  providerId,
  onCancel,
  onCreated,
}: {
  providerId: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [contextWindow, setContextWindow] = useState('');
  const [reasoning, setReasoning] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      providersApi.addModel(providerId, {
        id,
        name: name || undefined,
        contextWindow: contextWindow ? Number(contextWindow) : undefined,
        reasoning,
      }),
    onSuccess: () => {
      toast.success(`Added ${id}`);
      onCreated();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Failed to add model');
    },
  });

  return (
    <div className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
      <div className="grid grid-cols-[1fr_1fr_120px] gap-2">
        <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="model-id" />
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name (optional)" />
        <Input value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} placeholder="context" type="number" />
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
        Supports reasoning
      </label>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => create.mutate()} disabled={!id.trim() || create.isPending}>
          {create.isPending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
