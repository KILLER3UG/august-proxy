/* ── WorkspaceTrafficSection — live traffic dashboard in workspace ──── */
/* Reuses useTrafficActivity (already deep-consolidated). Shows stat
 * cards using the workspace primitives, then the existing virtualized
 * request table + merged log feed via the shared hook. */

import { useState } from 'react';
import { Activity, Search, ScrollText } from 'lucide-react';
import {
  useTrafficActivity,
  applyStatusFilter,
  type StatusFilter,
} from '@/sections/settings/useTrafficActivity';
import { WorkspaceStatCard } from '@/components/workspace/WorkspaceStatCard';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { useVirtualizer } from '@tanstack/react-virtual';
import { StatusPill } from '@/components/StatusPill';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatDuration, formatTimeAgo, cn } from '@/lib/utils';
import { type Period } from '@/api/backend-ui';

const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: '7d' },
  { key: 'month', label: '30d' },
  { key: 'all', label: 'All' },
];

export function WorkspaceTrafficSection() {
  const [period, setPeriod] = useState<Period>('today');
  const [tab, setTab] = useState<string>('overview');
  const data = useTrafficActivity(period);

  return (
    <div className="px-8 py-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Traffic</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live request stream, errors, and average duration.
          </p>
        </div>
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-muted-foreground/70 uppercase tracking-wider mr-1">Period</span>
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={cn(
                'rounded-md px-2 py-1 font-mono transition',
                period === p.key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <SettingsTabs
        value={tab}
        onChange={setTab}
        items={[
          { key: 'overview', label: 'Overview', icon: Activity },
          { key: 'requests', label: 'Requests', icon: Search },
          { key: 'logs', label: 'Logs', icon: ScrollText },
        ]}
        label="Traffic views"
      />

      {tab === 'overview' && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <WorkspaceStatCard icon={Activity} label="Requests" value={data.stats?.totalRequests.toLocaleString() ?? '—'} sub={`${data.stats?.completedRequests.toLocaleString() ?? 0} done`} accent="blue" />
          <WorkspaceStatCard icon={Activity} label="Tokens" value={(data.stats?.totalInputTokens ?? 0) + (data.stats?.totalOutputTokens ?? 0) > 0 ? ((data.stats!.totalInputTokens + data.stats!.totalOutputTokens)).toLocaleString() : '—'} sub={data.stats ? `${data.stats.totalInputTokens.toLocaleString()} in · ${data.stats.totalOutputTokens.toLocaleString()} out` : '—'} accent="emerald" />
          <WorkspaceStatCard icon={Activity} label="Est. cost" value={data.stats ? `$${data.stats.estimatedTotalCost.toFixed(4)}` : '—'} sub={data.stats ? `avg ${formatDuration(data.stats.avgDurationMs)}` : '—'} accent="amber" />
          <WorkspaceStatCard icon={Activity} label="Errors" value={data.stats?.errorRequests.toLocaleString() ?? '—'} sub={data.stats ? `${data.counts.warn} warnings in logs` : '—'} accent={data.stats && data.stats.errorRequests > 0 ? 'amber' : 'default'} />
        </div>
      )}

      {tab === 'requests' && (
        <RequestsTab rows={data.rows} pending={data.pending} />
      )}

      {tab === 'logs' && (
        <SettingsEmptyState title="Logs view" description="Open the Logs tab inside Settings → Traffic & Activity for the merged feed." />
      )}
    </div>
  );
}

function RequestsTab({ rows, pending }: { rows: ReturnType<typeof useTrafficActivity>['rows']; pending: ReturnType<typeof useTrafficActivity>['pending'] }) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const visible = applyStatusFilter(rows, filter);
  const virt = useVirtualizer({
    count: visible.length,
    getScrollElement: () => document.getElementById('ws-traffic-scroll') as HTMLDivElement | null,
    estimateSize: () => 36,
    overscan: 12,
  });

  return (
    <div className="space-y-3">
      {pending.length > 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-3 space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">{pending.length} pending</p>
          {pending.map((p) => (
            <div key={p.reqId} className="flex items-center gap-3 text-xs font-mono">
              <span className="text-muted-foreground">{p.clientType}</span>
              <span className="truncate flex-1">{p.endpoint}</span>
              <span className="text-muted-foreground">{p.model}</span>
              <span className="tabular-nums text-amber-600">{formatDuration(p.elapsedMs)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1 text-[10px]">
        <span className="text-muted-foreground/70 uppercase tracking-wider mr-1">Status</span>
        {(['all', 'ok', 'err'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-md px-2 py-1 font-mono transition',
              filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
            )}
          >
            {f === 'ok' ? '2xx' : f === 'err' ? 'Errors' : 'All'}
          </button>
        ))}
      </div>

      <Card className="flex flex-col overflow-hidden">
        <div className="grid grid-cols-[70px_90px_1fr_120px_90px_90px_90px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border font-mono">
          <span>Status</span><span>Client</span><span>Endpoint</span><span>Model</span>
          <span className="text-right">Duration</span><span className="text-right">Tokens</span><span className="text-right">Cost</span>
        </div>
        <div id="ws-traffic-scroll" className="h-[55vh] min-h-[280px] overflow-auto">
          {visible.length === 0 ? (
            <div className="h-full grid place-items-center text-xs text-muted-foreground">No requests match this filter.</div>
          ) : (
            <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {virt.getVirtualItems().map((row) => {
                const r = visible[row.index];
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
          <span>{visible.length} rows</span>
          <span>·</span>
          <span>last: {visible[0] ? formatTimeAgo(visible[0].timestamp) : '—'}</span>
        </div>
      </Card>
    </div>
  );
}
