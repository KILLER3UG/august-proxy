/**
 * Frontend stream timing marks (measurement only — no behaviour change).
 *
 * Records:
 *  - TTFT: first content flush after stream start
 *  - flush durations (setState apply path)
 *  - inter-flush gaps (throttle behaviour)
 *
 * Enable via localStorage `august_stream_perf=1` or `import.meta.env.DEV`.
 * Force on in tests with `enableStreamPerf(true)`.
 *
 * Uses Performance API when available; always keeps an in-memory ring buffer
 * for tests / console dumps (`getStreamPerfSnapshot()`).
 */

export type StreamPerfEvent =
  | { kind: 'start'; sessionId: string; t: number }
  | { kind: 'first_content'; sessionId: string; t: number; ttftMs: number }
  | { kind: 'flush'; sessionId: string; t: number; durationMs: number; gapMs: number }
  | { kind: 'end'; sessionId: string; t: number; totalMs: number; flushCount: number };

const RING_MAX = 200;
const ring: StreamPerfEvent[] = [];

let forcedOn: boolean | null = null;
const sessionStart = new Map<string, number>();
const firstContent = new Map<string, number>();
const lastFlush = new Map<string, number>();
const flushCounts = new Map<string, number>();

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function enableStreamPerf(on: boolean): void {
  forcedOn = on;
}

export function isStreamPerfEnabled(): boolean {
  if (forcedOn !== null) return forcedOn;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('august_stream_perf') === '1') {
      return true;
    }
  } catch {
    /* ignore */
  }
  try {
    // Vite / bundler dev flag — still opt-in via localStorage for noise control in dev
    return false;
  } catch {
    return false;
  }
}

function push(ev: StreamPerfEvent): void {
  ring.push(ev);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  try {
    if (typeof performance !== 'undefined' && performance.mark) {
      if (ev.kind === 'start') performance.mark(`august-stream-start:${ev.sessionId}`);
      if (ev.kind === 'first_content') {
        performance.mark(`august-stream-first:${ev.sessionId}`);
        performance.measure?.(
          `august-stream-ttft:${ev.sessionId}`,
          `august-stream-start:${ev.sessionId}`,
          `august-stream-first:${ev.sessionId}`,
        );
      }
      if (ev.kind === 'flush') {
        performance.mark(`august-stream-flush:${ev.sessionId}:${ev.t}`);
      }
    }
  } catch {
    /* ignore mark failures */
  }
}

export function streamPerfStart(sessionId: string): void {
  if (!isStreamPerfEnabled() || !sessionId) return;
  const t = now();
  sessionStart.set(sessionId, t);
  firstContent.delete(sessionId);
  lastFlush.delete(sessionId);
  flushCounts.set(sessionId, 0);
  push({ kind: 'start', sessionId, t });
}

export function streamPerfContent(sessionId: string): void {
  if (!isStreamPerfEnabled() || !sessionId) return;
  if (firstContent.has(sessionId)) return;
  const start = sessionStart.get(sessionId);
  if (start === undefined) return;
  const t = now();
  firstContent.set(sessionId, t);
  push({ kind: 'first_content', sessionId, t, ttftMs: t - start });
}

/** Wrap a flush body; records duration + gap from previous flush. */
export function streamPerfFlush<T>(sessionId: string, body: () => T): T {
  if (!isStreamPerfEnabled() || !sessionId) return body();
  const t0 = now();
  try {
    return body();
  } finally {
    const t1 = now();
    const prev = lastFlush.get(sessionId);
    const gapMs = prev === undefined ? 0 : t0 - prev;
    lastFlush.set(sessionId, t1);
    flushCounts.set(sessionId, (flushCounts.get(sessionId) || 0) + 1);
    push({ kind: 'flush', sessionId, t: t1, durationMs: t1 - t0, gapMs });
  }
}

export function streamPerfEnd(sessionId: string): void {
  if (!isStreamPerfEnabled() || !sessionId) return;
  const start = sessionStart.get(sessionId);
  if (start === undefined) return;
  const t = now();
  push({
    kind: 'end',
    sessionId,
    t,
    totalMs: t - start,
    flushCount: flushCounts.get(sessionId) || 0,
  });
}

export function getStreamPerfSnapshot(): StreamPerfEvent[] {
  return ring.slice();
}

export function clearStreamPerf(): void {
  ring.length = 0;
  sessionStart.clear();
  firstContent.clear();
  lastFlush.clear();
  flushCounts.clear();
}

/** Aggregate flush stats for the Progress Log / tests. */
export function summarizeStreamPerf(sessionId?: string): {
  nFlush: number;
  p50FlushMs: number | null;
  p95FlushMs: number | null;
  p50GapMs: number | null;
  ttftMs: number | null;
} {
  const events = sessionId
    ? ring.filter((e) => 'sessionId' in e && e.sessionId === sessionId)
    : ring;
  const flushes = events.filter((e): e is Extract<StreamPerfEvent, { kind: 'flush' }> => e.kind === 'flush');
  const first = events.find((e): e is Extract<StreamPerfEvent, { kind: 'first_content' }> => e.kind === 'first_content');
  const durations = flushes.map((f) => f.durationMs).sort((a, b) => a - b);
  const gaps = flushes.map((f) => f.gapMs).filter((g) => g > 0).sort((a, b) => a - b);
  const pct = (arr: number[], p: number) => {
    if (!arr.length) return null;
    const k = (arr.length - 1) * (p / 100);
    const f = Math.floor(k);
    const c = Math.min(f + 1, arr.length - 1);
    if (f === c) return arr[f];
    return arr[f] + (arr[c] - arr[f]) * (k - f);
  };
  return {
    nFlush: flushes.length,
    p50FlushMs: pct(durations, 50),
    p95FlushMs: pct(durations, 95),
    p50GapMs: pct(gaps, 50),
    ttftMs: first?.ttftMs ?? null,
  };
}
