/* Right-pane editor for an existing model provider.
 * Edits credentials and API format, runs model discovery, and hosts the
 * per-provider model list (rows + manual add). Patches flow through
 * providersApi.update / refreshModels and call onChanged for catalog sync.
 */

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pencil, Trash2, Plus, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { providersApi, type Provider, type ApiFormat } from '@/api/providers';
import { WorkspaceField } from '@/components/workspace/WorkspaceField';
import { WorkspaceSelect } from '@/components/workspace/WorkspaceSelect';
import { WorkspaceToggle } from '@/components/workspace/WorkspaceToggle';
import { Input } from '@/components/ui/input';
import { API_FORMATS } from './modelSettingsShared';
import { ModelDiscoveryActions } from './ModelDiscoveryActions';
import { ModelRow } from './ModelRow';
import { AddModelForm } from './AddModelForm';

export function ProviderDetailForm({
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

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5 space-y-4">
        <WorkspaceField
          label="Base URL"
          hint="Used exactly as pasted — API format appends the leaf (chat/completions, v1/messages, responses). Anthropic already includes v1 in the leaf."
        >
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => baseUrl !== provider.baseUrl && flushField('baseUrl', baseUrl)}
            placeholder="https://opencode.ai/zen/v1"
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

        <ModelDiscoveryActions
          autoFetch={autoFetch}
          refreshPending={refresh.isPending}
          canRefresh={provider.apiKeySet}
          onRefresh={() => refresh.mutate()}
          onToggleAutoFetch={(next) => {
            setAutoFetch(next);
            update.mutate({ autoFetch: next });
          }}
        />

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
