/* ── Traffic & Activity — deeply consolidated single-section view ────── */
/* Replaces the 4 old tabs (Overview, Traffic, Usage, Logs) with one
 * section that:
 *   • owns a single shared period + status filter, so changing it updates
 *     every subtab at once
 *   • polls /ui/requests, /ui/stats, /ui/activity, /api/usage/* once per
 *     period change (via useTrafficActivity) — not 4× independently
 *   • renders Summary / Requests / Logs as subtabs using the new shared
 *     SettingsCard / SettingsTabs / SettingsEmptyState primitives
 *   • keeps the virtualized requests table from the old Traffic view */

import { useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Activity,
  BarChart3,
  ScrollText,
  Inbox,
  Search,
  Copy,
  Check,
  type LucideIcon,
} from 'lucide-react';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsTooltip } from '@/components/settings/SettingsTooltip';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { StatusPill } from '@/components/StatusPill';
import { formatDuration, formatTimeAgo, cn } from '@/lib/utils';
import { type Period } from '@/api/backend-ui';
import {
  useTrafficActivity,
  applyStatusFilter,
  type TrafficRow,
  type LogLine,
  type StatusFilter,
} from './useTrafficActivity';

/* ── Shared chrome — period + status filter chips ────────────────────── */

const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: '7d' },
  { key: 'month', label: '30d' },
  { key: 'all', label: 'All' },
];

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ok',  label: '2xx' },
  { key: 'err', label: 'Errors' },
];

interface FilterChipsProps<T extends string> {
  items: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  tooltip?: string;
}

