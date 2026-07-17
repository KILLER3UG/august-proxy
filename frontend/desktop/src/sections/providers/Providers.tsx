import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useProviderHealth } from '@/api/provider-health';
import { providersApi, type ApiFormat } from '@/api/providers';
import { SectionHeader } from '@/components/SectionHeader';
import { PageLoader } from '@/components/PageLoader';
import { Eye, EyeOff, ChevronDown, ChevronRight, Save, Check, Key, ArrowUpRight, PlugZap, ShieldCheck, Globe, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { refreshProviderCatalog } from '@/lib/provider-catalog';

interface Provider {
  id: string;
  name: string;
  apiMode: string;
  isAvailable: boolean;
  redactedKey: string | null;
  authType?: string;
  signupUrl?: string;
}

interface ProviderDetails {
  id: string;
  name: string;
  description?: string;
  baseUrl?: string;
  apiMode: string;
  authType: string;
  envVars?: string[];
  envStatus?: Record<string, boolean>;
  isAvailable: boolean;
  defaultModel?: string;
  signupUrl?: string;
  supportsHealthCheck?: boolean;
  isActive: boolean;
  configOverrides?: Record<string, string>;
  modelProfiles?: string[];
}

interface ActiveProviderData {
  activeProvider: string;
  providers: Provider[];
}

const API_FORMATS: { value: ApiFormat; label: string }[] = [
  { value: 'openaiChat', label: 'OpenAI Chat Completions' },
  { value: 'anthropicMessages', label: 'Anthropic Messages' },
  { value: 'openaiResponses', label: 'OpenAI Responses' },
];

function authLabel(authType?: string) {
  switch (authType) {
    case 'api_key': return 'API key';
    case 'oauth': return 'Login';
    case 'aws_sdk': return 'AWS SDK';
    case 'none': return 'No auth';
    default: return authType || 'Unknown';
  }
}

export function Providers() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ActiveProviderData>('/api/config/activeProvider'),
  });
  const { byProvider: healthByProvider, loaded: healthLoaded, refresh: _refreshHealth } = useProviderHealth(60_000);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderKey, setNewProviderKey] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [newApiFormat, setNewApiFormat] = useState<ApiFormat>('openaiChat');
  const [adding, setAdding] = useState(false);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});
  const [showKeyFor, setShowKeyFor] = useState<Record<string, boolean>>({});
  const [showKeyFieldFor, setShowKeyFieldFor] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<{ id: string; type: 'ok' | 'err'; text: string } | null>(null);
  const queryClient = useQueryClient();

  const { data: details } = useQuery({
    queryKey: ['provider-details', expandedId],
    enabled: Boolean(expandedId),
    queryFn: async () => {
      const res = await api.get<ProviderDetails>(`/api/config/provider-details?provider=${encodeURIComponent(expandedId || '')}`);
      return res;
    },
  });

  if (isLoading) return <PageLoader label="Loading providers…" />;
  if (error) {
    return (
      <div className="p-6">
        <SectionHeader title="Providers" />
        <p className="text-sm text-destructive">Failed: {String(error)}</p>
      </div>
    );
  }
  if (!data) return null;

  const sorted = [...data.providers].sort((a, b) => {
    if (a.id === data.activeProvider) return -1;
    if (b.id === data.activeProvider) return 1;
    if (a.isAvailable && !b.isAvailable) return -1;
    if (!a.isAvailable && b.isAvailable) return 1;
    return a.name.localeCompare(b.name);
  });

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
    setSaveMsg(null);
  };

  const handleSetActive = async (providerId: string) => {
    setSaving(providerId);
    setSaveMsg(null);
    try {
      await api.put('/api/config/activeProvider', { provider: providerId });
      void refreshProviderCatalog(queryClient);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveMsg({ id: providerId, type: 'err', text: message || 'Failed to activate' });
    } finally {
      setSaving(null);
    }
  };

  const handleSave = async (providerId: string) => {
    setSaving(providerId);
    setSaveMsg(null);
    try {
      const config: Record<string, string> = {};
      if (apiKeys[providerId]) config.apiKey = apiKeys[providerId];
      if (baseUrls[providerId]) config.baseUrl = baseUrls[providerId];
      await api.post('/api/config/provider-details', { provider: providerId, config });
      setSaveMsg({ id: providerId, type: 'ok', text: 'Saved' });
      void refreshProviderCatalog(queryClient);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveMsg({ id: providerId, type: 'err', text: message || 'Failed to activate' });
    } finally {
      setSaving(null);
    }
  };

  const handleAddProvider = async () => {
    if (!newProviderName.trim() || !newBaseUrl.trim()) return;
    setAdding(true);
    try {
      const created = await providersApi.create({
        name: newProviderName.trim(),
        baseUrl: newBaseUrl.trim(),
        apiFormat: newApiFormat,
        apiKey: newProviderKey,
        enabled: true,
      });
      if (newBaseUrl.trim() && newProviderKey.trim()) {
        try {
          await providersApi.refreshModels(created.id);
        } catch {
          /* best-effort discovery */
        }
      }
      setShowAddForm(false);
      setNewProviderName('');
      setNewProviderKey('');
      setNewBaseUrl('');
      setNewApiFormat('openaiChat');
      void refreshProviderCatalog(queryClient);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveMsg({ id: 'add', type: 'err', text: message || 'Failed to add provider' });
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Providers"
        actions={
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowAddForm(!showAddForm)}>
              <Plus className="size-3 mr-1" />
              Add Provider
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
              Refresh
            </Button>
          </div>
        }
      />

      {showAddForm && (
        <div className="rounded-2xl border border-white/[0.06] bg-card/80 p-4 space-y-3">
          <p className="text-sm font-semibold">Add a provider</p>
          <p className="text-xs text-muted-foreground">
            You configure every provider yourself — name, API base URL, format, and key.
            There is no built-in template catalog.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-muted-foreground mb-1 font-medium">Provider name</label>
              <input
                type="text"
                value={newProviderName}
                onChange={(e) => setNewProviderName(e.target.value)}
                placeholder="OpenRouter"
                className="w-full rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-primary outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] text-muted-foreground mb-1 font-medium">API format</label>
              <select
                value={newApiFormat}
                onChange={(e) => setNewApiFormat(e.target.value as ApiFormat)}
                className="w-full rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-sm text-foreground focus:border-primary outline-none"
              >
                {API_FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-[10px] text-muted-foreground mb-1 font-medium">Base URL</label>
              <input
                type="url"
                value={newBaseUrl}
                onChange={(e) => setNewBaseUrl(e.target.value)}
                placeholder="https://openrouter.ai/api/v1"
                className="w-full rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-primary outline-none"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-[10px] text-muted-foreground mb-1 font-medium">API key</label>
              <input
                type="password"
                value={newProviderKey}
                onChange={(e) => setNewProviderKey(e.target.value)}
                placeholder="sk-..."
                className="w-full rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-primary outline-none"
              />
            </div>
          </div>
          {saveMsg && saveMsg.id === 'add' && (
            <p className="text-xs text-destructive">{saveMsg.text}</p>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => { setShowAddForm(false); setSaveMsg(null); }}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleAddProvider()}
              disabled={!newProviderName.trim() || !newBaseUrl.trim() || adding}
            >
              {adding ? 'Adding…' : 'Add Provider'}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold px-1">Configured providers</p>
        {sorted.length === 0 && (
          <p className="text-sm text-muted-foreground px-1">
            No providers with API keys yet. Use <strong>Add Provider</strong> to configure one.
          </p>
        )}
          {sorted.map((p) => {
            const isExpanded = expandedId === p.id;
            const providerDetails = details?.id === p.id ? details : null;
            const authType = providerDetails?.authType || p.authType || 'api_key';
            const hasKey = p.isAvailable || Boolean(providerDetails?.configOverrides?.apiKey);
            const showKeyField = showKeyFieldFor[p.id] || !hasKey || authType === 'api_key' && !hasKey;
            return (
              <div
                key={p.id}
                className={cn(
                  'group overflow-hidden rounded-2xl border bg-card/80 transition-all hover:border-primary/30 hover:bg-card',
                  isExpanded && 'border-primary/40 shadow-lg shadow-primary/5'
                )}
              >
                <button
                  onClick={() => toggleExpand(p.id)}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={cn(
                      'inline-block size-2.5 rounded-full shrink-0',
                      hasKey ? 'bg-success shadow-[0_0_16px_rgba(16,185,129,.45)]' : 'bg-muted-foreground/30'
                    )} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{p.name}</span>
                        {data.activeProvider === p.id && (
                          <span className="text-[10px] uppercase tracking-wide text-primary">active</span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground truncate">{p.apiMode || '—'}</p>
                    </div>
                  </div>
                  {isExpanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
                </button>

                {isExpanded && (
                  <div className="border-t border-white/[0.06] px-4 py-4 space-y-3">
                    {providerDetails?.baseUrl && (
                      <p className="text-xs font-mono text-muted-foreground break-all">{providerDetails.baseUrl}</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => void handleSetActive(p.id)} disabled={saving === p.id}>
                        Set active
                      </Button>
                      <Button type="button" size="sm" onClick={() => void handleSave(p.id)} disabled={saving === p.id}>
                        {saving === p.id ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
                        <span className="ml-1">Save</span>
                      </Button>
                    </div>
                    {showKeyField && (
                      <div className="space-y-1">
                        <label className="text-[10px] text-muted-foreground font-medium flex items-center gap-1">
                          <Key className="size-3" /> API key
                        </label>
                        <div className="flex gap-2">
                          <input
                            type={showKeyFor[p.id] ? 'text' : 'password'}
                            value={apiKeys[p.id] ?? ''}
                            onChange={(e) => setApiKeys({ ...apiKeys, [p.id]: e.target.value })}
                            placeholder={hasKey ? '•••••••• (leave blank to keep)' : 'sk-...'}
                            className="flex-1 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-sm"
                          />
                          <Button type="button" size="sm" variant="ghost" onClick={() => setShowKeyFor({ ...showKeyFor, [p.id]: !showKeyFor[p.id] })}>
                            {showKeyFor[p.id] ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                          </Button>
                        </div>
                      </div>
                    )}
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground font-medium flex items-center gap-1">
                        <Globe className="size-3" /> Base URL override
                      </label>
                      <input
                        type="url"
                        value={baseUrls[p.id] ?? providerDetails?.baseUrl ?? ''}
                        onChange={(e) => setBaseUrls({ ...baseUrls, [p.id]: e.target.value })}
                        className="w-full rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-sm"
                      />
                    </div>
                    {saveMsg && saveMsg.id === p.id && (
                      <p className={cn('text-xs', saveMsg.type === 'ok' ? 'text-success' : 'text-destructive')}>
                        {saveMsg.type === 'ok' ? <Check className="inline size-3 mr-1" /> : null}
                        {saveMsg.text}
                      </p>
                    )}
                    {(() => {
                      const health = healthByProvider.get(p.id);
                      if (!healthLoaded || !health) return null;
                      const label = health.online
                        ? `online${health.latencyMs != null ? ` (${health.latencyMs}ms)` : ''}`
                        : health.error || 'offline';
                      return (
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <ShieldCheck className="size-3" />
                          Health: {label}
                        </p>
                      );
                    })()}
                    {p.signupUrl && (
                      <a href={p.signupUrl} target="_blank" rel="noreferrer" className="text-[11px] text-primary inline-flex items-center gap-1">
                        Get API key <ArrowUpRight className="size-3" />
                      </a>
                    )}
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <PlugZap className="size-3" /> Auth: {authLabel(authType)}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
