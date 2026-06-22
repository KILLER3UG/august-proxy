/* ── TrafficSubtab — per-request log + in-flight requests ───────────── */
/* Extracted from the old Traffic & Activity section. Renders the period +
 * status filter chips and the virtualized requests table. No token or
 * summary stats — those live in ObservabilityOverview.
 */

import { useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Activity, Inbox } from 'lucide-react';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { StatusPill } from '@/components/StatusPill';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatDuration, formatTimeAgo, cn } from '@/lib/utils';
import {
    useTrafficActivity,
    applyStatusFilter,
    type TrafficRow,
    type StatusFilter,
    type Period,
} from './useTrafficActivity';

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

function FilterChips<T extends string>({ items, value, onChange, label }: { items: { key: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
    return (
        <div className="flex items-center gap-1 text-[10px]">
            <span className="flex items-center gap-1 px-1 text-muted-foreground/70 uppercase tracking-wider">
                {label}
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

export function TrafficSubtab() {
    const [period, setPeriod] = useState<Period>('today');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const data = useTrafficActivity(period);
    const rows = applyStatusFilter(data.rows, statusFilter);

    return (
        <div className="space-y-3">
            <Card>
                <Card className="p-0 border-0">
                    <div className="flex flex-wrap items-center gap-3 p-3">
                        <FilterChips items={PERIODS} value={period} onChange={setPeriod} label="Period" />
                        <FilterChips items={STATUS_FILTERS} value={statusFilter} onChange={setStatusFilter} label="Status" />
                    </div>
                </Card>
            </Card>

            {data.pending.length > 0 && (
                <SettingsCard
                    icon={Activity}
                    title="In flight"
                    description={`${data.pending.length} request${data.pending.length === 1 ? '' : 's'} currently being processed.`}
                >
                    <div className="space-y-1">
                        {data.pending.map((p) => (
                            <div key={p.reqId} className="flex items-center gap-3 text-xs font-mono">
                                <span className="text-muted-foreground">{p.clientType}</span>
                                <span className="truncate flex-1">{p.endpoint}</span>
                                <span className="text-muted-foreground">{p.model}</span>
                                <span className="tabular-nums text-warning">{formatDuration(p.elapsedMs)}</span>
                            </div>
                        ))}
                    </div>
                </SettingsCard>
            )}

            <VirtualizedRequestsTable rows={rows} />
        </div>
    );
}

function VirtualizedRequestsTable({ rows }: { rows: TrafficRow[] }) {
    const virt = useVirtualizer({
        count: rows.length,
        getScrollElement: () => document.getElementById('ta-requests-scroll') as HTMLDivElement | null,
        estimateSize: () => 36,
        overscan: 12,
    });

    return (
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
    );
}

export default TrafficSubtab;
