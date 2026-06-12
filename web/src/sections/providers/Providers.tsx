import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { PageLoader } from '@/components/PageLoader';
import { Eye, EyeOff, ChevronDown, ChevronRight, Save, Check, Key } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Provider {
  id: string;
  name: string;
  apiMode: string;
  isAvailable: boolean;
  redactedKey: string | null;
}
interface ActiveProviderData {
  activeProvider: string;
  providers: Provider[];
}

export function Providers() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ActiveProviderData>('/api/config/activeProvider'),
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});
  const [showKeyFor, setShowKeyFor] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<{ id: string; type: 'ok' | 'err'; text: string } | null>(null);
  const queryClient = useQueryClient();

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

  const handleSave = async (providerId: string, providerName: string) => {
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
    } catch (e: any) {
      setSaveMsg({ id: providerId, type: 'err', text: e.message || 'Save failed' });
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Providers"
        subtitle={<>Active: <span className="font-mono text-foreground">{data.activeProvider}</span></>}
        actions={
          <button
            onClick={() => refetch()}
            className="text-xs text-muted-foreground hover:text-foreground transition"
          >
            ↻ Refresh
          </button>
        }
      />

      <div className="space-y-1">
        <p className="text-[11px] font-medium text-muted-foreground px-1 pb-1">Available providers</p>
        {sorted.map((p) => {
          const isExpanded = expandedId === p.id;
          return (
            <div
              key={p.id}
              className={cn(
                'rounded-lg transition-colors',
                isExpanded
                  ? 'bg-primary/[0.04] ring-1 ring-primary/20'
                  : 'hover:bg-muted/40'
              )}
            >
              <button
                onClick={() => toggleExpand(p.id)}
                className="w-full flex items-center justify-between px-3 py-2.5 text-left"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className={cn(
                    'inline-block size-1.5 rounded-full shrink-0',
                    p.isAvailable ? 'bg-primary' : 'bg-muted-foreground/30'
                  )} />
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="text-[10px] text-muted-foreground font-mono">{p.apiMode}</span>
                  {p.id === data.activeProvider && (
                    <span className="inline-flex items-center gap-1 text-[9px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                      <Check className="size-2.5" /> active
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {p.isAvailable && p.redactedKey ? (
                    <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[140px]">
                      {p.redactedKey}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60">
                      <Key className="size-2.5" /> no key
                    </span>
                  )}
                  {isExpanded
                    ? <ChevronDown className="size-3 text-muted-foreground" />
                    : <ChevronRight className="size-3 text-muted-foreground" />}
                </div>
              </button>

              {isExpanded && (
                <div className="px-3 pb-3 pt-1 space-y-2.5">
                  <div className="relative pt-2.5">
                    <label className="block text-[10px] text-muted-foreground mb-1 font-medium">API Key</label>
                    <div className="relative">
                      <input
                        type={showKeyFor[p.id] ? 'text' : 'password'}
                        value={apiKeys[p.id] ?? ''}
                        onChange={(e) => setApiKeys(prev => ({ ...prev, [p.id]: e.target.value }))}
                        placeholder={p.isAvailable ? 'Key already configured (override)' : 'Enter API key…'}
                        className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                      />
                      <button
                        onClick={() => setShowKeyFor(prev => ({ ...prev, [p.id]: !prev[p.id] }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showKeyFor[p.id] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] text-muted-foreground mb-1 font-medium">Base URL (optional)</label>
                    <input
                      type="text"
                      value={baseUrls[p.id] ?? ''}
                      onChange={(e) => setBaseUrls(prev => ({ ...prev, [p.id]: e.target.value }))}
                      placeholder="https://api.example.com"
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                    />
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      onClick={() => handleSave(p.id, p.name)}
                      disabled={saving === p.id || (!apiKeys[p.id] && !baseUrls[p.id])}
                    >
                      <Save className="size-3 mr-1" />
                      {saving === p.id ? 'Saving…' : 'Save'}
                    </Button>
                    {saveMsg && saveMsg.id === p.id && (
                      <span className={cn('text-[10px]', saveMsg.type === 'ok' ? 'text-primary' : 'text-destructive')}>
                        {saveMsg.text}
                      </span>
                    )}
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