function FilterChips<T extends string>({ items, value, onChange, label, tooltip }: FilterChipsProps<T>) {
  return (
    <div className="flex items-center gap-1 text-[10px]">
      <span className="flex items-center gap-1 px-1 text-muted-foreground/70 uppercase tracking-wider">
        {label}
        {tooltip && <SettingsTooltip content={tooltip} />}
      </span>
      {items.map((p) => (
        <button
          key={p.key}
          onClick={() => onChange(p.key)}
          className={cn(
            'rounded-md px-2 py-1 font-mono transition',
            value === p.key
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent',
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

/* ── Top-level section ──────────────────────────────────────────────── */

const TABS: { key: 'summary' | 'requests' | 'logs'; label: string; icon: LucideIcon }[] = [
  { key: 'summary',  label: 'Summary',  icon: BarChart3 },
  { key: 'requests', label: 'Requests', icon: Activity },
  { key: 'logs',     label: 'Logs',     icon: ScrollText },
];

export function TrafficActivitySection() {
  const [period, setPeriod] = useState<Period>('today');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [tab, setTab] = useState<string>('summary');

  const data = useTrafficActivity(period);
  const filteredRows = applyStatusFilter(data.rows, statusFilter);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 px-6 pt-5 pb-3 shrink-0">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Traffic &amp; Activity</h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            Every request, status, and event in one place — pick a window and a tab below.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <FilterChips
            items={PERIODS}
            value={period}
            onChange={setPeriod}
            label="Period"
            tooltip="The time window applied to every tab in this section."
          />
          <FilterChips
            items={STATUS_FILTERS}
            value={statusFilter}
            onChange={setStatusFilter}
            label="Status"
            tooltip="Filter requests by HTTP-style status. Errors are requests that returned an error."
          />
        </div>
        <SettingsTabs value={tab} onChange={setTab} items={TABS} label="Activity views" />
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        {tab === 'summary'  && <SummaryTab data={data} period={period} />}
        {tab === 'requests' && <RequestsTab rows={filteredRows} pending={data.pending} />}
        {tab === 'logs'     && <LogsTab lines={data.lines} />}
      </div>
    </div>
  );
}

/* ── Summary tab — stat cards using SettingsCard ─────────────────────── */

function SummaryTab({
  data,
  period,
}: {
  data: ReturnType<typeof useTrafficActivity>;
  period: Period;
}) {
  const s = data.stats;
  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? period;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SettingsCard
          icon={Activity}
          title="Requests"
          description={`Total in ${periodLabel.toLowerCase()}.`}
          status={<Badge variant="outline" className="font-mono">{s?.totalRequests.toLocaleString() ?? '—'}</Badge>}
          inert
        >
          <p className="text-xs text-muted-foreground">
            {s ? `${s.completedRequests.toLocaleString()} done · ${s.pendingRequests} pending` : 'Loading…'}
          </p>
        </SettingsCard>

        <SettingsCard
          icon={BarChart3}
          title="Tokens"
          description="Input + output across the window."
          status={<Badge variant="outline" className="font-mono">{s ? (s.totalInputTokens + s.totalOutputTokens).toLocaleString() : '—'}</Badge>}
          inert
        >
          <p className="text-xs text-muted-foreground">
            {s ? `${s.totalInputTokens.toLocaleString()} in · ${s.totalOutputTokens.toLocaleString()} out` : '—'}
          </p>
        </SettingsCard>

        <SettingsCard
          icon={BarChart3}
          title="Estimated cost"
          description="Based on provider pricing rules."
          status={<Badge variant="outline" className="font-mono">{s ? `$${s.estimatedTotalCost.toFixed(4)}` : '—'}</Badge>}
          inert
        >
          <p className="text-xs text-muted-foreground">
            avg {s ? formatDuration(s.avgDurationMs) : '—'}
          </p>
        </SettingsCard>

        <SettingsCard
          icon={Activity}
          title="Errors"
          description="Requests that returned an error."
          status={
            <StatusPill
              tone={s && s.errorRequests > 0 ? 'bad' : 'good'}
              label={s ? s.errorRequests.toString() : '—'}
            />
          }
          inert
        >
          <p className="text-xs text-muted-foreground">
            {s ? `${data.counts.warn} warnings in logs` : 'Loading…'}
          </p>
        </SettingsCard>
      </div>

      {s && (
        <SettingsCard
          icon={BarChart3}
          title="Top model"
          description="Most-used model in this period."
          status={<Badge variant="secondary">{s.mostUsedCount} calls</Badge>}
        >
          <p className="font-mono text-sm text-foreground">{s.mostUsedModel || '—'}</p>
        </SettingsCard>
      )}

      {data.rows.length === 0 && (
        <SettingsEmptyState
          icon={Inbox}
          title="No traffic in this period"
          description="Try a wider window (7d, 30d, All) or send a request through the proxy."
        />
      )}
    </div>
  );
}

/* ── Requests tab — virtualized table reused from the old Traffic view */

function RequestsTab({ rows, pending }: { rows: TrafficRow[]; pending: ReturnType<typeof useTrafficActivity>['pending'] }) {
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => document.getElementById('ta-requests-scroll') as HTMLDivElement | null,
    estimateSize: () => 36,
    overscan: 12,
  });

  return (
    <div className="space-y-3">
      {pending.length > 0 && (
        <SettingsCard
          icon={Activity}
          title="In flight"
          description={`${pending.length} request${pending.length === 1 ? '' : 's'} currently being processed.`}
        >
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
        </SettingsCard>
      )}

      <Card className="flex flex-col overflow-hidden">
        <div className="grid grid-cols-[70px_90px_1fr_120px_90px_90px_90px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border font-mono">
          <span>Status</span>
          <span>Client</span>
          <span>Endpoint</span>
          <span>Model</span>
          <span className="text-right">Duration</span>
          <span className="text-right">Tokens</span>
          <span className="text-right">Cost</span>
        </div>
        <div id="ta-requests-scroll" className="h-[60vh] min-h-[300px] overflow-auto">
          {rows.length === 0 ? (
            <SettingsEmptyState
              icon={Inbox}
              title="No requests match this filter"
              description="Switch the status filter to 'All' or pick a wider period above."
              className="border-0 bg-transparent py-12"
            />
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
        </div>
      </Card>
    </div>
  );
}

/* ── Logs tab — merged activity + request + pending feed ─────────────── */

const LEVEL_FILTERS: { key: 'all' | 'info' | 'warn' | 'error'; label: string }[] = [
  { key: 'all',   label: 'All' },
  { key: 'info',  label: 'Info' },
  { key: 'warn',  label: 'Warn' },
  { key: 'error', label: 'Error' },
];

function LogsTab({ lines }: { lines: LogLine[] }) {
  const [level, setLevel] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const visible = lines.filter((l) => {
    if (level !== 'all' && l.level !== level) return false;
    if (filter && !l.message.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  const counts = {
    error: lines.filter((l) => l.level === 'error').length,
    warn: lines.filter((l) => l.level === 'warn').length,
    info: lines.filter((l) => l.level === 'info').length,
  };

  function copyLine(l: LogLine) {
    const safe = JSON.stringify(l.raw, (k, v) => {
      // Never copy secret-shaped fields.
      if (/key|token|secret|password|authorization|cookie/i.test(k)) return '[REDACTED]';
      return v;
    }, 2);
    navigator.clipboard?.writeText(safe);
    setCopied(l.id);
    setTimeout(() => setCopied(null), 1200);
  }

  return (
    <div className="space-y-3">
      <SettingsCard
        icon={ScrollText}
        title="Log feed"
        description="Activity events, request lifecycle, and pending requests merged into one chronological stream."
        status={
          <div className="flex items-center gap-1.5 text-[10px] font-mono">
            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{counts.info} info</span>
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-600">{counts.warn} warn</span>
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">{counts.error} error</span>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <div className="flex items-center gap-1 text-[10px]">
            {LEVEL_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setLevel(f.key)}
                className={cn(
                  'rounded-md px-2 py-1 font-mono transition',
                  level === f.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="relative ml-auto max-w-xs flex-1 min-w-[180px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter logs…"
              aria-label="Filter logs"
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-secondary rounded-md border border-transparent focus:border-border focus:bg-background outline-none transition"
            />
          </div>
        </div>

        {visible.length === 0 ? (
          <SettingsEmptyState
            icon={Inbox}
            title="No log entries match"
            description="Try a different level filter or clear the search box."
            className="py-8"
          />
        ) : (
          <div className="max-h-[60vh] overflow-auto font-mono text-[11px] divide-y divide-border/40">
            {visible.map((l) => (
              <div key={l.id} className="flex items-start gap-2 px-2 py-1.5 hover:bg-accent/20 group">
                <span className="text-muted-foreground/70 shrink-0 w-28">{formatTimeAgo(l.time)}</span>
                <span className="shrink-0 w-16">
                  <LevelBadge level={l.level} />
                </span>
                <span className="shrink-0 w-16 text-muted-foreground">{l.source}</span>
                <span className="flex-1 break-all whitespace-pre-wrap">{l.message}</span>
                <button
                  onClick={() => copyLine(l)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition shrink-0"
                  title="Copy redacted entry"
                >
                  {copied === l.id ? <Check className="size-3" /> : <Copy className="size-3" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>
      <p className="text-[9px] text-muted-foreground font-mono">
        🔒 Secret-shaped fields (keys, tokens, cookies) are redacted on copy. Pending requests surface as warnings.
      </p>
    </div>
  );
}

function LevelBadge({ level }: { level: 'info' | 'warn' | 'error' }) {
  if (level === 'error') return <StatusPill tone="bad" label="error" />;
  if (level === 'warn') return <Badge variant="outline" className="border-amber-500/50 text-amber-600">{level}</Badge>;
  return <Badge variant="outline">{level}</Badge>;
}
