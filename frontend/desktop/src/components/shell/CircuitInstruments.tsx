/* ── CircuitInstruments ─ Scope / Bode / Meter instrument cards ────────── */
/* Phase 2.1 of the EDA deep-dive plan: bench-style presentation of real  *
 * ngspice data. The views post-process circuit_simulate results already   *
 * flowing through the session — the FULL result JSON lives on the        *
 * message-level tool entry (`ChatMessage.tools[].result`; the block      *
 * summary is 240-char truncated and cannot hold traces). Scope reads      *
 * `traces` from the latest .tran run, Bode the same traces on .ac decks  *
 * (dB), Meter the .op node table. uPlot (MIT) renders Scope/Bode; Meter  *
 * is a plain table. No live simulation — instruments are post-processing,*
 * exactly the EWB idea the plan describes.                              */

import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import { Activity, Gauge, Waves } from 'lucide-react';
import type { ChatMessage } from '@/types/chat';

/* ── data extraction from message-level tool results ────────────────────── */

interface TraceData {
  x: number[];
  y: number[];
  xunit: string;
  unit: string;
  points: number;
}
interface SimResult {
  traces?: Record<string, TraceData>;
  measures?: Record<string, number>;
  errors?: string[];
  lint?: string[];
}
interface MeterRow {
  label: string;
  value: number;
}

/** Message-level tool entry shape (ChatMessage.tools[i]) — `result` holds
 *  the full tool result text (never truncated, unlike `summary`). */
interface MessageToolEntry {
  name: string;
  status: 'running' | 'done' | 'error';
  startedAt?: number;
  result?: string;
}

const CIRCUIT_SIM = /^circuit_simulate$/i;

