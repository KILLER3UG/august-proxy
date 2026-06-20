/* ── AuditTimeline — vertical timeline of audit entries with filters ── */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Filter, ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { StatusPill, variantForResult } from '@/components/workspace/StatusPill';
import { getAuditLog, getObservationUrl, type AuditEntry } from '@/api/backend-ui';
import { formatTimeAgo } from '@/lib/utils';
import { cn } from '@/lib/utils';

const CATEGORIES = ['', 'august_api', 'system', 'computer', 'ui', 'general'] as const;

export function AuditTimeline() {
    const [category, setCategory] = useState<string>('');
    const [actor, setActor] = useState<string>('');
    const [sinceDays, setSinceDays] = useState<number>(7);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const sinceISO = useMemo(() => {
        const d = new Date();
        d.setDate(d.getDate() - sinceDays);
        return d.toISOString();
    }, [sinceDays]);

    const query = useQuery({
        queryKey: ['audit', { category, actor, since: sinceISO, limit: 200 }],
        queryFn: () => getAuditLog({ limit: 200, category: category || undefined, actor: actor || undefined, since: sinceISO }),
        refetchInterval: 30_000
    });

    const entries = query.data?.entries ?? [];

    function toggle(id: string) {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }

    return (
        <div className="space-y-4">
            {/* Filter bar */}
            <Card>
                <CardContent className="py-3 flex items-center gap-2 flex-wrap text-sm">
                    <Filter className="size-4 text-muted-foreground" />
                    <select
                        value={category}
                        onChange={e => setCategory(e.target.value)}
                        className="rounded-md border border-white/[0.08] bg-secondary px-2 py-1 text-sm text-foreground"
                        aria-label="Category filter"
                    >
                        {CATEGORIES.map(c => <option key={c} value={c}>{c || 'all categories'}</option>)}
                    </select>
                    <input
                        type="text"
                        value={actor}
                        onChange={e => setActor(e.target.value)}
                        placeholder="actor (e.g. august)"
                        className="rounded-md border border-white/[0.08] bg-secondary px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground"
                    />
                    <select
                        value={String(sinceDays)}
                        onChange={e => setSinceDays(Number(e.target.value))}
                        className="rounded-md border border-white/[0.08] bg-secondary px-2 py-1 text-sm text-foreground"
                        aria-label="Time range"
                    >
                        <option value="1">last 24h</option>
                        <option value="7">last 7 days</option>
                        <option value="30">last 30 days</option>
                    </select>
                    <span className="ml-auto text-muted-foreground">{entries.length} entries</span>
                </CardContent>
            </Card>

            {/* Timeline */}
            {query.isLoading ? (
                <SettingsEmptyState title="Loading…" description="Fetching audit entries." />
            ) : entries.length === 0 ? (
                <SettingsEmptyState title="No entries match" description="Try widening the filters." />
            ) : (
                <div className="relative">
                    <div className="absolute left-[7px] top-0 bottom-0 w-px bg-white/[0.06]" aria-hidden="true" />
                    <ul className="space-y-2">
                        {entries.slice().reverse().map(e => (
                            <TimelineRow
                                key={e.id}
                                entry={e}
                                expanded={expanded.has(e.id)}
                                onToggle={() => toggle(e.id)}
                            />
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

function TimelineRow({ entry, expanded, onToggle }: { entry: AuditEntry; expanded: boolean; onToggle: () => void }) {
    const hasPostObs = !!entry.postObservation?.screenshotPath;
    return (
        <li>
            <button
                type="button"
                onClick={onToggle}
                className={cn(
                    'group relative w-full text-left pl-6 pr-3 py-2 rounded-md transition',
                    'hover:bg-white/[0.04] focus:bg-white/[0.06] focus:outline-none',
                    expanded && 'bg-white/[0.04]'
                )}
            >
                <span className={cn(
                    'absolute left-0 top-3 size-[15px] rounded-full border-2',
                    entry.critical === true ? 'border-rose-400 bg-rose-400/20' :
                    entry.critical === false ? 'border-emerald-400 bg-emerald-400/20' :
                    'border-white/30 bg-card'
                )} aria-hidden="true" />
                <div className="flex items-center gap-2 text-sm">
                    {expanded ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
                    <span className="font-mono text-xs text-muted-foreground">{formatTimeAgo(new Date(entry.at))}</span>
                    <span className="text-foreground/90 font-medium truncate">{entry.action}</span>
                    {entry.target && <code className="text-xs text-muted-foreground truncate">{entry.target}</code>}
                    <span className="ml-auto flex items-center gap-1">
                        {entry.category && <StatusPill label={entry.category} variant="muted" />}
                        <StatusPill label={entry.result || 'unknown'} variant={variantForResult(entry.result)} />
                        {entry.critical === true && <StatusPill label="critical" variant="danger" />}
                    </span>
                </div>
                {expanded && (
                    <div className="mt-2 pl-5 text-xs space-y-2 text-muted-foreground">
                        <Row k="ID" v={<code>{entry.id}</code>} />
                        <Row k="Actor" v={entry.actor} />
                        <Row k="Mode" v={entry.mode || '—'} />
                        {hasPostObs && (
                            <div className="flex items-start gap-2">
                                <span className="text-muted-foreground w-20 shrink-0">post-obs</span>
                                <a
                                    href={getObservationUrl(entry.postObservation!.screenshotPath!.split(/[\\/]/).pop()!.replace(/\.png$/, ''))}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-primary hover:underline"
                                >
                                    View screenshot →
                                </a>
                            </div>
                        )}
                        {entry.inputSummary !== undefined && entry.inputSummary !== null && (
                            <JsonBlock label="input" value={entry.inputSummary} />
                        )}
                        {entry.beforeSummary !== undefined && entry.beforeSummary !== null && (
                            <JsonBlock label="before" value={entry.beforeSummary} />
                        )}
                        {entry.afterSummary !== undefined && entry.afterSummary !== null && (
                            <JsonBlock label="after" value={entry.afterSummary} />
                        )}
                        {entry.error && <Row k="error" v={<span className="text-rose-300">{entry.error}</span>} />}
                    </div>
                )}
            </button>
        </li>
    );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
    return (
        <div className="flex items-start gap-2">
            <span className="w-20 shrink-0 text-muted-foreground">{k}</span>
            <span className="font-mono text-foreground/80 break-all">{v}</span>
        </div>
    );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
    return (
        <div className="rounded-md border border-white/[0.06] bg-background/40 p-2">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">{label}</div>
            <pre className="text-[11px] leading-snug whitespace-pre-wrap break-all font-mono">
                {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
            </pre>
        </div>
    );
}
