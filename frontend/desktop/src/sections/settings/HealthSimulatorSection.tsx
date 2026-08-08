/* ── Provider Health Simulator — preflight a provider + model ───────── */
/* Three probes through the real call paths: connectivity (strict "Connected!"
 * reply), tool support (does the model emit a tool call), and fallback
 * route (where this model resolves today). Fed by POST /api/providers/simulate. */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Loader2, Route, Stethoscope, X, Zap } from 'lucide-react';
import { api } from '@/api/client';
import { providersApi, type Provider } from '@/api/providers';
import { PageLoader } from '@/components/PageLoader';

interface SimCheck {
  id: string;
  name: string;
  success: boolean;
  latencyMs: number;
  detail: string;
}

interface SimResult {
  healthy: boolean;
  provider: string;
  model: string;
  apiFormat: string;
  error?: string;
  checks: SimCheck[];
}

const CHECK_ICONS: Record<string, typeof Zap> = {
  connectivity: Zap,
  'tool-support': Check,
  fallback: Route,
};

export function HealthSimulatorSection() {
  const { data: providers, isLoading } = useQuery<Provider[]>({
    queryKey: ['providers'],
    queryFn: () => providersApi.list(),
    staleTime: 15_000,
  });
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [result, setResult] = useState<SimResult | null>(null);
  const [running, setRunning] = useState(false);

  const provider = providers?.find((p) => p.id === providerId) ?? providers?.[0] ?? null;
  const models = useMemo(() => provider?.models ?? [], [provider]);
  const model = models.find((m) => m.id === modelId) ?? models[0] ?? null;

  const run = async () => {
    if (!provider || !model) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await api.post<SimResult>('/api/providers/simulate', {
        providerId: provider.id,
        modelId: model.id,
      });
      setResult(res);
    } catch (e) {
      setResult({ healthy: false, provider: provider.name, model: model.id, apiFormat: '', checks: [], error: e instanceof Error ? e.message : 'Simulation failed' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="px-8 py-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Stethoscope className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Provider Health Simulator</h1>
          <p className="text-sm text-muted-foreground">
            Preflight a provider + model the way August would actually use it — before you rely on it in chat.
          </p>
        </div>
      </div>

      {isLoading || !providers ? (
        <PageLoader label="Loading providers…" variant="card" className="py-10" />
      ) : providers.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-8 text-center">
          <p className="text-sm text-muted-foreground">No providers yet — add one in Models &amp; Providers first.</p>
        </div>
      ) : (
        <>
          {/* Selection */}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[11px] text-muted-foreground">Provider</span>
              <select
                value={provider?.id ?? ''}
                onChange={(e) => { setProviderId(e.target.value); setModelId(''); setResult(null); }}
                className="mt-1 w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
                data-testid="sim-provider-select"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] text-muted-foreground">Model</span>
              <select
                value={model?.id ?? ''}
                onChange={(e) => { setModelId(e.target.value); setResult(null); }}
                className="mt-1 w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
                data-testid="sim-model-select"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.id}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={!provider || !model || running}
              onClick={() => void run()}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs text-primary-foreground disabled:opacity-50"
              data-testid="sim-run"
            >
              {running ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
              {running ? 'Running probes…' : 'Run simulation'}
            </button>
            {result && (
              <span className={`inline-flex items-center gap-1.5 text-xs ${result.healthy ? 'text-success' : 'text-amber-500'}`}>
                {result.healthy ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                {result.healthy ? 'Route is healthy' : 'Issues found'}
              </span>
            )}
          </div>

          {/* Results */}
          {result?.error ? (
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-xs text-rose-400">
              {result.error}
            </div>
          ) : result && result.checks.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground">
                {result.provider} · <span className="font-mono">{result.model}</span> · {result.apiFormat || 'default format'}
              </p>
              {result.checks.map((c) => {
                const Icon = CHECK_ICONS[c.id] ?? Zap;
                return (
                  <div key={c.id} className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-card/60 p-4">
                    <Icon className={`size-4 shrink-0 mt-0.5 ${c.success ? 'text-success' : 'text-rose-500'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{c.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                          c.success ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'
                        }`} data-testid={`sim-check-${c.id}`}>
                          {c.success ? 'PASS' : 'FAIL'}
                        </span>
                        {c.latencyMs > 0 ? (
                          <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{c.latencyMs}ms</span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground break-words">{c.detail}</p>
                    </div>
                  </div>
                );
              })}
              <p className="text-[11px] text-muted-foreground/60">
                Probes use the same call paths as real chat (no fake transport). Tool support is a capability —
                a FAIL there doesn&apos;t block chat, it means the model won&apos;t drive August&apos;s tools.
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
