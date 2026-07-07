import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useProviderHealth } from '@/api/provider-health';
import { providersApi, type ProviderTemplate } from '@/api/providers';
import { useProviderTemplates } from '@/hooks/useProviderTemplates';
import { SectionHeader } from '@/components/SectionHeader';
import { PageLoader } from '@/components/PageLoader';
import { Eye, EyeOff, ChevronDown, ChevronRight, Save, Check, Key, ArrowUpRight, PlugZap, ShieldCheck, Globe, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
  const { byProvider: healthByProvider, loaded: healthLoaded, refresh: refreshHealth } = useProviderHealth(60_000);
  const { templates } = useProviderTemplates();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderKey, setNewProviderKey] = useState('');
  const [adding, setAdding] = useState(false);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});
  const [showKeyFor, setShowKeyFor] = useState<Record<string, boolean>>({});
  const [showKeyFieldFor, setShowKeyFieldFor] = useState<Record<string, boolean>>({});
  const [showEndpointFor, setShowEndpointFor] = useState<Record<string, boolean>>({});
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
      queryClient.invalidateQueries({ queryKey: ['providers'] });
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
      queryClient.invalidateQueries({ queryKey: ['providers'] });
      queryClient.invalidateQueries({ queryKey: ['model-options'] });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveMsg({ id: providerId, type: 'err', text: message || 'Save failed' });
    } finally {
      setSaving(null);
    }
  };

  const handleAddProvider = async () => {
    if (!newProviderName.trim()) return;
    setAdding(true);
    try {
      await providersApi.create({
        name: newProviderName,
        // `selectedTemplate` is UI-only scaffolding for future preset
        // support; ProviderCreate does not yet accept it, so drop it
        // when undefined.
        ...(selectedTemplate ? { template: selectedTemplate } : {}),
        apiKey: newProviderKey,
        apiFormat: 'openai-chat',
        baseUrl: '',
        enabled: true,
      });
      setShowAddForm(false);
      setSelectedTemplate('');
      setNewProviderName('');
      setNewProviderKey('');
      queryClient.invalidateQueries({ queryKey: ['providers'] });
      queryClient.invalidateQueries({ queryKey: ['aggregated-models'] });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveMsg({ id: 'add', type: 'err', text: message || 'Failed to add provider' });
    } finally {
      setAdding(false);
    }
  };

  const handleTemplateSelect = (templateId: string) => {
    setSelectedTemplate(templateId);
    const tmpl = templates.find((t) => t.id === templateId);
    if (tmpl) {
      setNewProviderName(tmpl.name);
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
            <Button type="button" variant="outline" size="sm" onClick={() => refetch()}>
              Refresh
            </Button>
          </div>
        }
      />

      {showAddForm && (
        <div className="rounded-2xl border border-white/[0.06] bg-card/80 p-4 space-y-3">
          <p className="text-sm font-semibold">Add a Provider</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-muted-foreground mb-1 font-medium">Template</label>
              <select
                value={selectedTemplate}
                onChange={(e) => handleTemplateSelect(e.target.value)}
                className="w-full rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-sm text-foreground focus:border-primary outline-none"
              >
                <option value="">Custom (manual setup)</option>
                {templates.map((t: ProviderTemplate) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] text-muted-foreground mb-1 font-medium">Provider Name</label>
              <input
                type="text"
                value={newProviderName}
                onChange={(e) => setNewProviderName(e.target.value)}
                placeholder="My Provider"
                className="w-full rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-primary outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] text-muted-foreground mb-1 font-medium">API Key</label>
              <input
                type="password"
                value={newProviderKey}
                onChange={(e) => setNewProviderKey(e.target.value)}
                placeholder="sk-..."
                className="w-full rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-primary outline-none"
              />
            </div>
          </div>
          {selectedTemplate && (
            <div className="rounded-lg border border-white/[0.06] bg-black/10 p-2.5 text-xs text-muted-foreground">
              Using <span className="font-medium text-foreground">{templates.find(t => t.id === selectedTemplate)?.name}</span> template.
              Base URL and API format will be pre-filled from the template.
            </div>
          )}
          {saveMsg && saveMsg.id === 'add' && (
            <p className="text-xs text-destructive">{saveMsg.text}</p>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => { setShowAddForm(false); setSaveMsg(null); }}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={handleAddProvider} disabled={!newProviderName.trim() || adding}>
              {adding ? 'Adding…' : 'Add Provider'}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold px-1">Available providers</p>
          {sorted.map((p) => {
            const isExpanded = expandedId === p.id;
            const providerDetails = details?.id === p.id ? details : null;
            const authType = providerDetails?.authType || p.authType || 'api_key';
            const hasKey = p.isAvailable || Boolean(providerDetails?.configOverrides?.apiKey);
            const showKeyField = showKeyFieldFor[p.id] || !hasKey || authType === 'api_key' && !hasKey;
            const hasEndpointOverride = Boolean(providerDetails?.configOverrides?.baseUrl || providerDetails?.configOverrides?.targetUrl);
            const showEndpointField = showEndpointFor[p.id] || hasEndpointOverride || p.id === 'custom';

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
                        <span className="truncate text-sm font-semibold">{p.name}</span>
                        {p.id === data.activeProvider && (
                          <span className="inline-flex items-center gap-1 text-[9px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">
                            <Check className="size-2.5" /> active
                          </span>
                        )}
                        {hasKey && healthLoaded && (
                          <span
                            className={cn(
                              'inline-block size-1.5 rounded-full shrink-0',
                              healthByProvider.get(p.id)?.online
                                ? 'bg-success shadow-[0_0_8px_rgba(16,185,129,.5)]'
                                : 'bg-muted-foreground/40'
                            )}
                            title={healthByProvider.get(p.id)?.online ? 'Live · reachable' : 'Offline or unreachable'}
                            aria-label={healthByProvider.get(p.id)?.online ? 'Provider online' : 'Provider offline'}
                          />
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="font-mono">{p.apiMode}</span>
                        <span className="size-1 rounded-full bg-muted-foreground/30" />
                        <span>{authLabel(authType)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {hasKey && (p.redactedKey || providerDetails?.configOverrides?.apiKey) ? (
                      <span className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
                        <Key className="size-2.5" />
                        configured
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-warning/20 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                        <ShieldCheck className="size-2.5" />
                        needs auth
                      </span>
                    )}
                    {isExpanded
                      ? <ChevronDown className="size-3 text-muted-foreground" />
                      : <ChevronRight className="size-3 text-muted-foreground" />}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t bg-muted/[0.025] px-4 py-3">
                    <div className="space-y-3">
                      {providerDetails?.description && (
                        <p className="text-xs leading-relaxed text-muted-foreground">{providerDetails.description}</p>
                      )}

                      <div className="flex flex-wrap gap-2">
                        <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">{authLabel(authType)}</span>
                        {providerDetails?.defaultModel && (
                          <span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-medium text-secondary-foreground">
                            {providerDetails.defaultModel}
                          </span>
                        )}
                        {p.signupUrl && (
                          <button
                            onClick={() => window.open(p.signupUrl, '_blank', 'noopener,noreferrer')}
                            className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium hover:bg-muted"
                          >
                            Sign up <ArrowUpRight className="size-2.5" />
                          </button>
                        )}
                      </div>

                      {authType === 'oauth' && (
                        <div className="rounded-xl border bg-background p-3 text-xs text-muted-foreground">
                          This provider supports login-style auth. Use the provider OAuth flow instead of pasting an API key.
                        </div>
                      )}

                      {authType === 'aws_sdk' && (
                        <div className="rounded-xl border bg-background p-3 text-xs text-muted-foreground">
                          This provider reads AWS SDK credentials from the environment. No API key field is needed here.
                        </div>
                      )}

                      {authType === 'none' && (
                        <div className="rounded-xl border bg-background p-3 text-xs text-muted-foreground">
                          No credentials are required for this provider.
                        </div>
                      )}

                      {authType === 'api_key' && (
                        <div className="space-y-2">
                          {!showKeyField ? (
                            <div className="rounded-xl border bg-background p-3 text-xs text-muted-foreground">
                              API key is already configured. Open it only if you need to override it.
                              <div className="mt-2">
                                <Button type="button" variant="outline" size="sm" onClick={() => setShowKeyFieldFor(prev => ({ ...prev, [p.id]: true }))}>
                                  <Key className="size-3 mr-1" />
                                  Change key
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div>
                              <label className="block text-[10px] text-muted-foreground mb-1 font-medium">API Key</label>
                              <div className="relative">
                                <input
                                  type={showKeyFor[p.id] ? 'text' : 'password'}
                                  value={apiKeys[p.id] ?? ''}
                                  onChange={(e) => setApiKeys(prev => ({ ...prev, [p.id]: e.target.value }))}
                                  placeholder={hasKey ? 'Override existing key…' : 'Enter API key…'}
                                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                                />
                                <button
                                  onClick={() => setShowKeyFor(prev => ({ ...prev, [p.id]: !prev[p.id] }))}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                >
                                  {showKeyFor[p.id] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                </button>
                              </div>
                            </div>
                          )}

                          {showEndpointField ? (
                            <div>
                              <label className="block text-[10px] text-muted-foreground mb-1 font-medium">Endpoint override</label>
                              <input
                                type="text"
                                value={baseUrls[p.id] ?? providerDetails?.configOverrides?.baseUrl ?? ''}
                                onChange={(e) => setBaseUrls(prev => ({ ...prev, [p.id]: e.target.value }))}
                                placeholder="https://api.example.com"
                                className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                              />
                            </div>
                          ) : (
                            <Button type="button" variant="ghost" size="sm" onClick={() => setShowEndpointFor(prev => ({ ...prev, [p.id]: true }))}>
                              <Globe className="size-3 mr-1" />
                              Optional endpoint
                            </Button>
                          )}
                        </div>
                      )}

                      {providerDetails?.envVars?.length ? (
                        <div className="rounded-xl border bg-background p-3">
                          <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold mb-2">Env readiness</p>
                          <div className="flex flex-wrap gap-1.5">
                            {providerDetails.envVars.map(envVar => (
                              <span key={envVar} className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-mono text-muted-foreground">
                                <span className={cn('size-1.5 rounded-full', providerDetails.envStatus?.[envVar] ? 'bg-success' : 'bg-muted-foreground/30')} />
                                {envVar}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <div className="flex items-center justify-between gap-2 pt-1">
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleSetActive(p.id)}
                            disabled={saving === p.id || p.id === data.activeProvider}
                          >
                            {saving === p.id ? <Loader2 className="size-3 mr-1 animate-spin" /> : <PlugZap className="size-3 mr-1" />}
                            {p.id === data.activeProvider ? 'Active' : 'Use'}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleSave(p.id)}
                            disabled={saving === p.id}
                          >
                            <Save className="size-3 mr-1" />
                            Save
                          </Button>
                        </div>
                        {saveMsg && saveMsg.id === p.id && (
                          <span className={cn('text-[10px]', saveMsg.type === 'ok' ? 'text-success' : 'text-destructive')}>
                            {saveMsg.text}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
  );
}
