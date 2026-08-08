/* ── AI Setup wizard — guided first-run flow ────────────────────────── */
/* Lives at /settings/ai-setup and is the landing section for bare
 * /settings while setup is incomplete (provider + workspace missing).
 * Steps: add provider → test connection → discover models → default
 * model → safety mode + workspace → start chatting. */
/* Safety defaults written here are the same localStorage keys the chat
 * loop already reads (august_last_sandbox_mode / august_sandbox_network_default /
 * august_last_model), so a fresh session honors the wizard's choices. */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Loader2,
  Plug,
  RefreshCw,
  Rocket,
  Shield,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { providersApi, type Provider, type ProviderModel } from '@/api/providers';
import { AddProviderForm } from '@/sections/workspace/models/AddProviderForm';
import { useProviderOnboardingState } from '@/hooks/useProviderOnboardingState';
import { useSessionsStore } from '@/store/sessions';
import { PageLoader } from '@/components/PageLoader';
import type { SettingsSection } from '@/settings/settings-registry';

const STEPS = [
  { id: 'provider', label: 'Provider' },
  { id: 'test', label: 'Test' },
  { id: 'models', label: 'Models' },
  { id: 'default', label: 'Default' },
  { id: 'safety', label: 'Safety' },
  { id: 'start', label: 'Start' },
] as const;

type StepId = (typeof STEPS)[number]['id'];

const SANDBOX_OPTIONS = [
  {
    id: 'read-only',
    label: 'Read-only',
    description: 'August can read files and run non-mutating commands, but cannot write or delete.',
  },
  {
    id: 'workspace-write',
    label: 'Workspace-write (recommended)',
    description: 'Full access inside your project folder only; everything else is read-only.',
  },
  {
    id: 'danger-full-access',
    label: 'Danger — full access',
    description: 'No sandbox: August can change anything your user account can. Only for trusted projects.',
  },
] as const;

