/* ── Provider Onboarding Modal ────────────────────────────────────────── */
/* First-launch modal shown when the providers list is empty and the user
   has not previously skipped onboarding. Offers three paths:
   1) "Set Up a Provider" — navigates to /settings/providers
   2) "Import Config" — paste JSON blob → POST /api/providers/import-config
   3) "Skip for now" — sets localStorage flag, modal won't show again. */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Cloud, Upload, X } from 'lucide-react';
import { useProviderOnboardingState } from '@/hooks/useProviderOnboardingState';
import { providersApi } from '@/api/providers';
import { Backdrop } from '@/components/overlays/Backdrop';

export function ProviderOnboardingModal() {
  const { shouldShow, skip, isLoading } = useProviderOnboardingState();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showImport, setShowImport] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);

  if (!shouldShow || isLoading) return null;

  const handleSetUpProvider = () => {
    navigate('/settings/providers');
  };

  const handleImport = async () => {
    setImportError('');
    setImporting(true);
    try {
      const config = JSON.parse(importJson);
      await providersApi.importConfig(config);
      qc.invalidateQueries({ queryKey: ['providers'] });
      qc.invalidateQueries({ queryKey: ['aggregated-models'] });
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

  return (
    <Backdrop onClose={skip}>
      <div
        className="relative w-full max-w-md rounded-2xl border border-white/[0.06] bg-card p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Provider setup"
      >
        <button
          type="button"
          onClick={skip}
          className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="size-4" />
        </button>

        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <Cloud className="size-6 text-primary" />
          </div>
          <h2 className="text-lg font-semibold">Welcome to August</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect an AI provider to start chatting. You can add multiple
            providers and switch between them at any time.
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
                onClick={handleImport}
                disabled={!importJson.trim() || importing}
                className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {importing ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <button
              type="button"
              onClick={handleSetUpProvider}
              className="flex w-full items-center gap-3 rounded-xl border border-white/[0.06] bg-black/20 px-4 py-3 text-left hover:bg-white/[0.06] transition-colors"
            >
              <Cloud className="size-5 text-primary shrink-0" />
              <div>
                <p className="text-sm font-medium">Set Up a Provider</p>
                <p className="text-xs text-muted-foreground">
                  Configure Anthropic, OpenAI, or any OpenAI-compatible endpoint
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setShowImport(true)}
              className="flex w-full items-center gap-3 rounded-xl border border-white/[0.06] bg-black/20 px-4 py-3 text-left hover:bg-white/[0.06] transition-colors"
            >
              <Upload className="size-5 text-primary shrink-0" />
              <div>
                <p className="text-sm font-medium">Import Config</p>
                <p className="text-xs text-muted-foreground">
                  Paste a JSON configuration from clipboard or export
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={skip}
              className="flex w-full items-center justify-center rounded-xl px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Skip for now
            </button>
          </div>
        )}
      </div>
    </Backdrop>
  );
}
