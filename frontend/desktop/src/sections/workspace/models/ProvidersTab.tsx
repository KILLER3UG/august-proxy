/* Providers view — two-pane CRUD for model providers.
 * Left rail lists every provider from /api/providers; the right pane creates
 * or edits credentials, API format, discovery, and per-provider model rows.
 * Catalog updates flow through providersApi and refreshProviderCatalog so chat
 * model dropdowns stay in sync without a restart.
 */

import { useEffect, useRef, useState } from 'react';
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
  Plug,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  providersApi,
  type Provider,
  type ApiFormat,
} from '@/api/providers';
import { WorkspaceField } from '@/components/workspace/WorkspaceField';
import { WorkspaceSelect } from '@/components/workspace/WorkspaceSelect';
import { WorkspaceToggle } from '@/components/workspace/WorkspaceToggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import { API_FORMATS, DEFAULT_API_FORMAT, fmtContextWindow } from './modelSettingsShared';

export function ProvidersTab() {
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

  /** Providers catalog is SoT — push updates to every model dropdown. */
  const invalidate = () => {
    void refreshProviderCatalog(qc);
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

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="providers-split">
      {/*
        Two independent panes: list grows with items (capped), details always
        scroll in their own column — neither is forced to stretch empty space.
      */}
      <div className="grid grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)] gap-4 flex-1 min-h-0 items-stretch">
        {/* LEFT: provider list — height follows content, scrolls when long */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 flex flex-col overflow-hidden min-h-0 max-h-full md:max-h-none md:h-full">
          <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between shrink-0">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
              Providers
            </p>
            <button
              onClick={() => void listQ.refetch()}
              aria-label="Refresh providers"
              className="text-muted-foreground hover:text-foreground transition"
            >
              <RefreshCw className={cn('size-3', listQ.isFetching && 'animate-spin')} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 space-y-0.5">
            {providers.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground text-center">No providers yet</p>
            ) : (
              providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
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
                  {p.enabled && <span className="size-2 rounded-full bg-success shrink-0" title="enabled" />}
                </button>
              ))
            )}
          </div>
          <div className="border-t border-white/[0.06] p-2 shrink-0">
            <button
              type="button"
              onClick={openAddProvider}
              className="w-full flex items-center justify-center gap-1.5 rounded-md border border-white/[0.08] px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-white/[0.04] transition"
            >
              <Plus className="size-3.5" />
              Add provider
            </button>
          </div>
        </div>

        {/* RIGHT: details — always independently scrollable */}
        <div className="rounded-xl border border-white/[0.06] bg-card/60 flex flex-col overflow-hidden min-h-0 h-full max-h-full">
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
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
              Select a provider or add a new one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
    <div className="flex flex-col min-h-0 h-full max-h-full">
      {/* Header — matches screenshot */}
      <div className="px-5 pt-4 pb-3 border-b border-white/[0.06] flex items-center justify-between gap-3 shrink-0">
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

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5 space-y-4">
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
  const [apiKey, setApiKey] = useState(provider.apiKey ?? '');
  const [showKey, setShowKey] = useState(false);
  const [autoFetch, setAutoFetch] = useState(!!provider.autoFetch);
  const [editingName, setEditingName] = useState(false);

  // Re-sync local state when the selected provider changes.
  useEffect(() => {
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setApiFormat(provider.apiFormat);
    setApiKey(provider.apiKey ?? '');
    setAutoFetch(!!provider.autoFetch);
    setShowAddModel(false);
  }, [provider.id, provider.name, provider.baseUrl, provider.apiFormat, provider.apiKey, provider.autoFetch, setShowAddModel]);

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
    update.mutate({ [field]: value });
  }

  return (
    <div className="flex flex-col min-h-0 h-full max-h-full">
      {/* Provider header — sticky within the details pane */}
      <div className="px-5 pt-4 pb-3 border-b border-white/[0.06] flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {editingName ? (
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => { setEditingName(false); flushField('name', name); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { setEditingName(false); flushField('name', name); } }}
              className="h-7 text-base font-semibold w-48"
              autoFocus
            />
          ) : (
            <>
              <span className="text-base font-semibold">{name || provider.name}</span>
              <button
                onClick={() => setEditingName(true)}
                aria-label="Edit provider name"
                title="Edit provider name"
                className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground transition"
              >
                <Pencil className="size-3.5" />
              </button>
            </>
          )}
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

      {/* Independently scrollable details body */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5 space-y-4">
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
                onBlur={() => apiKey !== provider.apiKey && flushField('apiKey', apiKey)}
                placeholder={provider.apiKeySet ? '••••••••••••••••' : 'sk-…'}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    // If the key isn't loaded yet (e.g. stale cache), fetch it
                    if (!apiKey && provider.apiKeySet) {
                      try {
                        const full = await providersApi.get(provider.id);
                        if (full.apiKey) setApiKey(full.apiKey);
                      } catch {
                        // Best-effort; key stays empty
                      }
                    }
                    setShowKey((v) => !v);
                  })();
                }}
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
                className="absolute right-2 top-1/2 -translate-y-1/2 grid size-7 place-items-center rounded text-muted-foreground hover:text-foreground transition"
              >
                {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
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
  const [testResult, setTestResult] = useState<null | {
    ok: boolean;
    error?: string;
    latencyMs: number;
    content?: string;
  }>(null);

  const update = useMutation({
    mutationFn: () => providersApi.updateModel(providerId, model.id, {
      name,
      contextWindow: contextWindow ? Number(contextWindow) : undefined,
      reasoning,
    }),
    onSuccess: () => {
      setEditing(false);
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
  const connect = useMutation({
    mutationFn: () => providersApi.connectModel(providerId, model.id),
    onSuccess: (res) => {
      // Strict: only Connected when backend says success AND returned non-empty content
      const reallyOk = Boolean(res.success && res.content && res.content.trim().length > 0 && !res.error);
      setTestResult({
        ok: reallyOk,
        error: reallyOk ? undefined : (res.error || 'Model returned no text'),
        latencyMs: res.latencyMs ?? 0,
        content: res.content,
      });
      if (reallyOk) {
        toast.success(`${model.id} connected · ${res.latencyMs}ms`);
      } else {
        toast.error(res.error || `${model.id} test failed`);
      }
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Connection failed';
      setTestResult({ ok: false, error: msg, latencyMs: 0 });
      toast.error(msg);
    },
  });

  const ctx = fmtContextWindow(model.contextWindow);

  if (editing) {
    return (
      <div
        className="px-3 py-3 space-y-2 bg-primary/5 border-l-2 border-primary"
        data-editing="true"
      >
        <div className="flex items-center gap-2">
          <Pencil className="size-3 text-primary" />
          <span className="text-[11px] uppercase tracking-caps font-semibold text-primary">
            Editing
          </span>
          <span className="text-xs font-mono text-muted-foreground truncate">{model.id}</span>
        </div>
        <div className="border-t border-border/30 pt-2 space-y-2">
          <div className="grid grid-cols-[1fr_120px] gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name"
              aria-label="Display name"
            />
            <Input
              value={contextWindow}
              onChange={(e) => setContextWindow(e.target.value)}
              placeholder="context window"
              type="number"
              aria-label="Context window"
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
            Supports reasoning
          </label>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => update.mutate()} disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 py-2.5 text-sm">
      <div className="flex items-center gap-3">
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
          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-mono text-warning">
            reasoning
          </span>
        )}
        <button
          onClick={() => connect.mutate()}
          disabled={connect.isPending}
          aria-label="Test model connection"
          title="Test connection to this model"
          className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground transition disabled:opacity-50"
        >
          {connect.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plug className="size-3.5" />
          )}
        </button>
        <button
          onClick={() => setEditing(true)}
          aria-label="Edit model"
          title="Edit display name and metadata"
          className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground transition"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          onClick={() => {
            if (confirm(`Remove model "${model.id}"?`)) remove.mutate();
          }}
          aria-label="Delete model"
          title="Remove this model"
          className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {testResult && (
        <div
          className={cn(
            'flex items-start gap-1.5 text-[11px] mt-1.5 pl-0.5',
            testResult.ok ? 'text-success' : 'text-danger',
          )}
          role={testResult.ok ? 'status' : 'alert'}
          aria-live="polite"
          data-testid={testResult.ok ? 'model-test-ok' : 'model-test-error'}
        >
          {testResult.ok ? (
            <>
              <CheckCircle2 className="size-3 mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="font-medium">Connected</span>
                <span className="text-muted-foreground"> · {testResult.latencyMs}ms</span>
                {testResult.content && (
                  <span className="block text-muted-foreground/80 truncate max-w-[28rem]" title={testResult.content}>
                    reply: {testResult.content}
                  </span>
                )}
              </span>
            </>
          ) : (
            <>
              <AlertCircle className="size-3 mt-0.5 shrink-0" />
              <span className="min-w-0 break-words" title={testResult.error}>
                <span className="font-medium">Failed</span>
                {testResult.latencyMs > 0 && (
                  <span className="text-muted-foreground"> · {testResult.latencyMs}ms</span>
                )}
                <span className="block opacity-90">{testResult.error || 'Connection failed'}</span>
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

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