export function AISetupWizardSection({ active }: { active: SettingsSection }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const onboarding = useProviderOnboardingState();
  const sessions = useSessionsStore((s) => s.sessions);
  const hasWorkspace = sessions.some((s) => Boolean(s.workspacePath));

  const [step, setStep] = useState<StepId>('provider');
  const [addedProvider, setAddedProvider] = useState<Provider | null>(null);
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; content?: string; error?: string } | null>(null);
  const [defaultModel, setDefaultModel] = useState<ProviderModel | null>(null);
  const [sandboxMode, setSandboxMode] = useState<string>('workspace-write');
  const [showAddForm, setShowAddForm] = useState(false);

  const providers = onboarding.providers;
  const provider = providers.find((p) => p.id === providerId) ?? providers[0] ?? null;

  const models = useMemo(() => provider?.models ?? [], [provider]);
  const selectedModel = models.find((m) => m.id === modelId) ?? models[0] ?? null;

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  const test = useMutation({
    mutationFn: async () => {
      if (!provider || !selectedModel) throw new Error('Pick a provider and model first');
      return providersApi.connectModel(provider.id, selectedModel.id);
    },
    onSuccess: (res) => {
      // Same strict gate as the model-row Test button.
      const reallyOk = Boolean(res.success && res.content && res.content.trim().length > 0 && !res.error);
      setTestResult({
        ok: reallyOk,
        latencyMs: res.latencyMs ?? 0,
        content: res.content,
        error: reallyOk ? undefined : res.error || 'Model returned no text',
      });
      if (reallyOk) toast.success(`Connected in ${res.latencyMs ?? 0}ms`);
    },
    onError: (e: unknown) => {
      setTestResult({ ok: false, latencyMs: 0, error: e instanceof Error ? e.message : 'Test failed' });
    },
  });

  const refreshModels = useMutation({
    mutationFn: async () => {
      if (!provider) throw new Error('Add a provider first');
      const res = await providersApi.refreshModels(provider.id);
      await qc.invalidateQueries({ queryKey: ['providers'] });
      return res;
    },
    onSuccess: () => toast.success('Model list refreshed'),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Refresh failed'),
  });

  const canAdvance = (id: StepId): boolean => {
    switch (id) {
      case 'provider':
        return providers.length > 0 || Boolean(addedProvider);
      case 'test':
        return Boolean(provider && selectedModel);
      case 'models':
        return Boolean(provider);
      case 'default':
        return Boolean(defaultModel || selectedModel);
      case 'safety':
        return true;
      case 'start':
        return true;
    }
  };

  const goNext = () => {
    if (!canAdvance(step)) return;
    if (step === 'default' && (defaultModel ?? selectedModel)) {
      // Same key/format the chat thread persists on manual model switches.
      const m = defaultModel ?? selectedModel;
      if (provider && m) {
        try {
          localStorage.setItem('august_last_model', JSON.stringify({ id: m.id, name: m.id, provider: provider.id }));
        } catch { /* silent */ }
      }
    }
    if (step === 'safety') {
      try {
        localStorage.setItem('august_last_sandbox_mode', sandboxMode);
      } catch { /* silent */ }
    }
    setStep(STEPS[Math.min(stepIndex + 1, STEPS.length - 1)].id);
  };

  const goBack = () => setStep(STEPS[Math.max(stepIndex - 1, 0)].id);

  const finish = () => {
    try {
      localStorage.setItem('august_last_sandbox_mode', sandboxMode);
    } catch { /* silent */ }
    onboarding.markDone();
    toast.success('Setup complete — enjoy August');
    void qc.invalidateQueries({ queryKey: ['providers'] });
    navigate('/');
  };

  if (onboarding.isLoading) {
    return <PageLoader label="Checking setup state…" variant="card" className="py-16" />;
  }

  return (
    <div className="px-8 py-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Wand2 className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">AI Setup</h1>
          <p className="text-sm text-muted-foreground">
            {active.description} You can always change these later in Settings.
          </p>
        </div>
      </div>

      {/* Step rail */}
      <ol className="flex items-center gap-1.5">
        {STEPS.map((s, i) => {
          const done = i < stepIndex;
          const current = i === stepIndex;
          return (
            <li key={s.id} className="flex-1 min-w-0">
              <div className={`flex items-center gap-1.5 ${current ? 'text-primary' : done ? 'text-success' : 'text-muted-foreground/50'}`}>
                <span
                  className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold border ${
                    current ? 'border-primary/50 bg-primary/15'
                    : done ? 'border-success/40 bg-success/15'
                    : 'border-white/[0.08] bg-muted/30'
                  }`}
                  data-testid={`wizard-step-${s.id}`}
                >
                  {done ? <Check className="size-3" /> : i + 1}
                </span>
                <span className={`text-[11px] truncate ${current ? 'font-medium' : ''}`}>{s.label}</span>
              </div>
              {i < STEPS.length - 1 && <div className="mx-2 h-px flex-1 bg-white/[0.06] mt-2" />}
            </li>
          );
        })}
      </ol>

      {/* Step body */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-6 space-y-4" data-testid="wizard-body">
        {step === 'provider' && (
          <div className="space-y-4">
            <h2 className="text-base font-semibold">1 · Connect an AI provider</h2>
            <p className="text-xs text-muted-foreground">
              Anthropic, OpenAI, or any OpenAI-compatible endpoint. Your API key stays on this device.
            </p>
            {providers.length > 0 || addedProvider ? (
              <div className="space-y-2">
                {(providers.length > 0 ? providers : addedProvider ? [addedProvider] : []).map((p) => (
                  <div key={p.id} className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-muted/30 px-3 py-2 text-xs">
                    <Check className="size-3.5 text-success shrink-0" />
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted-foreground font-mono">{p.apiFormat}</span>
                    <span className={`ml-auto text-[10px] ${p.apiKeySet ? 'text-success' : 'text-amber-500'}`}>
                      {p.apiKeySet ? 'Key set' : 'No key yet'}
                    </span>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setShowAddForm((v) => !v)}
                  className="text-xs text-primary hover:underline"
                >
                  {showAddForm ? 'Hide form' : '+ Add another provider'}
                </button>
              </div>
            ) : null}
            {providers.length === 0 && !addedProvider || showAddForm ? (
              <div className="rounded-lg border border-white/[0.06] overflow-hidden">
                <AddProviderForm
                  onCancel={() => setShowAddForm(false)}
                  onCreated={(p) => {
                    setAddedProvider(p);
                    setProviderId(p.id);
                    setShowAddForm(false);
                    void qc.invalidateQueries({ queryKey: ['providers'] });
                  }}
                />
              </div>
            ) : null}
          </div>
        )}

        {step === 'test' && (
          <div className="space-y-4">
            <h2 className="text-base font-semibold">2 · Test the connection</h2>
            <p className="text-xs text-muted-foreground">
              August sends a minimal probe and expects an exact reply — a stricter check than a network ping.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[11px] text-muted-foreground">Provider</span>
                <select
                  value={provider?.id ?? ''}
                  onChange={(e) => { setProviderId(e.target.value); setModelId(''); setTestResult(null); }}
                  className="mt-1 w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
                  data-testid="wizard-provider-select"
                >
                  {(providers.length > 0 ? providers : addedProvider ? [addedProvider] : []).map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[11px] text-muted-foreground">Model</span>
                <select
                  value={selectedModel?.id ?? ''}
                  onChange={(e) => { setModelId(e.target.value); setTestResult(null); }}
                  className="mt-1 w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
                  data-testid="wizard-model-select"
                >
                  {(models.length > 0 ? models : []).map((m) => (
                    <option key={m.id} value={m.id}>{m.id}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={!provider || !selectedModel || test.isPending}
                onClick={() => test.mutate()}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50"
                data-testid="wizard-test"
              >
                {test.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                Test connection
              </button>
              {testResult ? (
                <span className={`text-xs ${testResult.ok ? 'text-success' : 'text-amber-500'}`}>
                  {testResult.ok
                    ? `Connected! ${testResult.latencyMs}ms`
                    : `Failed: ${testResult.error ?? 'no response'}`}
                </span>
              ) : null}
            </div>
          </div>
        )}

        {step === 'models' && (
          <div className="space-y-4">
            <h2 className="text-base font-semibold">3 · Discover models</h2>
            <p className="text-xs text-muted-foreground">
              Pull the provider&apos;s catalog from its /models endpoint (best-effort). You can add more later in Models &amp; Providers.
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={!provider || refreshModels.isPending}
                onClick={() => refreshModels.mutate()}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50"
                data-testid="wizard-refresh-models"
              >
                {refreshModels.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                Refresh model list
              </button>
              <span className="text-xs text-muted-foreground">
                {models.length > 0 ? `${models.length} models available` : 'No models yet — refresh to fetch them'}
              </span>
            </div>
            {models.length > 0 ? (
              <ul className="max-h-40 overflow-y-auto rounded-lg border border-white/[0.06] bg-muted/20 divide-y divide-white/[0.04]">
                {models.slice(0, 40).map((m) => (
                  <li key={m.id} className="px-3 py-1.5 text-xs font-mono text-foreground/80">{m.id}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        {step === 'default' && (
          <div className="space-y-4">
            <h2 className="text-base font-semibold">4 · Pick your default model</h2>
            <p className="text-xs text-muted-foreground">
              Used for new chats until you switch — the picker remembers your choice per chat.
            </p>
            {models.length === 0 ? (
              <p className="text-xs text-amber-500">No models yet — go back and refresh the model list.</p>
            ) : (
              <ul className="space-y-1.5 max-h-64 overflow-y-auto">
                {models.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => setDefaultModel(m)}
                      className={`w-full flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition ${
                        (defaultModel?.id ?? selectedModel?.id) === m.id
                          ? 'border-primary/40 bg-primary/10 text-foreground'
                          : 'border-white/[0.06] bg-muted/20 text-muted-foreground hover:text-foreground'
                      }`}
                      data-testid={`wizard-model-${m.id}`}
                    >
                      <span className={`size-3 rounded-full border ${(defaultModel?.id ?? selectedModel?.id) === m.id ? 'border-primary bg-primary' : 'border-muted-foreground/40'}`} />
                      <span className="font-mono">{m.id}</span>
                      {m.free ? <span className="ml-auto text-[10px] text-success">free</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === 'safety' && (
          <div className="space-y-4">
            <h2 className="text-base font-semibold">5 · Choose a safety mode</h2>
            <p className="text-xs text-muted-foreground">
              Applies to new sessions by default; you can change it per-chat from the composer shield.
            </p>
            <div className="space-y-2">
              {SANDBOX_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setSandboxMode(opt.id)}
                  className={`w-full flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition ${
                    sandboxMode === opt.id
                      ? 'border-primary/40 bg-primary/10'
                      : 'border-white/[0.06] bg-muted/20 hover:bg-muted/30'
                  }`}
                  data-testid={`wizard-sandbox-${opt.id}`}
                >
                  <span className={`mt-0.5 size-3 shrink-0 rounded-full border ${sandboxMode === opt.id ? 'border-primary bg-primary' : 'border-muted-foreground/40'}`} />
                  <span>
                    <span className="block text-xs font-medium text-foreground">{opt.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{opt.description}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="rounded-lg border border-white/[0.06] bg-muted/20 p-3">
              <div className="flex items-center gap-2">
                <FolderOpen className="size-4 text-primary shrink-0" />
                <span className="text-xs text-muted-foreground">
                  {hasWorkspace ? 'Workspace folder: set ✓' : 'No project folder yet — optional, but August works best with one.'}
                </span>
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('august:open-folder'))}
                  className="ml-auto inline-flex items-center gap-1 rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px] text-foreground hover:bg-muted"
                  data-testid="wizard-open-folder"
                >
                  <FolderOpen className="size-3" />
                  {hasWorkspace ? 'Change' : 'Open folder'}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 'start' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Shield className="size-6 text-success" />
              <div>
                <h2 className="text-base font-semibold">6 · You&apos;re all set</h2>
                <p className="text-xs text-muted-foreground">
                  {provider?.name ?? 'A provider'} · {(defaultModel?.id ?? selectedModel?.id) ?? 'default model'} · {SANDBOX_OPTIONS.find((o) => o.id === sandboxMode)?.label}
                </p>
              </div>
            </div>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              <li className="flex gap-2"><Sparkles className="size-3.5 text-primary shrink-0" /> Chat with tool-calling agents that can read and edit your workspace.</li>
              <li className="flex gap-2"><Shield className="size-3.5 text-success shrink-0" /> Safety mode is set to {SANDBOX_OPTIONS.find((o) => o.id === sandboxMode)?.label}.</li>
              <li className="flex gap-2"><Wand2 className="size-3.5 text-primary shrink-0" /> Everything here is changeable later in Settings.</li>
            </ul>
            <button
              type="button"
              onClick={finish}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
              data-testid="wizard-finish"
            >
              <Rocket className="size-4" />
              Start chatting
            </button>
          </div>
        )}
      </div>

      {/* Footer nav */}
      <div className="flex items-center justify-between">
        {stepIndex > 0 ? (
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            data-testid="wizard-back"
          >
            <ChevronLeft className="size-3.5" />
            Back
          </button>
        ) : (
          <span />
        )}
        {step !== 'start' ? (
          <button
            type="button"
            disabled={!canAdvance(step)}
            onClick={goNext}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-xs text-primary-foreground disabled:opacity-40"
            data-testid="wizard-next"
          >
            Next
            <ChevronRight className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => { onboarding.skip(); navigate('/'); }}
          className="text-[11px] text-muted-foreground/60 hover:text-muted-foreground"
          data-testid="wizard-skip"
        >
          Skip setup
        </button>
      </div>
    </div>
  );
}
