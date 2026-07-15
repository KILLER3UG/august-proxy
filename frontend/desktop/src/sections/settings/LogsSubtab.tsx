/* ── LogsSubtab — merged activity + request log feed ───────────────── */
/* Period and level filter chips plus a chronological log feed.
 * Token and summary stats live in ObservabilityOverview.
 */

import { useState } from 'react';
import { Copy, Check, ScrollText, Search, Inbox } from 'lucide-react';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { StatusPill } from '@/components/StatusPill';
import { Badge } from '@/components/ui/badge';
import { formatTimeAgo, cn } from '@/lib/utils';
import { useTrafficActivity, type Period, type LogLine } from './useTrafficActivity';

const PERIODS: { key: Period; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'week', label: '7d' },
    { key: 'month', label: '30d' },
    { key: 'all', label: 'All' },
];

const LEVEL_FILTERS: { key: 'all' | 'info' | 'warn' | 'error'; label: string }[] = [
    { key: 'all',   label: 'All' },
    { key: 'info',  label: 'Info' },
    { key: 'warn',  label: 'Warn' },
    { key: 'error', label: 'Error' },
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

export function LogsSubtab() {
    const [period, setPeriod] = useState<Period>('today');
    const [level, setLevel] = useState<'all' | 'info' | 'warn' | 'error'>('all');
    const [filter, setFilter] = useState('');
    const [copied, setCopied] = useState<string | null>(null);

    const data = useTrafficActivity(period);
    const lines = data.lines;

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
            if (/key|token|secret|password|authorization|cookie/i.test(k)) return '[REDACTED]';
            return v;
        }, 2);
        void navigator.clipboard?.writeText(safe);
        setCopied(l.id);
        setTimeout(() => setCopied(null), 1200);
    }

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl border border-white/[0.06] bg-card/60">
                <FilterChips items={PERIODS} value={period} onChange={setPeriod} label="Period" />
            </div>

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

export default LogsSubtab;
