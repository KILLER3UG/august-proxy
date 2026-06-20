/* ── useTrafficActivity — shared data layer for Traffic & Activity ──── */
/* The old Overview/Traffic/Usage/Logs sections each polled /ui/requests,
 * /ui/stats, /ui/activity, and /api/usage/* independently — up to 4x the
 * network calls for the same data. This hook fetches each source once and
 * exposes normalized rows + stats + a merged log feed so every tab in the
 * section reads from one poll cycle. */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getRequests,
  getStats,
  getActivity,
  type RequestEntry,
  type PendingRequest,
  type ActivityEntry,
  type StatsResponse,
} from '@/api/backend-ui';

export type Period = 'all' | 'today' | 'yesterday' | 'week' | 'month' | 'year';
export type StatusFilter = 'all' | 'ok' | 'err';

/** Normalized row so renderers stay mock-shape-agnostic. */
export interface TrafficRow {
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
  error?: string | null;
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
    error: r.error,
  };
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
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

export interface TrafficActivityData {
  rows: TrafficRow[];
  pending: PendingRequest[];
  stats: StatsResponse | undefined;
  activity: ActivityEntry[];
  lines: LogLine[];
  counts: { info: number; warn: number; error: number };
  isLoading: boolean;
}

export function useTrafficActivity(period: Period) {
  const reqQuery = useQuery({
    queryKey: ['ta-requests', period],
    queryFn: () => getRequests(period),
    refetchInterval: 3_000,
  });
  const statsQuery = useQuery({
    queryKey: ['ta-stats', period],
    queryFn: () => getStats(period),
    refetchInterval: 5_000,
  });
  const activityQuery = useQuery({
    queryKey: ['ta-activity'],
    queryFn: () => getActivity(),
    refetchInterval: 5_000,
  });

  const pending = reqQuery.data?.pending ?? [];
  const rows = useMemo(() => (reqQuery.data?.completed ?? []).map(toRow), [reqQuery.data]);
  const activity = activityQuery.data ?? [];
  const stats = statsQuery.data;

  const lines = useMemo<LogLine[]>(() => {
    const out: LogLine[] = [];
    for (const a of activity) {
      out.push({
        id: `act-${a.time}-${a.type}`,
        time: a.time,
        level: levelFromEntry(a),
        source: 'activity',
        message: a.detail || a.type,
        raw: a,
      });
    }
    for (const p of pending) {
      out.push({
        id: `pend-${p.reqId}`,
        time: new Date(Date.now() - p.elapsedMs).toISOString(),
        level: 'warn',
        source: 'pending',
        message: `[pending ${p.reqId}] ${p.clientType} ${p.endpoint} (${p.model})`,
        raw: p,
      });
    }
    for (const r of rows) {
      const isError = r.status === 'error';
      out.push({
        id: `req-${r.reqId}`,
        time: String(r.timestamp),
        level: isError ? 'error' : 'info',
        source: 'request',
        message: `[${r.reqId}] ${r.clientType} ${r.endpoint} → ${r.status} (${r.durationMs}ms${r.error ? `, ${r.error}` : ''})`,
        raw: r,
      });
    }
    return out.sort((a, b) => b.time.localeCompare(a.time));
  }, [activity, pending, rows]);

  const counts = useMemo(
    () => ({
      error: lines.filter((l) => l.level === 'error').length,
      warn: lines.filter((l) => l.level === 'warn').length,
      info: lines.filter((l) => l.level === 'info').length,
    }),
    [lines],
  );

  return {
    rows,
    pending,
    stats,
    activity,
    lines,
    counts,
    isLoading: reqQuery.isLoading && statsQuery.isLoading,
  };
}

export function applyStatusFilter(rows: TrafficRow[], filter: StatusFilter): TrafficRow[] {
  if (filter === 'all') return rows;
  if (filter === 'err') return rows.filter((r) => r.status === 'error');
  return rows.filter((r) => r.status !== 'error');
}
