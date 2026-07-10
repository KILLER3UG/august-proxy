/**
 * ProviderSetupWidget — inline API-key field shown in the chat when the
 * model has pre-filled a provider via the `setup_provider` tool but left the
 * key for the user to paste.
 *
 * The model drives everything except the secret: it uses web_search to find
 * the provider's base URL + API format, suggests a name, and calls
 * setup_provider without a key. This widget then collects the key from the
 * user and PATCHes it to /api/providers/{id} (never through the model text).
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Key, Check, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { providersApi } from '@/api/providers';
import type { ProviderSetupResult } from '@/types/chat';

function formatLabel(value?: string): string {
  if (!value) return '—';
  return value;
}

export function ProviderSetupWidget({ setup }: { setup: ProviderSetupResult }) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState<'idle' | 'ok' | 'err'>('idle');
  const [message, setMessage] = useState('');

  const providerId = setup.providerId ?? '';
  const canApply = key.trim().length > 0 && !applying && providerId.length > 0;

  const apply = async () => {
    if (!canApply) return;
    setApplying(true);
    setStatus('idle');
    setMessage('');
    try {
      await providersApi.applyKey(providerId, key.trim());
      queryClient.invalidateQueries({ queryKey: ['providers'] });
      queryClient.invalidateQueries({ queryKey: ['model-options'] });
      queryClient.invalidateQueries({ queryKey: ['aggregated-models'] });
      setStatus('ok');
      setMessage('API key saved. This provider is ready to use.');
      setKey('');
    } catch (e) {
      setStatus('err');
      setMessage(e instanceof Error ? e.message : 'Failed to save API key');
    } finally {
      setApplying(false);
    }
  };

  if (setup.status === 'error') {
    return (
      <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
        Provider setup failed: {setup.error || 'unknown error'}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-primary/25 bg-card/70 p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-primary/80 font-semibold">
        <ShieldCheck className="size-3" />
        Provider ready — paste your API key
      </div>

      <div className="grid grid-cols-1 gap-1.5 rounded-md bg-background/60 p-2 text-[11px]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Name</span>
          <span className="font-medium text-foreground truncate">{formatLabel(setup.name || setup.suggestedName)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Base URL</span>
          <span className="font-mono text-foreground/90 truncate">{formatLabel(setup.baseUrl)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">API format</span>
          <span className="font-mono text-foreground/90 truncate">{formatLabel(setup.apiFormat)}</span>
        </div>
      </div>

      {status === 'ok' ? (
        <div className="flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 p-2 text-xs text-success">
          <Check className="size-3.5" />
          {message}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') apply();
              }}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-background px-3 py-2 pr-10 text-xs outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition font-mono"
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showKey ? 'Hide key' : 'Show key'}
            >
              {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>

          <div className="flex items-center justify-end gap-2">
            {status === 'err' && (
              <span className="text-[10px] text-destructive truncate mr-auto">{message}</span>
            )}
            <Button type="button" size="sm" onClick={apply} disabled={!canApply}>
              {applying ? <Loader2 className="size-3 mr-1 animate-spin" /> : <Key className="size-3 mr-1" />}
              {applying ? 'Saving…' : 'Apply key'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
