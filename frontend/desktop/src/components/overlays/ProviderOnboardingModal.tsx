/* ── First-run setup checklist ────────────────────────────────────────── */
/* Multi-step checklist: provider → workspace → optional Google.           */
/* Replaces the old provider-only onboarding modal.                        */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Circle,
  Cloud,
  FolderOpen,
  Mail,
  Activity,
  Upload,
  X,
} from 'lucide-react';
import { useProviderOnboardingState } from '@/hooks/useProviderOnboardingState';
import { providersApi } from '@/api/providers';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import { Backdrop } from '@/components/overlays/Backdrop';
import { cn } from '@/lib/utils';

const ICONS = {
  provider: Cloud,
  workspace: FolderOpen,
  google: Mail,
  doctor: Activity,
} as const;

export function ProviderOnboardingModal() {
  const {
    shouldShow,
    skip,
    markDone,
    isLoading,
    checks,
    allCoreDone,
    hasProvider,
  } = useProviderOnboardingState();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showImport, setShowImport] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);

  if (!shouldShow || isLoading) return null;

  const handleImport = async () => {
    setImportError('');
    setImporting(true);
    try {
      const config = JSON.parse(importJson);
      await providersApi.importConfig(config);
      void refreshProviderCatalog(qc);
      setShowImport(false);
      setImportJson('');
    } catch (e: unknown) {
      setImportError(
        e instanceof Error ? e.message : 'Invalid JSON or import failed.',
      );
    } finally {
      setImporting(false);
    }
  };

  const go = (href?: string) => {
    if (!href) return;
    void navigate(href);
  };

  return (
    <Backdrop onClose={skip}>
      <div
        className="relative w-full max-w-md rounded-2xl border border-white/[0.06] bg-card p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="August setup checklist"
        data-testid="setup-checklist-modal"
      >
        <button
          type="button"
          onClick={skip}
          className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="size-4" />
        </button>

        <div className="mb-5 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <Cloud className="size-6 text-primary" />
          </div>
          <h2 className="text-lg font-semibold">Set up August</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A short checklist so chat, files, and integrations work on first run.
          </p>
        </div>

        {showImport ? (
          <div className="space-y-3">
            <label className="block text-xs font-medium text-muted-foreground">
              Paste provider config JSON
            </label>
            <textarea
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
              placeholder='{"name": "My Provider", "baseUrl": "https://...", "apiKey": "sk-..."}'
              rows={6}
              className="w-full rounded-lg border border-white/[0.06] bg-black/20 p-3 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:border-primary outline-none resize-none"
            />
            {importError && (
              <p className="text-xs text-destructive">{importError}</p>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowImport(false)}
                className="flex-1 rounded-lg border border-white/[0.06] px-4 py-2 text-sm hover:bg-white/[0.06]"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleImport();
                }}
                disabled={!importJson.trim() || importing}
                className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {importing ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <ul className="space-y-2">
              {checks.map((item) => {
                const Icon = ICONS[item.id];
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => go(item.href)}
                      className={cn(
                        'flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
                        item.done
                          ? 'border-emerald-500/25 bg-emerald-500/5'
                          : 'border-white/[0.06] bg-black/20 hover:bg-white/[0.06]',
                      )}
                    >
                      {item.done ? (
                        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-400" />
                      ) : (
                        <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Icon className="size-3.5 text-primary shrink-0" />
                          <p className="text-sm font-medium">
                            {item.label}
                            {item.optional && (
                              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                                optional
                              </span>
                            )}
                          </p>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {item.description}
                        </p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>

            {!hasProvider && (
              <button
                type="button"
                onClick={() => setShowImport(true)}
                className="flex w-full items-center gap-3 rounded-xl border border-white/[0.06] bg-black/20 px-4 py-3 text-left hover:bg-white/[0.06] transition-colors"
              >
                <Upload className="size-5 text-primary shrink-0" />
                <div>
                  <p className="text-sm font-medium">Import provider config</p>
                  <p className="text-xs text-muted-foreground">
                    Paste a JSON configuration from clipboard or export
                  </p>
                </div>
              </button>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={skip}
                className="flex-1 rounded-xl px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Skip for now
              </button>
              <button
                type="button"
                onClick={markDone}
                disabled={!allCoreDone && !hasProvider}
                className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
                title={
                  allCoreDone
                    ? 'Mark setup complete'
                    : hasProvider
                      ? 'Continue with provider only'
                      : 'Connect a provider first'
                }
              >
                {allCoreDone ? 'Done' : hasProvider ? 'Continue' : 'Need a provider'}
              </button>
            </div>
          </div>
        )}
      </div>
    </Backdrop>
  );
}
