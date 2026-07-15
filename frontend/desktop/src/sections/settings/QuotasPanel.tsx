/* ── QuotasPanel — per-model daily quota bars ──────────────────────── */
/* Renders daily token quota usage bars for each model. Usable as a
 * Model Providers subtab or embedded elsewhere without the full models UI. */

import { useQuery } from '@tanstack/react-query';
import { quotaApi, type ModelQuota } from '@/api/quota';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { Gauge, Inbox } from 'lucide-react';

function formatQuotaNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function QuotaRow({ q }: { q: ModelQuota }) {
  const hasLimit = q.limit != null && q.limit > 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-foreground truncate">{q.model || 'unknown'}</span>
          <Badge variant="outline" className="text-[9px] py-0 h-4">{q.source}</Badge>
        </div>
        <div className="font-mono tabular-nums text-muted-foreground shrink-0 text-[11px]">
          {hasLimit ? (
            <>
              <span className="text-foreground">{formatQuotaNumber(q.used)}</span> / {formatQuotaNumber(q.limit!)} ({q.percent.toFixed(1)}%)
            </>
          ) : (
            <span className="text-foreground">{formatQuotaNumber(q.used)}</span>
          )}
        </div>
      </div>
      {hasLimit && (
        <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${Math.max(1, Math.min(100, q.percent))}%`,
              backgroundColor: q.percent > 90 ? '#f87171' : q.percent > 70 ? '#f59e0b' : '#4ade80',
            }}
          />
        </div>
      )}
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
    return <div className="text-sm text-muted-foreground">Loading quota…</div>;
  }
  const data = all.data?.results || [];
  if (data.length === 0) {
    return (
      <SettingsEmptyState
        icon={Inbox}
        title="No quota data yet"
        description="Once adapters record usage, your daily model quotas will appear here."
      />
    );
  }

  return (
    <div className="space-y-4">
      {data.map(({ provider, quotas }) => (
        <Card key={provider}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Gauge className="size-4 text-muted-foreground" />
                {provider}
              </CardTitle>
              <span className="text-[10px] text-muted-foreground font-mono">
                {quotas.length} model{quotas.length === 1 ? '' : 's'} · resets at{' '}
                {new Date(quotas[0]?.resetsAt || Date.now()).toUTCString().slice(17, 22)} UTC
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {quotas.map((q) => (
              <QuotaRow key={q.model} q={q} />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
