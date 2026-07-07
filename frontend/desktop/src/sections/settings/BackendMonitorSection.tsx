/* ── BackendMonitorSection — real-time log dashboard ───────────────── */
/* One-screen Settings surface that streams live backend events over a
 * WebSocket. Filter chips + search narrow what renders; the stat strip
 * summarises the current visible window. The virtualized list handles
 * 10k+ rows without freezing the UI. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Activity,
  AlertTriangle,
  CircleDot,
  Download,
  Filter,
  Pause,
  Play,
  Radio,
  Search,
  Trash2,
  Inbox,
} from 'lucide-react';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLogStream, type StreamStatus } from '@/hooks/useLogStream';
import type { LogEvent } from '@/api/api-client';

/* ── Category → visual mapping ─────────────────────────────────────── */

const CATEGORY_META: Record<string, { label: string; chip: string; row: string; icon: typeof Activity }> = {
    proxyIncoming:        { label: 'Incoming',      chip: 'bg-sky-500/10 text-sky-300 border-sky-500/30',            row: 'text-sky-300',                       icon: Activity },
    proxyUpstream:        { label: 'Upstream',      chip: 'bg-blue-500/10 text-blue-300 border-blue-500/30',          row: 'text-blue-300',                      icon: Activity },
    proxyDebug:           { label: 'Debug',         chip: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30',          row: 'text-cyan-300',                      icon: Activity },
    proxyModelRoute:     { label: 'Model Route',   chip: 'bg-warning/10 text-warning border-warning/30',             row: 'text-warning',                       icon: Activity },
    proxyContext:         { label: 'Context',       chip: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30',     row: 'text-indigo-300',                    icon: Activity },
    proxyTools:           { label: 'Tools',         chip: 'bg-pink-500/10 text-pink-300 border-pink-500/30',           row: 'text-pink-300',                      icon: Activity },
    proxySystemPrompt:   { label: 'Sys Prompt',    chip: 'bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/30', row: 'text-fuchsia-300',                   icon: Activity },
    autoMemory:           { label: 'Auto-Memory',   chip: 'bg-purple-500/10 text-purple-300 border-purple-500/30',     row: 'text-purple-300',                    icon: Activity },
    scheduler:             { label: 'Scheduler',     chip: 'bg-orange-500/10 text-orange-300 border-orange-500/30',     row: 'text-orange-300',                    icon: Activity },
    security:              { label: 'Security',      chip: 'bg-danger/10 text-danger border-danger/30',                 row: 'text-danger font-semibold',           icon: AlertTriangle },
    error:                 { label: 'Error',         chip: 'bg-danger/10 text-danger border-danger/30',                 row: 'text-danger font-semibold',           icon: AlertTriangle },
    info:                  { label: 'Info',          chip: 'bg-muted text-muted-foreground border-border',              row: 'text-foreground/80',                 icon: CircleDot },
};

const ALL_CATEGORIES: string[] = Object.keys(CATEGORY_META);

function metaFor(category: string) {
    return CATEGORY_META[category] || CATEGORY_META.info;
}

function redactForCopy(value: unknown): unknown {
    if (value == null) return value;
    if (typeof value === 'object') {
        if (Array.isArray(value)) return value.map(redactForCopy);
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            if (/key|token|secret|password|authorization|cookie/i.test(k)) out[k] = '[REDACTED]';
            else out[k] = redactForCopy(v);
        }
        return out;
    }
    return value;
}

function statusBadge(status: StreamStatus, retryInMs: number | null) {
    if (status === 'live') return { cls: 'bg-success/15 text-success ring-success/30', label: 'Live', dot: 'bg-success' };
    if (status === 'paused') return { cls: 'bg-warning/15 text-warning ring-warning/30', label: 'Paused', dot: 'bg-warning' };
    if (status === 'connecting') return { cls: 'bg-white/[0.06] text-muted-foreground ring-white/10', label: 'Connecting…', dot: 'bg-zinc-400 animate-pulse' };
    return {
        cls: 'bg-rose-400/15 text-rose-300 ring-rose-400/30',
        label: retryInMs ? `Disconnected · retry in ${Math.round(retryInMs / 1000)}s` : 'Disconnected',
        dot: 'bg-rose-400 animate-pulse',
    };
}

function formatTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function exportEvents(events: LogEvent[]) {
    const blob = new Blob([JSON.stringify(events, redactForCopy, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backend-monitor-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BackendMonitorSection() {
    const { events, status, retryInMs, pause, resume, clear } = useLogStream();
    const [enabled, setEnabled] = useState<Set<string>>(() => new Set(ALL_CATEGORIES));
    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [autoScroll, setAutoScroll] = useState(true);

    const parentRef = useRef<HTMLDivElement | null>(null);

    const visible = useMemo(() => {
        const q = search.trim().toLowerCase();
        return events.filter((e) => {
            if (!enabled.has(e.category)) return false;
            if (!q) return true;
            if (e.message.toLowerCase().includes(q)) return true;
            if (e.metadata) {
                try {
                    if (JSON.stringify(e.metadata).toLowerCase().includes(q)) return true;
                } catch { /* circular ref */ }
            }
            return false;
        });
    }, [events, enabled, search]);

    const stats = useMemo(() => {
        const errors = visible.filter((e) => e.level === 'error' || e.category === 'security').length;
        const autoMem = visible.filter((e) => e.category === 'auto_memory').length;
        const mdOf = (e: LogEvent) => (e.metadata || {}) as Record<string, unknown>;
        const tokensIn = visible.reduce((s, e) => s + Number(mdOf(e).tokensIn ?? mdOf(e).inputTokens ?? 0), 0);
        const tokensOut = visible.reduce((s, e) => s + Number(mdOf(e).tokensOut ?? mdOf(e).outputTokens ?? 0), 0);
        const schedTicks = visible.filter((e) => e.category === 'scheduler').length;
        const upstream = visible.filter((e) => e.category === 'proxy_upstream').length;
        const lastProvider = [...visible].reverse().find((e) => e.category === 'proxy_model_route');
        const provider = (lastProvider?.metadata as Record<string, unknown> | null)?.provider as string | undefined;
        return {
            total: visible.length,
            errors,
            autoMem,
            tokensIn,
            tokensOut,
            schedTicks,
            upstream,
            provider: provider || '—',
        };
    }, [visible]);

    const rowVirtualizer = useVirtualizer({
        count: visible.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 28,
        overscan: 24,
    });

    useEffect(() => {
        if (autoScroll && parentRef.current) {
            parentRef.current.scrollTop = 0;
        }
    }, [visible.length, autoScroll]);

    const toggleCategory = (cat: string) => {
        setEnabled((prev) => {
            const next = new Set(prev);
            if (next.has(cat)) next.delete(cat); else next.add(cat);
            return next;
        });
    };

    const toggleExpanded = (id: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const badge = statusBadge(status, retryInMs);

    return (
        <div className="px-8 py-10 max-w-7xl space-y-6">
            <header className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
                        <Radio className="size-5 text-primary" />
                        Backend Monitor
                    </h1>
                    <p className="mt-2 text-sm text-muted-foreground max-w-2xl">
                        Live stream of proxy calls, memory operations, scheduler ticks, and tool events emitted by the August backend.
                        Events arrive over WebSocket; the most recent 500 entries are backfilled on connect.
                    </p>
                </div>
                <span className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset', badge.cls)}>
                    <span className={cn('size-1.5 rounded-full', badge.dot)} />
                    {badge.label}
                </span>
            </header>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <Stat label="Events" value={stats.total.toLocaleString()} />
                <Stat label="Errors" value={String(stats.errors)} accent={stats.errors > 0 ? 'text-rose-300' : undefined} />
                <Stat label="Auto-Memory" value={String(stats.autoMem)} />
                <Stat label="Tokens in/out" value={`${formatNum(stats.tokensIn)} / ${formatNum(stats.tokensOut)}`} />
                <Stat label="Scheduler ticks" value={String(stats.schedTicks)} />
                <Stat label="Upstream calls" value={String(stats.upstream)} sub={`Last: ${stats.provider}`} />
            </div>

            <SettingsCard
                icon={Filter}
                title="Live log feed"
                description="Filter by category, search, pause, export, or clear. Auto-scroll keeps the newest row pinned to the top."
                actions={
                    <div className="flex items-center gap-2">
                        <Button size="sm" variant="ghost" onClick={() => (status === 'paused' ? resume() : pause())}>
                            {status === 'paused' ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                            {status === 'paused' ? 'Resume' : 'Pause'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setAutoScroll((v) => !v)}>
                            {autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={clear} disabled={visible.length === 0}>
                            <Trash2 className="size-3.5" /> Clear
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => exportEvents(visible)} disabled={visible.length === 0}>
                            <Download className="size-3.5" /> Export
                        </Button>
                    </div>
                }
            >
                <div className="flex flex-wrap items-center gap-1.5 pb-3">
                    {ALL_CATEGORIES.map((cat) => {
                        const m = metaFor(cat);
                        const on = enabled.has(cat);
                        return (
                            <button
                                key={cat}
                                onClick={() => toggleCategory(cat)}
                                className={cn(
                                    'rounded-md border px-2 py-1 text-[10px] font-mono uppercase tracking-wider transition',
                                    on ? m.chip : 'bg-muted/40 text-muted-foreground/50 border-transparent hover:bg-muted',
                                )}
                            >
                                {m.label}
                            </button>
                        );
                    })}
                    <div className="relative ml-auto max-w-xs flex-1 min-w-[180px]">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                        <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search messages and JSON…"
                            aria-label="Search logs"
                            className="w-full pl-7 pr-2 py-1.5 text-xs bg-secondary rounded-md border border-transparent focus:border-border focus:bg-background outline-none transition"
                        />
                    </div>
                </div>

                <div
                    ref={parentRef}
                    className="relative max-h-[60vh] overflow-auto rounded-md border border-border/60 bg-zinc-950/50 font-mono text-[11px]"
                >
                    {visible.length === 0 ? (
                        <SettingsEmptyState
                            icon={Inbox}
                            title={events.length === 0 ? 'Waiting for events…' : 'No events match the current filters'}
                            description={events.length === 0 ? 'Trigger any proxy call, memory extraction, or wait for the next scheduler tick to see events stream in.' : 'Try clearing the search box or enabling more categories.'}
                            className="py-12"
                        />
                    ) : (
                        <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}>
                            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                                const event = visible[virtualRow.index];
                                const m = metaFor(event.category);
                                const isExpanded = expanded.has(event.id);
                                const Icon = m.icon;
                                return (
                                    <div
                                        key={event.id}
                                        data-index={virtualRow.index}
                                        ref={rowVirtualizer.measureElement}
                                        style={{
                                            position: 'absolute',
                                            top: 0,
                                            left: 0,
                                            right: 0,
                                            transform: `translateY(${virtualRow.start}px)`,
                                        }}
                                    >
                                        <button
                                            onClick={() => toggleExpanded(event.id)}
                                            className={cn(
                                                'group flex w-full items-start gap-2 px-2 py-1 text-left hover:bg-white/[0.04] transition border-b border-border/30',
                                                event.level === 'error' && 'bg-rose-500/[0.04]',
                                            )}
                                        >
                                            <span className="shrink-0 text-muted-foreground/70 w-28 tabular-nums">{formatTime(event.timestamp)}</span>
                                            <span className={cn('shrink-0 rounded border px-1.5 py-px text-[9px] uppercase tracking-wider w-20 text-center', m.chip)}>
                                                {m.label}
                                            </span>
                                            <Icon className={cn('size-3 shrink-0 mt-0.5', m.row)} />
                                            <span className={cn('flex-1 whitespace-pre-wrap break-all', m.row)}>{event.message}</span>
                                        </button>
                                        {isExpanded && (
                                            <div className="border-b border-border/30 bg-black/30 px-3 py-2 text-[10px] text-muted-foreground space-y-1">
                                                <div className="grid grid-cols-[80px_1fr] gap-2">
                                                    <span className="text-muted-foreground/70 uppercase tracking-wider">ID</span>
                                                    <span className="text-foreground/80 break-all">{event.id}</span>
                                                </div>
                                                <div className="grid grid-cols-[80px_1fr] gap-2">
                                                    <span className="text-muted-foreground/70 uppercase tracking-wider">Time</span>
                                                    <span className="text-foreground/80">{new Date(event.timestamp).toISOString()}</span>
                                                </div>
                                                {event.metadata && (
                                                    <div className="grid grid-cols-[80px_1fr] gap-2">
                                                        <span className="text-muted-foreground/70 uppercase tracking-wider">Metadata</span>
                                                        <pre className="text-foreground/80 whitespace-pre-wrap break-all">{JSON.stringify(event.metadata, null, 2)}</pre>
                                                    </div>
                                                )}
                                                {event.raw && (
                                                    <div className="grid grid-cols-[80px_1fr] gap-2">
                                                        <span className="text-muted-foreground/70 uppercase tracking-wider">Raw</span>
                                                        <pre className="text-foreground/80 whitespace-pre-wrap break-all">{event.raw}</pre>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                <p className="pt-2 text-[9px] text-muted-foreground font-mono">
                    Secret-shaped fields (keys, tokens, cookies) are redacted on export. Up to 10,000 events are retained; the ring is FIFO.
                </p>
            </SettingsCard>
        </div>
    );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
    return (
        <div className="rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">{label}</div>
            <div className={cn('mt-0.5 text-base font-semibold tabular-nums', accent || 'text-foreground')}>{value}</div>
            {sub && <div className="text-[9px] text-muted-foreground/60 truncate">{sub}</div>}
        </div>
    );
}

function formatNum(n: number): string {
    if (!n) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}

export default BackendMonitorSection;