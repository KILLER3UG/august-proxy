/* ── ObservabilityOverview — at-a-glance tab ─────────────────────────── */

import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, Camera, History, ShieldCheck, Wifi } from 'lucide-react';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill, variantForHostStatus, variantForAppPolicy } from '@/components/workspace/StatusPill';
import { WorkspaceDonut, type DonutSlice } from '@/components/workspace/WorkspaceDonut';
import { usageApi } from '@/api/usage';
import {
    getObservabilityOverview,
    type ObservabilityOverview as OverviewPayload
} from '@/api/backend-ui';
import { formatTimeAgo } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function ObservabilityOverview({ onNavigate }: { onNavigate?: (subtab: 'overview' | 'audit' | 'rollback' | 'observations') => void }) {
    const overview = useQuery({ queryKey: ['observability', 'overview'], queryFn: () => getObservabilityOverview('30d') });
    const usage = useQuery({ queryKey: ['usage', 'stats', '30d'], queryFn: () => usageApi.stats('30d') });
    const byDay = useQuery({ queryKey: ['usage', 'byDay', '30d'], queryFn: () => usageApi.byDay('30d') });
    const byModel = useQuery({ queryKey: ['usage', 'byModel', '30d'], queryFn: () => usageApi.byModel('30d') });

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

    // Model-usage donut slices (from usageApi.byModel) + center label
    const donutSlices: DonutSlice[] = (byModel.data?.results ?? []).map(r => ({
        label: r.model,
        value: r.tokens,
        percent: r.percent
    }));
    const donutCenter = formatCompact(totalTokens30d);

    return (
        <div className="space-y-6">
            {/* Stat cards row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <StatCard icon={Activity} label="Tokens (30d)" value={formatCompact(totalTokens30d)} accent="text-foreground" />
                <StatCard icon={AlertTriangle} label="Critical actions" value={String(criticalCount)} accent={criticalCount > 0 ? 'text-rose-300' : 'text-foreground'} />
                <StatCard icon={History} label="Available rollbacks" value={String(o.rollback.available)} accent="text-amber-300" />
                <StatCard icon={Wifi} label="Host agent" value={o.hostAgent.status} accent={variantForHostStatus(o.hostAgent.status) === 'ok' ? 'text-emerald-300' : 'text-muted-foreground'} />
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
                                                        {top.model || 'unknown'}
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
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Tokens per day</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {byDay.data && byDay.data.results && byDay.data.results.length > 0 ? (
                            <TokensByDayBars rows={byDay.data.results} />
                        ) : (
                            <SettingsEmptyState title="No token usage yet" description="Activity will appear here as you work." />
                        )}
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

function TokensByDayBars({ rows }: { rows: Array<{ date: string; tokens: number }> }) {
    const max = Math.max(1, ...rows.map(r => r.tokens));
    const recent = rows.slice(-14);
    return (
        <div className="flex items-end gap-1 h-24">
            {recent.map(r => (
                <div
                    key={r.date}
                    className="flex-1 bg-primary/70 rounded-t hover:bg-primary transition"
                    style={{ height: `${Math.max(2, (r.tokens / max) * 100)}%` }}
                    title={`${r.date}: ${formatCompact(r.tokens)} tokens`}
                />
            ))}
        </div>
    );
}

function formatCompact(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}
