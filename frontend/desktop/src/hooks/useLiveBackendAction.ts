/* Live backend action — recent feature-flow events for “backend is running” UI. */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getFeatureFlowEvents,
  openFeatureFlowEventStream,
  type FeatureFlowEvent,
} from '@/api/api-client';

const RECENT_MS = 45_000;

function isFresh(e: FeatureFlowEvent, now: number): boolean {
  const t = Date.parse(e.at);
  if (Number.isNaN(t)) return e.status === 'running';
  return now - t < RECENT_MS || e.status === 'running';
}

/**
 * Subscribes to Feature Flow SSE + recent REST so chat/status/tool UIs can
 * show live backend activity where the backend is actually running.
 */
export function useLiveBackendAction(enabled = true) {
  const [live, setLive] = useState<FeatureFlowEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const q = useQuery({
    queryKey: ['feature-flow-live-action'],
    queryFn: () => getFeatureFlowEvents(40),
    enabled,
    refetchInterval: enabled ? 12_000 : false,
    staleTime: 5_000,
  });

  useEffect(() => {
    if (!enabled) return;
    const es = openFeatureFlowEventStream();
    es.onmessage = (ev: MessageEvent) => {
      try {
        const event = JSON.parse(ev.data) as FeatureFlowEvent;
        setLive((prev) => [event, ...prev].slice(0, 80));
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), 2000);
    return () => window.clearInterval(id);
  }, [enabled]);

  const events = useMemo(() => {
    const seen = new Set<string>();
    const out: FeatureFlowEvent[] = [];
    for (const e of [...live, ...(q.data ?? [])]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (isFresh(e, now)) out.push(e);
    }
    return out;
  }, [live, q.data, now]);

  const latest = events[0] ?? null;
  const running = events.find((e) => e.status === 'running') ?? null;
  const error = events.find((e) => e.status === 'error') ?? null;
  const active = running ?? error ?? latest;
  const isLive = Boolean(running) || events.some((e) => e.status === 'ok' && isFresh(e, now));

  const label = useMemo(() => {
    if (!active) return null;
    const feat = active.feature;
    const stage = active.stage;
    if (active.status === 'error') return `Backend error · ${feat}/${stage}`;
    if (active.status === 'running') return `Backend · ${feat} · ${stage}`;
    return `Backend · ${feat} · ${stage}`;
  }, [active]);

  return {
    events,
    active,
    running,
    error,
    isLive,
    label,
  };
}
