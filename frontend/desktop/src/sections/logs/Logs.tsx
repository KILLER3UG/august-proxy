import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SectionHeader } from '@/components/SectionHeader';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/StatusPill';
import { Search, Copy, Check } from 'lucide-react';
import { formatTimeAgo } from '@/lib/utils';
import { getRequests, getActivity, type ActivityEntry, type Period } from '@/api/api-client';

/**
 * Logs view. There is no dedicated /ui/logs endpoint, so we compose the log
 * stream from the two real sources the backend exposes:
 *   - /ui/activity  → human activity events (type + detail + time)
 *   - /ui/requests  → request lifecycle entries (status, error, tokens, cost)
 * These are merged into a single chronological feed and filtered by level.
 */

type LogLevel = 'info' | 'warn' | 'error';

interface LogLine {
  id: string;
  time: string;
  level: LogLevel;
  source: 'activity' | 'request' | 'pending';
  message: string;
  raw?: unknown;
}

function levelFromEntry(a: ActivityEntry): LogLevel {
  const t = (a.type || '').toLowerCase();
  if (t.includes('error') || t.includes('fail')) return 'error';
  if (t.includes('warn') || t.includes('pending')) return 'warn';
  return 'info';
}

const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: '7d' },
  { key: 'all', label: 'All' },
];

const LEVEL_FILTERS: { key: 'all' | LogLevel; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'info', label: 'Info' },
  { key: 'warn', label: 'Warn' },
  { key: 'error', label: 'Error' },
];

export function Logs() {
  const [period, setPeriod] = useState<Period>('today');
  const [levelFilter, setLevelFilter] = useState<'all' | LogLevel>('all');
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const { data: reqData } = useQuery({
    queryKey: ['requests', period],
    queryFn: () => getRequests(period),
    refetchInterval: 4_000,
  });
  const { data: activity } = useQuery({
    queryKey: ['activity'],
    queryFn: () => getActivity(),
    refetchInterval: 4_000,
  });

  const lines = useMemo<LogLine[]>(() => {
    const out: LogLine[] = [];
    for (const a of activity ?? []) {
      out.push({
        id: `act-${a.time}-${a.type}`,
        time: a.time,
        level: levelFromEntry(a),
        source: 'activity',
        message: a.detail || a.type,
        raw: a,
      });
    }
    for (const p of reqData?.pending ?? []) {
      out.push({
        id: `pend-${p.reqId}`,
        time: new Date(Date.now() - p.elapsedMs).toISOString(),
        level: 'warn',
        source: 'pending',
        message: `[pending ${p.reqId}] ${p.clientType} ${p.endpoint} (${p.model})`,
        raw: p,
      });
    }
    for (const r of reqData?.completed ?? []) {
      const isError = r.status === 'error';
      out.push({
        id: `req-${r.reqId}`,
        time: r.date || r.time || new Date().toISOString(),
        level: isError ? 'error' : 'info',
        source: 'request',
        message: `[${r.reqId}] ${r.clientType} ${r.endpoint} → ${r.status} (${r.durationMs}ms${r.error ? `, ${r.error}` : ''})`,
        raw: r,
      });
    }
    return out.sort((a, b) => b.time.localeCompare(a.time));
  }, [activity, reqData]);

  const visible = lines.filter((l) => {
    if (levelFilter !== 'all' && l.level !== levelFilter) return false;
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
    void navigator.clipboard?.writeText(safe);
    setCopied(l.id);
    setTimeout(() => setCopied(null), 1200);
  }

  return (
    <div className="flex flex-col h-full p-6 gap-4">
      <SectionHeader
        title="Logs"
        subtitle={`${lines.length} entries · ${counts.error} errors · ${counts.warn} warnings`}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-[10px]">
              {LEVEL_FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setLevelFilter(f.key)}
                  className={`rounded-md px-2 py-1 font-mono transition ${
                    levelFilter === f.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 text-[10px]">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => setPeriod(p.key)}
                  className={`rounded-md px-2 py-1 font-mono transition ${
                    period === p.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        }
      />

      <div className="relative max-w-md">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter logs…"
          className="w-full pl-7 pr-2 py-1.5 text-xs bg-secondary rounded-md border border-transparent focus:border-border focus:bg-background outline-none transition"
        />
      </div>

      <Card className="flex-1 overflow-auto min-h-[260px]">
        <div className="font-mono text-[11px] divide-y divide-border/40">
          {visible.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">No log entries match the current filter.</div>
          ) : (
            visible.map((l) => (
              <div key={l.id} className="flex items-start gap-2 px-3 py-1.5 hover:bg-accent/20 group">
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
            ))
          )}
        </div>
      </Card>
      <p className="text-[9px] text-muted-foreground font-mono">
        🔒 Secret-shaped fields (keys, tokens, cookies) are redacted on copy. Pending requests surface as warnings.
      </p>
    </div>
  );
}

function LevelBadge({ level }: { level: LogLevel }) {
  if (level === 'error') return <StatusPill tone="bad" label="error" />;
  if (level === 'warn') return <Badge variant="outline" className="border-warning/50 text-warning">{level}</Badge>;
  return <Badge variant="outline">{level}</Badge>;
}
