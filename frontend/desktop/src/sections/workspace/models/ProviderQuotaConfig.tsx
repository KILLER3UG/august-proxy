/* ProviderQuotaConfig — opt-in provider quota endpoint editor.
 *
 * August never invents a provider's quota. It shows a real one in two cases:
 * standard x-ratelimit headers the provider already returns, and — configured
 * here — a user-declared quota endpoint whose JSON paths the user names. The
 * section stays collapsed and empty by default so no provider is ever polled
 * for a quota the user did not ask for.
 */

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import type { Provider, QuotaAuth, QuotaEndpoint, QuotaExtract } from '@/api/providers';
import { WorkspaceField } from '@/components/workspace/WorkspaceField';
import { WorkspaceSelect } from '@/components/workspace/WorkspaceSelect';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const AUTH_TYPES = [
  { value: 'none', label: 'None' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'header', label: 'Custom header' },
  { value: 'query', label: 'Query parameter' },
];

interface Props {
  provider: Provider;
  onSave: (patch: { quotaEndpoint?: QuotaEndpoint | null; quotaAuth?: QuotaAuth | null }) => void;
  pending?: boolean;
}

export function ProviderQuotaConfig({ provider, onSave, pending }: Props) {
  const [open, setOpen] = useState(!!provider.quotaEndpoint?.url);
  const [url, setUrl] = useState(provider.quotaEndpoint?.url ?? '');
  const [method, setMethod] = useState<'GET' | 'POST'>(provider.quotaEndpoint?.method ?? 'GET');
  const [authType, setAuthType] = useState<NonNullable<QuotaAuth['type']>>(provider.quotaAuth?.type ?? 'none');
  const [authHeader, setAuthHeader] = useState(provider.quotaAuth?.header ?? '');
  const [authParam, setAuthParam] = useState(provider.quotaAuth?.param ?? '');
  const [limit, setLimit] = useState(provider.quotaEndpoint?.extract?.limit ?? '');
  const [remaining, setRemaining] = useState(provider.quotaEndpoint?.extract?.remaining ?? '');
  const [used, setUsed] = useState(provider.quotaEndpoint?.extract?.used ?? '');
  const [reset, setReset] = useState(provider.quotaEndpoint?.extract?.reset ?? '');

  useEffect(() => {
    setOpen(!!provider.quotaEndpoint?.url);
    setUrl(provider.quotaEndpoint?.url ?? '');
    setMethod(provider.quotaEndpoint?.method ?? 'GET');
    setAuthType(provider.quotaAuth?.type ?? 'none');
    setAuthHeader(provider.quotaAuth?.header ?? '');
    setAuthParam(provider.quotaAuth?.param ?? '');
    setLimit(provider.quotaEndpoint?.extract?.limit ?? '');
    setRemaining(provider.quotaEndpoint?.extract?.remaining ?? '');
    setUsed(provider.quotaEndpoint?.extract?.used ?? '');
    setReset(provider.quotaEndpoint?.extract?.reset ?? '');
  }, [provider.id, provider.quotaEndpoint, provider.quotaAuth]);

  function buildEndpoint(overrides?: { method?: 'GET' | 'POST' }): QuotaEndpoint | null {
    const trimmed = url.trim();
    if (!trimmed) return null;
    const extract: QuotaExtract = {
      limit: limit.trim(),
      remaining: remaining.trim(),
      used: used.trim(),
      reset: reset.trim(),
    };
    return { kind: 'json', url: trimmed, method: overrides?.method ?? method, extract };
  }

  function buildAuth(overrides?: { type?: NonNullable<QuotaAuth['type']> }): QuotaAuth | null {
    const type = overrides?.type ?? authType;
    if (type === 'none') return null;
    const auth: QuotaAuth = { type, useProviderKey: true };
    if (type === 'header') auth.header = authHeader.trim();
    if (type === 'query') auth.param = authParam.trim();
    return auth;
  }

  function save(overrides?: { method?: 'GET' | 'POST'; authType?: NonNullable<QuotaAuth['type']> }) {
    onSave({
      quotaEndpoint: buildEndpoint({ method: overrides?.method }),
      quotaAuth: buildAuth({ type: overrides?.authType }),
    });
  }

  function clear() {
    setUrl('');
    setLimit('');
    setRemaining('');
    setUsed('');
    setReset('');
    setAuthType('none');
    setAuthHeader('');
    setAuthParam('');
    onSave({ quotaEndpoint: null, quotaAuth: null });
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card/30 p-3 space-y-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs font-medium text-foreground/80 hover:text-foreground transition"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        Quota endpoint
        <span className="text-[10px] text-muted-foreground font-normal">
          {provider.quotaEndpoint?.url ? provider.quotaEndpoint.url : 'not configured'}
        </span>
      </button>

      {open && (
        <>
          <p className="text-[11px] text-muted-foreground">
            Optional. August shows a provider-reported quota only when the provider states one —
            from its own rate-limit headers, or from the endpoint below. A relative path is joined
            onto the base URL exactly as pasted (no <span className="font-mono">/v1</span> is added).
          </p>

          <div className="grid grid-cols-[2fr_1fr] gap-3">
            <WorkspaceField label="Quota URL" hint="Absolute URL, or a path appended to the base URL.">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => save()}
                placeholder="https://api.example.com/usage"
                aria-label="Quota URL"
              />
            </WorkspaceField>
            <WorkspaceField label="Method">
              <WorkspaceSelect
                value={method}
                onChange={(e) => {
                  const next = e.target.value as 'GET' | 'POST';
                  setMethod(next);
                  save({ method: next });
                }}
                options={[
                  { value: 'GET', label: 'GET' },
                  { value: 'POST', label: 'POST' },
                ]}
              />
            </WorkspaceField>
          </div>

          <WorkspaceField label="Authentication" hint="Defaults to reusing the provider API key.">
            <WorkspaceSelect
              value={authType}
              onChange={(e) => {
                const next = e.target.value as NonNullable<QuotaAuth['type']>;
                setAuthType(next);
                save({ authType: next });
              }}
              options={AUTH_TYPES}
            />
          </WorkspaceField>

          {authType === 'header' && (
            <WorkspaceField label="Header name">
              <Input
                value={authHeader}
                onChange={(e) => setAuthHeader(e.target.value)}
                onBlur={() => save()}
                placeholder="x-api-key"
                aria-label="Quota auth header"
              />
            </WorkspaceField>
          )}
          {authType === 'query' && (
            <WorkspaceField label="Query parameter">
              <Input
                value={authParam}
                onChange={(e) => setAuthParam(e.target.value)}
                onBlur={() => save()}
                placeholder="api_key"
                aria-label="Quota auth query parameter"
              />
            </WorkspaceField>
          )}

          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground/80">JSON paths</p>
            <p className="text-[11px] text-muted-foreground">
              Dotted paths into the response, e.g. <span className="font-mono">data.quota.limit</span> or{' '}
              <span className="font-mono">data.items[0].remaining</span>. Leave a path blank when the
              provider does not state that value — blanks are never read as zero.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <WorkspaceField label="Limit">
                <Input value={limit} onChange={(e) => setLimit(e.target.value)} onBlur={() => save()} placeholder="data.quota.limit" aria-label="Limit path" />
              </WorkspaceField>
              <WorkspaceField label="Remaining">
                <Input value={remaining} onChange={(e) => setRemaining(e.target.value)} onBlur={() => save()} placeholder="data.quota.remaining" aria-label="Remaining path" />
              </WorkspaceField>
              <WorkspaceField label="Used" hint="Optional — used when the provider states spend instead of remaining.">
                <Input value={used} onChange={(e) => setUsed(e.target.value)} onBlur={() => save()} placeholder="data.quota.used" aria-label="Used path" />
              </WorkspaceField>
              <WorkspaceField label="Reset">
                <Input value={reset} onChange={(e) => setReset(e.target.value)} onBlur={() => save()} placeholder="data.quota.reset_at" aria-label="Reset path" />
              </WorkspaceField>
            </div>
          </div>

          <button
            type="button"
            onClick={clear}
            disabled={pending}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1.5',
              'text-xs text-muted-foreground hover:text-foreground hover:border-foreground/40 transition disabled:opacity-50',
            )}
          >
            <Trash2 className="size-3.5" />
            Clear quota endpoint
          </button>
        </>
      )}
    </div>
  );
}
