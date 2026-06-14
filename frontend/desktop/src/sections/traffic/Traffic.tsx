import { useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useQuery } from '@tanstack/react-query';
import { SectionHeader } from '@/components/SectionHeader';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/StatusPill';
import { formatDuration, formatTimeAgo } from '@/lib/utils';
import {
  getRequests,
  getStats,
  getActivity,
  type RequestEntry,
  type Period,
} from '@/api/backend-ui';

/** A normalized row so the table renderer can stay mock-shape-agnostic. */
interface TrafficRow {
  reqId: string;
  clientType: string;
  endpoint: string;
  model: string;
  status: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  timestamp: number | string;
}

function toRow(r: RequestEntry): TrafficRow {
  return {
    reqId: r.reqId,
    clientType: r.clientType || 'unknown',
    endpoint: r.endpoint || '',
    model: r.model || 'unknown',
    status: r.status || 'unknown',
    durationMs: r.durationMs || 0,
    inputTokens: r.inputTokens || 0,
    outputTokens: r.outputTokens || 0,
    totalCost: r.totalCost || 0,
    timestamp: r.timestamp || r.date || r.time || Date.now(),
  };
}

const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: '7d' },
  { key: 'month', label: '30d' },
  { key: 'all', label: 'All' },
];

export function Traffic() {
  const [period, setPeriod] = useState<Period>('today');
  const [filter, setFilter] = useState<'all' | 'ok' | 'err'>('all');

  const { data: reqData, isLoading: reqLoading } = useQuery({
    queryKey: ['requests', period],
    queryFn: () => getRequests(period),
    refetchInterval: 3_000,
  });
  const { data: stats } = useQuery({
    queryKey: ['stats', period],
    queryFn: () => getStats(period),
    refetchInterval: 5_000,
  });
  const { data: activity } = useQuery({
    queryKey: ['activity'],
    queryFn: () => getActivity(),
    refetchInterval: 5_000,
  });

  const pending = reqData?.pending ?? [];
  const completed = (reqData?.completed ?? []).map(toRow);
  const rows = filter === 'all'
    ? completed
    : filter === 'err'
      ? completed.filter((r) => r.status === 'error')
      : completed.filter((r) => r.status !== 'error');

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => document.getElementById('traffic-scroll') as HTMLDivElement | null,
    estimateSize: () => 36,
    overscan: 12,
  });

  const errCount = stats?.errorRequests ?? rows.filter((r) => r.status === 'error').length;

  return (
    <div className="p-6 space-y-4 flex flex-col h-full">
      <SectionHeader
        title="Traffic"
        subtitle={
          stats
            ? `${stats.totalRequests} requests · ${errCount} errors · ${stats.pendingRequests} pending · avg ${formatDuration(stats.avgDurationMs)}`
            : reqLoading ? 'Loading traffic…' : 'No traffic data yet'
        }
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-[10px]">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => setPeriod(p.key)}
                  className={joinClasses(
                    'rounded-md px-2 py-1 font-mono transition',
                    period === p.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 text-[10px]">
              {(['all', 'ok', 'err'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={joinClasses(
                    'rounded-md px-2 py-1 font-mono transition',
                    filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                  )}
                >
                  {f === 'ok' ? '2xx' : f === 'err' ? 'errors' : 'all'}
                </button>
              ))}
            </div>
          </div>
        }
      />

      {/* Stat cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Requests" value={stats.totalRequests.toLocaleString()} hint={`${stats.completedRequests} done`} />
          <StatCard
            label="Tokens"
            value={(stats.totalInputTokens + stats.totalOutputTokens).toLocaleString()}
            hint={`${stats.totalInputTokens.toLocaleString()} in · ${stats.totalOutputTokens.toLocaleString()} out`}
          />
          <StatCard label="Est. cost" value={`$${stats.estimatedTotalCost.toFixed(4)}`} hint={`avg ${formatDuration(stats.avgDurationMs)}`} />
          <StatCard label="Top model" value={stats.mostUsedModel || '—'} hint={stats.mostUsedModel ? `${stats.mostUsedCount} calls` : 'n/a'} />
        </div>
      )}

      {pending.length > 0 && (
        <Card className="px-3 py-2">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-mono">
            <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
            {pending.length} pending
          </div>
          <div className="space-y-1">
            {pending.map((p) => (
              <div key={p.reqId} className="flex items-center gap-3 text-xs font-mono">
                <span className="text-muted-foreground">{p.clientType}</span>
                <span className="truncate flex-1">{p.endpoint}</span>
                <span className="text-muted-foreground">{p.model}</span>
                <span className="tabular-nums text-amber-600">{formatDuration(p.elapsedMs)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="flex-1 flex flex-col overflow-hidden min-h-[260px]">
        <div className="grid grid-cols-[70px_90px_1fr_120px_90px_90px_90px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border font-mono">
          <span>Status</span>
          <span>Client</span>
          <span>Endpoint</span>
          <span>Model</span>
          <span className="text-right">Duration</span>
          <span className="text-right">Tokens</span>
          <span className="text-right">Cost</span>
        </div>
        <div id="traffic-scroll" className="flex-1 overflow-auto">
          {rows.length === 0 ? (
            <div className="h-full grid place-items-center text-xs text-muted-foreground">
              No requests in this period
            </div>
          ) : (
            <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {virt.getVirtualItems().map((row) => {
                const r = rows[row.index];
                const isError = r.status === 'error';
                return (
                  <div
                    key={r.reqId}
                    data-index={row.index}
                    ref={(el) => { if (el) virt.measureElement(el); }}
                    style={{ position: 'absolute', top: row.start, left: 0, right: 0 }}
                    className="grid grid-cols-[70px_90px_1fr_120px_90px_90px_90px] gap-2 px-3 py-2 text-xs items-center border-b border-border/40 hover:bg-accent/30 font-mono"
                  >
                    {isError ? (
                      <StatusPill tone="bad" label={r.status.slice(0, 8)} />
                    ) : (
                      <Badge variant="outline" className="w-fit">{r.status.slice(0, 8)}</Badge>
                    )}
                    <span className="text-muted-foreground truncate">{r.clientType}</span>
                    <span className="truncate" title={r.endpoint}>{r.endpoint}</span>
                    <span className="truncate text-muted-foreground">{r.model}</span>
                    <span className="text-right tabular-nums">{formatDuration(r.durationMs)}</span>
                    <span className="text-right tabular-nums">{(r.inputTokens + r.outputTokens).toLocaleString()}</span>
                    <span className="text-right tabular-nums">${r.totalCost.toFixed(4)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground font-mono flex items-center gap-3">
          <span>{rows.length} rows</span>
          <span>·</span>
          <span>last: {rows[0] ? formatTimeAgo(rows[0].timestamp) : '—'}</span>
          {activity && activity.length > 0 && (
            <>
              <span>·</span>
              <span className="truncate">recent: {activity[0]?.detail || activity[0]?.type}</span>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-base font-semibold tabular-nums truncate">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground font-mono truncate">{hint}</p>}
    </Card>
  );
}

function joinClasses(...args: (string | false | undefined | null)[]): string {
  return args.filter(Boolean).join(' ');
}
