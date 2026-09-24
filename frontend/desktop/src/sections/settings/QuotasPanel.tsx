/* ── QuotasPanel — per-model daily quota bars ──────────────────────── */
/* Renders daily token quota usage bars for each model. Usable as a
 * Model Providers subtab or embedded elsewhere without the full models UI. */

import { useQuery } from '@tanstack/react-query';
import { quotaApi, type ModelQuota } from '@/api/quota';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { PageLoader } from '@/components/PageLoader';
import { QueryErrorState } from '@/components/QueryErrorState';
import { Gauge, Inbox } from 'lucide-react';

function formatQuotaNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatResetTime(iso: string | null): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes <= 0) return 'resets now';
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `resets in ${hours}h`;
  return `resets ${new Date(at).toLocaleDateString()}`;
}

function QuotaRow({ q }: { q: ModelQuota }) {
  const isNative = q.source === 'native';
  const hasLimit = q.limit != null && q.limit > 0;
  const resetLabel = formatResetTime(q.resetsAt);
  // Native rows show the provider's own accounting: limit − remaining. A
  // limit with no remaining count can only be shown as the cap itself.
  // Local rows have no cap, so they only show what August spent.
  const usedText = isNative
    ? q.nativeUsed != null
      ? formatQuotaNumber(q.nativeUsed)
      : q.remaining != null
        ? `${formatQuotaNumber(q.remaining)} left`
        : '—'
    : formatQuotaNumber(q.used);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-foreground truncate">{q.model || 'account'}</span>
          <Badge variant="outline" className="text-[9px] py-0 h-4">{q.source}</Badge>
        </div>
        <div className="font-mono tabular-nums text-muted-foreground shrink-0 text-[11px]">
          {hasLimit ? (
            <span className="text-foreground">
              {usedText} / {formatQuotaNumber(q.limit!)}
              {isNative && q.nativeUsed != null ? ` (${q.percent.toFixed(1)}%)` : ''}
            </span>
          ) : (
            <span className="text-foreground">{usedText}</span>
          )}
        </div>
      </div>
      {isNative && hasLimit && (
        <div
          className="h-1.5 rounded-full bg-muted overflow-hidden"
          role="progressbar"
          aria-valuenow={Math.round(q.percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${q.model || 'Account'} provider-reported usage`}
        >
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${Math.max(1, Math.min(100, q.percent))}%`,
              backgroundColor: q.percent > 90 ? 'var(--dt-danger)' : q.percent > 70 ? 'var(--dt-warning)' : 'var(--dt-success)',
            }}
          />
        </div>
      )}
      {/* Every row says where its numbers came from — a local estimate is
          August's own token count, never a provider cap. */}
      <p className="text-[10px] text-muted-foreground font-mono">
        {isNative ? 'Reported by provider' : 'Local estimate'}
        {resetLabel ? ` · ${resetLabel}` : ''}
      </p>
    </div>
  );
}

export function QuotasPanel() {
  const all = useQuery({
    queryKey: ['quota', 'all'],
    queryFn: () => quotaApi.all(),
    refetchInterval: 30_000,
  });

  if (all.isLoading) {
    return <PageLoader label="Loading quota…" className="px-0 py-2" />;
  }
  if (all.isError && !all.data) {
    return (
      <QueryErrorState
        error={all.error}
        onRetry={() => void all.refetch()}
        retrying={all.isFetching}
        title="Couldn't load usage"
      />
    );
  }
  const data = all.data?.results || [];
  if (data.length === 0) {
    return (
      <SettingsEmptyState
        icon={Inbox}
        title="No quota data yet"
        description="Once a provider reports a rate limit, or August records local model usage, the counters for this window will appear here."
      />
    );
  }

  return (
    <div className="space-y-4">
      {data.map(({ provider, quotas }) => {
        const nativeCount = quotas.filter((q) => q.source === 'native').length;
        return (
        <Card key={provider}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Gauge className="size-4 text-muted-foreground" />
                {provider}
              </CardTitle>
              <span className="text-[10px] text-muted-foreground font-mono">
                {quotas.length} row{quotas.length === 1 ? '' : 's'}
                {nativeCount > 0 ? ` · ${nativeCount} provider-reported` : ' · local usage window'}
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {quotas.map((q) => (
              <QuotaRow key={`${q.model}:${q.source}`} q={q} />
            ))}
          </CardContent>
        </Card>
        );
      })}
    </div>
  );
}
