/* ── ObservabilityOverview — at-a-glance tab ─────────────────────────── */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, Camera, History, ShieldCheck, Wifi } from 'lucide-react';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill, variantForHostStatus, variantForAppPolicy } from '@/components/workspace/StatusPill';
import { WorkspaceDonut, modelColor, type DonutSlice } from '@/components/workspace/WorkspaceDonut';
import { usageApi } from '@/api/usage';
import {
    getObservabilityOverview,
    getModelAliases,
    getUserModelAliases,
    type ObservabilityOverview as OverviewPayload
} from '@/api/backend-ui';
import { cn, formatTimeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export function ObservabilityOverview({ onNavigate }: { onNavigate?: (subtab: 'overview' | 'audit' | 'rollback' | 'observations') => void }) {
    // Poll every 5s so the "Tokens per day" bar for today grows in real time
    // and the model-usage donut + stats stay current as new events land.
    const refetchMs = 5000;
    const overview = useQuery({ queryKey: ['observability', 'overview'], queryFn: () => getObservabilityOverview('30d'), refetchInterval: refetchMs });
    const usage = useQuery({ queryKey: ['usage', 'stats', '30d'], queryFn: () => usageApi.stats('30d'), refetchInterval: refetchMs });
    const byDay = useQuery({ queryKey: ['usage', 'byDay', '30d'], queryFn: () => usageApi.byDay('30d'), refetchInterval: refetchMs });
    const byModel = useQuery({ queryKey: ['usage', 'byModel', '30d'], queryFn: () => usageApi.byModel('30d'), refetchInterval: refetchMs });
    // Alias lookups so we can show "alias(backend)" next to the alias the
    // usage events recorded. Both catalog aliases (e.g. short names set in
    // model-catalog.json) and user-defined aliases from /api/config are
    // merged into one map keyed by the alias string.
    const catalogAliases = useQuery({ queryKey: ['models', 'aliases'], queryFn: () => getModelAliases(), refetchInterval: refetchMs });
    const userAliases = useQuery({ queryKey: ['models', 'userAliases'], queryFn: () => getUserModelAliases(), refetchInterval: refetchMs });

    if (overview.isLoading || usage.isLoading) {
        return <SettingsEmptyState title="Loading…" description="Fetching the at-a-glance view." />;
    }

    const o = overview.data;
    if (!o) return <SettingsEmptyState title="No data" description="Could not load observability overview." />;

    const totalTokens30d = usage.data?.totalTokens ?? 0;
    const activeDays = usage.data?.activeDays ?? 0;
    const currentStreak = usage.data?.currentStreak ?? 0;
    const criticalCount = o.audit.byCritical.true ?? 0;
    const observations = o.hostAgent.postObservationCount;
    const allowedApps = o.appPolicy.counts.allow;
    const deniedApps = o.appPolicy.counts.deny;

    // Build alias -> backend model id map. We only add entries where the
    // alias resolves to a different model id, otherwise the suffix would
    // be redundant (e.g. when an alias just renames itself).
    const aliasBackendMap = new Map<string, string>();
    for (const a of catalogAliases.data?.aliases ?? []) {
        if (a.alias && a.resolvesTo && a.alias !== a.resolvesTo) {
            aliasBackendMap.set(a.alias, a.resolvesTo);
        }
    }
    for (const a of userAliases.data?.aliases ?? []) {
        if (!a.alias || !a.targetModel || a.alias === a.targetModel) continue;
        // Index by the canonical id (e.g. "claude-opus-4.7") so calls that
        // record the alias id directly still resolve.
        aliasBackendMap.set(a.alias, a.targetModel);
        // Index by the prettified display alias (e.g. "Opus 4.7-Alias")
        // — that's the string recorded in usage events when the user picks
        // the alias from the chat dropdown.
        if (a.displayAlias && a.displayAlias !== a.alias) {
            aliasBackendMap.set(a.displayAlias, a.targetModel);
        }
    }
    const formatModelLabel = (model: string): string => {
        const backend = aliasBackendMap.get(model);
        return backend ? `${model}(${backend})` : model;
    };

    // Model-usage donut slices (from usageApi.byModel) + center label.
    // We compute `color` here so the donut and the Tokens-per-day chart
    // use the same color for the same alias (color stays keyed on the
    // alias, not the formatted label, so legend + bars match).
    const donutSlices: DonutSlice[] = (byModel.data?.results ?? []).map(r => ({
        label: formatModelLabel(r.model),
        value: r.tokens,
        percent: r.percent,
        color: modelColor(r.model),
    }));
    const donutCenter = formatCompact(totalTokens30d);

    return (
        <ErrorBoundary
            fallback={
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm">
                    <p className="font-semibold text-rose-300">Observability render error</p>
                </div>
            }
        >
        <div className="space-y-6">
            {/* Stat cards row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <StatCard icon={Activity} label="Tokens (30d)" value={formatCompact(totalTokens30d)} accent="text-foreground" />
                <StatCard icon={AlertTriangle} label="Critical actions" value={String(criticalCount)} accent={criticalCount > 0 ? 'text-danger' : 'text-foreground'} />
                <StatCard icon={History} label="Available rollbacks" value={String(o.rollback.available)} accent="text-warning" />
                <StatCard icon={Wifi} label="Host agent" value={o.hostAgent.status} accent={variantForHostStatus(o.hostAgent.status) === 'ok' ? 'text-success' : 'text-muted-foreground'} />
                <StatCard icon={ShieldCheck} label="App policies" value={`${allowedApps} allow / ${deniedApps} deny`} accent="text-foreground" />
                <StatCard icon={Camera} label="Observations" value={String(observations)} accent="text-foreground" />
            </div>

            {/* Host agent panel + audit summary */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card>
                    <CardHeader>
                        <CardTitle>Host agent</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                        <Row k="Status" v={<StatusPill label={o.hostAgent.status} variant={variantForHostStatus(o.hostAgent.status)} />} />
                        <Row k="Last computer action" v={o.hostAgent.lastComputerActionAt ? `${o.hostAgent.lastComputerAction || 'unknown'} (${formatTimeAgo(new Date(o.hostAgent.lastComputerActionAt))})` : 'never'} />
                        <Row k="Last observed app" v={o.hostAgent.lastObservedApp || '—'} />
                        <Row k="Last observation" v={o.hostAgent.lastObservationAt ? formatTimeAgo(new Date(o.hostAgent.lastObservationAt)) : 'never'} />
                        <Row k="Total observations" v={String(o.hostAgent.postObservationCount)} />
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Audit summary (last 30d)</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                        <Row k="Total entries" v={String(o.audit.count)} />
                        <Row k="By result: ok" v={String(o.audit.byResult.ok ?? 0)} />
                        <Row k="By result: blocked" v={String(o.audit.byResult.blocked ?? 0)} />
                        <Row k="By result: error" v={String(o.audit.byResult.error ?? 0)} />
                        <Row k="Critical (true)" v={String(o.audit.byCritical.true ?? 0)} />
                    </CardContent>
                </Card>
            </div>

            {/* Model-usage donut + Tokens-per-day bar chart (matches Usage screenshot) */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card>
                    <CardHeader>
                        <CardTitle>Model usage</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <ErrorBoundary fallback={<p className="text-sm text-muted-foreground">Model usage unavailable.</p>}>
                            {donutSlices.length > 0 ? (
                                <>
                                    <WorkspaceDonut
                                        slices={donutSlices}
                                        centerLabel={donutCenter}
                                        centerSub="tokens"
                                        formatValue={formatCompact}
                                    />
                                    {(() => {
                                        const top = byModel.data?.results?.[0];
                                        if (!top) return null;
                                        return (
                                            <div className="mt-4 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
                                                            Top model
                                                        </div>
                                                        <div className="mt-0.5 text-sm font-semibold text-foreground truncate">
                                                            {formatModelLabel(top.model || 'unknown')}
                                                        </div>
                                                    </div>
                                                    <div className="shrink-0 text-right">
                                                        <div className="text-lg font-semibold tabular-nums text-white">
                                                            {top.percent.toFixed(1)}%
                                                        </div>
                                                        <div className="text-[10px] text-muted-foreground/70">
                                                            share
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </>
                            ) : (
                                <SettingsEmptyState
                                    title="No model usage yet"
                                    description="Once you have chat sessions in the last 30 days, the model breakdown will appear here."
                                />
                            )}
                        </ErrorBoundary>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Tokens per day</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <ErrorBoundary
                            fallback={
                                <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
                                    <p className="font-semibold text-rose-300">Tokens per day render error</p>
                                </div>
                            }
                        >
                            {byDay.data && byDay.data.results && byDay.data.results.length > 0 ? (
                                <TokensByDayBars rows={byDay.data.results} formatModelLabel={formatModelLabel} />
                            ) : (
                                <SettingsEmptyState title="No token usage yet" description="Activity will appear here as you work." />
                            )}
                        </ErrorBoundary>
                    </CardContent>
                </Card>
            </div>

            {/* App allowlist */}
            <div className="grid grid-cols-1 gap-4">
                <Card>
                    <CardHeader>
                        <CardTitle>App allowlist</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                        <div className="flex items-center gap-2 flex-wrap">
                            {(['allow', 'ask', 'deny'] as const).map(p => (
                                <StatusPill key={p} label={`${o.appPolicy.counts[p] ?? 0} ${p}`} variant={variantForAppPolicy(p)} />
                            ))}
                        </div>
                        {Object.keys(o.appPolicy.policies).length > 0 ? (
                            <ul className="space-y-1">
                                {Object.entries(o.appPolicy.policies).slice(0, 6).map(([app, policy]) => (
                                    <li key={app} className="flex items-center justify-between">
                                        <code className="text-foreground/80">{app}</code>
                                        <StatusPill label={policy} variant={variantForAppPolicy(policy)} />
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-xs text-muted-foreground italic">
                                No app-specific policies. All apps default to <span className="font-medium">ask</span>.
                            </p>
                        )}
                        <div className="pt-1">
                            <Button variant="ghost" size="sm" onClick={() => onNavigate?.('rollback')}>
                                View rollback history →
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
        </ErrorBoundary>
    );
}

function StatCard({ icon: Icon, label, value, accent }: { icon: any; label: string; value: string; accent?: string }) {
    return (
        <Card>
            <CardContent className="py-4 flex items-start gap-3">
                <div className="rounded-md bg-white/[0.04] p-2 text-muted-foreground">
                    <Icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
                    <div className={`mt-1 text-lg font-semibold truncate ${accent || ''}`}>{value}</div>
                </div>
            </CardContent>
        </Card>
    );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{k}</span>
            <span className="font-medium">{v}</span>
        </div>
    );
}

// Shared with WorkspaceDonut so a model keeps the same color across
// the donut and the Tokens-per-day chart.

function TokensByDayBars({ rows, formatModelLabel }: { rows: Array<{ date: string; tokens: number; models?: { model: string; tokens: number }[] }>; formatModelLabel?: (model: string) => string }) {
    const safeRows = (rows ?? []).map(r => ({
        date: String(r.date ?? ''),
        tokens: Number(r.tokens) || 0,
        models: Array.isArray(r.models) ? r.models.filter(m => m && typeof m.model === 'string') : [],
    }));
    const max = Math.max(1, ...safeRows.map(r => r.tokens));
    const recent = safeRows.slice(-14);
    // "Today" in the same UTC-day key the backend uses, so the highlighted
    // bar matches the row the aggregator is actively growing.
    const todayKey = new Date().toISOString().slice(0, 10);
    const [hover, setHover] = useState<number | null>(null);
    const hoverRow = hover !== null ? recent[hover] : null;
    // Scale so the tallest bar reaches ~94% of the container, leaving a
    // small breathing room at the top for the line overlay.
    const SCALE = 0.94;
    // Fall back to identity when the parent didn't pass a formatter (e.g.
    // when this component is used in isolation).
    const label = formatModelLabel ?? ((m: string) => m);

    return (
        <div className="relative" style={{ marginTop: '125px' }}>
            <div
                className="relative h-16"
                onMouseLeave={() => setHover(null)}
            >
                <div className="absolute inset-0 flex items-end gap-1">
                    {recent.map((r, i) => {
                        const isToday = r.date === todayKey;
                        const rowTotal = r.tokens || r.models.reduce((s, m) => s + (m.tokens || 0), 0);
                        const heightPct = Math.max(2, (rowTotal / max) * 100 * SCALE);
                        return (
                            <div
                                key={r.date || i}
                                className={cn(
                                    'flex-1 rounded-t overflow-hidden flex flex-col justify-end transition relative cursor-pointer',
                                    isToday && 'ring-1 ring-emerald-300/50'
                                )}
                                style={{ height: `${heightPct}%` }}
                                onMouseEnter={() => setHover(i)}
                                onFocus={() => setHover(i)}
                                tabIndex={0}
                            >
                                {r.models.length === 0 ? (
                                    <div
                                        className={cn(
                                            'w-full rounded-t',
                                            isToday ? 'bg-success/60' : 'bg-primary/70'
                                        )}
                                        style={{ height: '100%' }}
                                    />
                                ) : r.models.map(m => {
                                    const pct = rowTotal > 0 ? (m.tokens / rowTotal) * 100 : 0;
                                    return (
                                        <div
                                            key={m.model}
                                            className="w-full transition-opacity hover:opacity-80"
                                            style={{
                                                backgroundColor: modelColor(m.model),
                                                height: `${pct}%`,
                                            }}
                                            title={`${label(m.model)}: ${formatCompact(m.tokens)} tokens`}
                                        />
                                    );
                                })}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Date axis */}
            <div className="mt-1 flex items-end gap-1 text-[10px] text-muted-foreground/80 tabular-nums">
                {recent.map((r, i) => {
                    const isToday = r.date === todayKey;
                    // Label first, last, today, and every ~3rd bar to avoid clutter.
                    const showLabel =
                        i === 0 ||
                        i === recent.length - 1 ||
                        isToday ||
                        recent.length <= 7 ||
                        i % Math.max(1, Math.ceil(recent.length / 5)) === 0;
                    const [, mm, dd] = r.date.split('-');
                    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                    const monthLabel = monthNames[parseInt(mm, 10) - 1] || mm;
                    return (
                        <div key={r.date || i} className="flex-1 text-center">
                            {showLabel ? `${monthLabel} ${parseInt(dd, 10)}` : ''}
                        </div>
                    );
                })}
            </div>

            {hoverRow && (
                <div
                    className="absolute z-10 left-1/2 -translate-x-1/2 -top-2 -translate-y-full pointer-events-none"
                    role="tooltip"
                >
                    <div className="rounded-md border border-white/[0.08] bg-zinc-900/95 backdrop-blur px-3 py-2 text-xs shadow-xl min-w-[180px]">
                        <div className="flex items-center justify-between gap-3 text-foreground font-semibold">
                            <span>{hoverRow.date}{hoverRow.date === todayKey ? ' (today)' : ''}</span>
                            <span className="tabular-nums">{formatCompact(hoverRow.tokens)}</span>
                        </div>
                        {hoverRow.models.length > 0 && (
                            <div className="mt-1.5 space-y-1">
                                {hoverRow.models.map(m => (
                                    <div key={m.model} className="flex items-center gap-2 text-muted-foreground">
                                        <span
                                            className="size-2 rounded-full shrink-0"
                                            style={{ backgroundColor: modelColor(m.model) }}
                                        />
                                        <span className="flex-1 truncate text-foreground/90">{label(m.model)}</span>
                                        <span className="tabular-nums">{formatCompact(m.tokens)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function formatCompact(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}