export function parseSimResult(entry: MessageToolEntry): SimResult | null {
  if (entry.status !== 'done') return null;
  const raw = entry.result;
  if (!raw) return null;
  // The result may be a bare JSON object or wrapped in code fences /
  // prose by the tool formatter — extract the outermost {...} block.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as SimResult;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.traces && !parsed.measures) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Newest-first circuit_simulate results across the session's messages. */
export function collectSimResults(messages?: ChatMessage[] | null): Array<SimResult> {
  if (!messages) return [];
  const out: Array<{ result: SimResult; ts: number }> = [];
  for (const message of messages) {
    if (!message.tools) continue;
    for (const tool of message.tools) {
      if (!CIRCUIT_SIM.test(tool.name || '')) continue;
      if (tool.status !== 'done') continue;
      const result = parseSimResult(tool);
      if (result) out.push({ result, ts: tool.startedAt ?? 0 });
    }
  }
  return out.sort((a, b) => b.ts - a.ts).map((e) => e.result);
}

/** .op node table from measures: every v(node)/i(src) key is a meter row. */
export function meterRows(measures: Record<string, number>): MeterRow[] {
  return Object.entries(measures)
    .filter(([k, v]) => /^(v\(|i\()/.test(k) && typeof v === 'number')
    .map(([k, v]) => ({ label: k, value: v }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/* ── uPlot React wrapper ───────────────────────────────────────────────── */

function useUPlot(
  opts: uPlot.Options | null,
  data: uPlot.AlignedData | null,
): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!ref.current || !opts) return;
    const plot = new uPlot(opts, data ?? undefined, ref.current);
    plotRef.current = plot;
    return () => {
      plot.destroy();
      plotRef.current = null;
    };
    // Re-init only on structural option changes (series/axes), not data
    // updates — setData handles those below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts]);

  useEffect(() => {
    if (plotRef.current && data) plotRef.current.setData(data);
  }, [data]);

  return ref;
}

function fmtExp(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(v)));
  if (exp >= -2 && exp <= 3) return v.toPrecision(4).replace(/\.?0+$/, '');
  const mant = v / 10 ** exp;
  return `${mant.toPrecision(3)}e${exp}`;
}

/* ── Scope view ────────────────────────────────────────────────────────── */

function ScopeView({ traces }: { traces: Record<string, TraceData> }) {
  const entries = Object.entries(traces).slice(0, 8);
  const traceKey = Object.keys(traces).join(',');

  const opts = useMemo<uPlot.Options | null>(() => {
    if (entries.length === 0) return null;
    const first = entries[0][1];
    return {
      width: 340,
      height: 190,
      title: 'Transient (scope)',
      cursor: { drag: { x: true, y: false } },
      legend: { live: true },
      scales: { x: { time: false } },
      series: [
        {},
        ...entries.map(([name], i) => ({
          label: name,
          stroke: `hsl(${(i * 57) % 360} 70% 55%)`,
          width: 1.5,
          points: { show: false },
        })),
      ],
      axes: [
        { label: first.xunit || 's' },
        { label: first.unit || 'V', values: (_: uPlot, v: number[]) => v.map(fmtExp) },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceKey]);

  const data = useMemo<uPlot.AlignedData | null>(() => {
    if (entries.length === 0) return null;
    return [entries[0][1].x, ...entries.map(([, t]) => t.y)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceKey]);

  const ref = useUPlot(opts, data);

  return (
    <div className="flex flex-col gap-1" data-testid="circuit-scope">
      <div ref={ref} className="w-full" />
      <p className="text-[10px] leading-relaxed text-muted-foreground/80">
        Drag horizontally to zoom a time window — legend values follow the
        cursor for Δ measurements.
      </p>
    </div>
  );
}

/* ── Bode view ─────────────────────────────────────────────────────────── */

/** Magnitude in dB: prefer an explicit vdb()/db trace, else compute
 *  20·log10|y| from the first voltage trace. */
export function bodeMag(traces: Record<string, TraceData>): {
  label: string;
  x: number[];
  y: number[];
  xunit: string;
} | null {
  const named = Object.entries(traces).find(([k]) => /db/i.test(k));
  if (named) {
    const [k, t] = named;
    return { label: k, x: t.x, y: t.y, xunit: t.xunit };
  }
  const anyVolt = Object.entries(traces).find(([k]) => /^v\(/i.test(k));
  if (!anyVolt) return null;
  const [k, t] = anyVolt;
  return {
    label: `${k} (dB)`,
    x: t.x,
    y: t.y.map((v) => 20 * Math.log10(Math.max(Math.abs(v), 1e-12))),
    xunit: t.xunit,
  };
}

function BodeView({ traces }: { traces: Record<string, TraceData> }) {
  const mag = useMemo(() => bodeMag(traces), [traces]);

  const opts = useMemo<uPlot.Options | null>(() => {
    if (!mag) return null;
    return {
      width: 340,
      height: 190,
      title: 'Bode (magnitude)',
      scales: { x: { time: false } },
      series: [
        {},
        { label: mag.label, stroke: '#3b82f6', width: 1.5, points: { show: false } },
      ],
      axes: [
        { label: mag.xunit || 'Hz' },
        { label: 'dB', values: (_: uPlot, v: number[]) => v.map((n) => n.toFixed(0)) },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mag?.label]);

  const data = useMemo<uPlot.AlignedData | null>(
    () => (mag ? [mag.x, mag.y] : null),
    [mag],
  );

  const ref = useUPlot(opts, data);
  if (!mag) {
    return (
      <p className="px-1 py-4 text-[11px] text-muted-foreground/70" data-testid="circuit-bode-empty">
        No frequency response yet — simulate an .ac deck with a vdb(out) trace
        (e.g. traces=['vdb(out)']) to see the Bode plot.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="circuit-bode">
      <div ref={ref} />
    </div>
  );
}

/* ── Meter view ────────────────────────────────────────────────────────── */

function MeterView({ rows }: { rows: MeterRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="px-1 py-4 text-[11px] text-muted-foreground/70" data-testid="circuit-meter-empty">
        No operating point yet — simulate with a .op card; every node voltage
        and source current lands here like a multimeter readout.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="circuit-meter">
      <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 px-1">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <span className="truncate font-mono text-[11px] text-foreground/90">{r.label}</span>
            <span className="text-right font-mono text-[11px] tabular-nums text-foreground">
              {fmtExp(r.value)}
              {r.label.startsWith('i(') ? ' A' : ' V'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Section component ─────────────────────────────────────────────────── */

type InstrumentKind = 'scope' | 'bode' | 'meter';

const INSTRUMENT_META: Record<InstrumentKind, { label: string; icon: typeof Waves; hint: string }> = {
  scope: {
    label: 'Scope',
    icon: Waves,
    hint: 'Transient traces from the latest circuit_simulate .tran run.',
  },
  bode: {
    label: 'Bode',
    icon: Activity,
    hint: 'Frequency response from .ac traces (vdb or computed dB).',
  },
  meter: {
    label: 'Meter',
    icon: Gauge,
    hint: 'Operating-point node voltages and source currents from .op runs.',
  },
};

/** Newest simulate result that has traces (for Scope/Bode); the Meter uses
 *  the newest result with measures, which may be a different (older) run. */
function latestWith(
  sims: SimResult[],
  pick: (r: SimResult) => boolean,
): SimResult | null {
  for (const r of sims) if (pick(r)) return r;
  return null;
}

export function CircuitInstruments({ messages }: { messages?: ChatMessage[] | null }) {
  const sims = useMemo(() => collectSimResults(messages), [messages]);
  const scopeReady = useMemo(() => latestWith(sims, (r) => !!r.traces && Object.keys(r.traces).length > 0), [sims]);
  const bodeTraceSet = useMemo(() => scopeReady?.traces ?? null, [scopeReady]);
  const meterSource = useMemo(() => latestWith(sims, (r) => !!r.measures && Object.keys(r.measures).length > 0), [sims]);
  const rows = useMemo(() => meterRows(meterSource?.measures ?? {}), [meterSource]);

  const [kind, setKind] = useState<InstrumentKind>('scope');
  const active = INSTRUMENT_META[kind];

  return (
    <div className="flex flex-col gap-2 border-b border-border/60 px-3 py-2.5" data-testid="circuit-instruments">
      <div className="flex items-center gap-2">
        <active.icon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="shrink-0 text-xs font-semibold text-foreground">Instruments</span>
        <span className="truncate text-[10px] text-muted-foreground">{active.hint}</span>
      </div>

      {/* Vertical rail — no horizontal pill tabs (design directive). */}
      <div className="flex flex-col gap-1.5">
        {(['scope', 'bode', 'meter'] as const).map((k) => {
          const meta = INSTRUMENT_META[k];
          const selected = kind === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={selected}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition ${
                selected
                  ? 'border-primary/50 bg-primary/10 text-foreground'
                  : 'border-border/50 bg-card/50 text-muted-foreground hover:border-primary/30 hover:bg-card'
              }`}
              data-testid={`instrument-${k}`}
            >
              <meta.icon className="size-3.5 shrink-0" />
              <span className="text-[11px] font-medium">{meta.label}</span>
            </button>
          );
        })}
      </div>

      <div className="min-h-0 rounded-lg border border-border/40 bg-card/40 p-1.5">
        {sims.length === 0 && (
          <p className="px-1 py-4 text-[11px] leading-relaxed text-muted-foreground/70">
            No simulation yet. Ask August to simulate a deck — its traces and
            measures feed these instruments automatically.
          </p>
        )}
        {sims.length > 0 && kind === 'scope' && (
          scopeReady ? (
            <ScopeView traces={scopeReady.traces!} />
          ) : (
            <p className="px-1 py-4 text-[11px] text-muted-foreground/70">
              Latest run had no traces — pass traces=['v(out)', 'i(r1)'] to
              circuit_simulate for scope data.
            </p>
          )
        )}
        {sims.length > 0 && kind === 'bode' && (
          bodeTraceSet ? <BodeView traces={bodeTraceSet} /> : null
        )}
        {sims.length > 0 && kind === 'meter' && <MeterView rows={rows} />}
      </div>
    </div>
  );
}
