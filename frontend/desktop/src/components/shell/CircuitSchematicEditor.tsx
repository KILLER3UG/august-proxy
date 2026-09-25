/* ── CircuitSchematicEditor ────────────────────────────────────────────────
 * The interactive schematic surface for the right-drawer Circuit panel.
 *
 * Renders the graph the backend returns (components with their layout,
 * orthogonal wires) as native SVG, lets you DRAG a part to a new grid
 * position (persisted to the <name>.layout.json sidecar — never the
 * netlist), and optionally animates current flow along the wires from a
 * trace set. Symbols are drawn in-component so the editor and the
 * backend's SVG artifact show the same circuit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RotateCcw, Save, Waves } from 'lucide-react';
import { toast } from 'sonner';
import { circuitApi, type SchematicComponent, type SchematicGraph } from '@/api/circuit';
import { cn } from '@/lib/utils';

const STROKE = '#334155';
const WIRE_STROKE = '#475569';

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Resistor zig-zag between two pins. */
function resistorPath(x0: number, y: number, x1: number): string {
  const span = Math.abs(x1 - x0) || 20;
  const lead = span * 0.15;
  const body = span - 2 * lead;
  const steps = 6;
  const zig = body / steps;
  const sx = x1 >= x0 ? 1 : -1;
  const pts: string[] = [`${x0},${y}`];
  for (let i = 0; i < steps; i++) {
    const px = x0 + sx * (lead + zig * i);
    const py = y - (i % 2 === 0 ? zig / 2 : -zig / 2);
    pts.push(`${px},${py}`);
  }
  pts.push(`${x1},${y}`);
  return pts.join(' ');
}

function inductorPath(x0: number, y: number, x1: number): string {
  const span = Math.abs(x1 - x0) || 20;
  const lead = span * 0.15;
  const body = span - 2 * lead;
  const r = body / 8;
  const d = [`M ${x0} ${y}`, `L ${x0 + lead} ${y}`];
  for (let i = 0; i < 4; i++) {
    d.push(`A ${r} ${r} 0 0 1 ${x0 + lead + r * (i + 1)} ${y}`);
  }
  d.push(`L ${x1} ${y}`);
  return d.join(' ');
}

function groundBars(x: number, y: number, dir: 1 | -1): string {
  return [0, 1, 2]
    .map((i) => {
      const w = 6 - i * 2;
      const yy = y + dir * i * 4;
      return `<line x1="${x - w}" y1="${yy}" x2="${x + w}" y2="${yy}" stroke="${STROKE}" stroke-width="1.5"/>`;
    })
    .join('');
}

function symbolSvg(c: SchematicComponent): string {
  const [p0, p1] = c.pins;
  if (!p0 || !p1) return '';
  const { 0: x0, 1: y0 } = p0;
  const { 0: x1, 1: y1 } = p1;
  const half = 8;
  const mid = (x0 + x1) / 2;
  switch (c.kind) {
    case 'resistor':
      return `<polyline points="${resistorPath(x0 + 4, y0, x1 - 4)}" fill="none" stroke="${STROKE}" stroke-width="2"/>`;
    case 'capacitor':
      return [
        `<line x1="${x0}" y1="${y0}" x2="${mid - 2}" y2="${y0}" stroke="${STROKE}" stroke-width="2"/>`,
        `<line x1="${mid - 2}" y1="${y0 - half}" x2="${mid - 2}" y2="${y0 + half}" stroke="${STROKE}" stroke-width="2"/>`,
        `<line x1="${mid + 2}" y1="${y0 - half}" x2="${mid + 2}" y2="${y0 + half}" stroke="${STROKE}" stroke-width="2"/>`,
        `<line x1="${mid + 2}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="${STROKE}" stroke-width="2"/>`,
      ].join('');
    case 'inductor':
      return `<path d="${inductorPath(x0 + 4, y0, x1 - 4)}" fill="none" stroke="${STROKE}" stroke-width="2"/>`;
    case 'diode':
      return [
        `<line x1="${x0}" y1="${y0}" x2="${mid - 6}" y2="${y0}" stroke="${STROKE}" stroke-width="2"/>`,
        `<line x1="${x0}" y1="${y0 + half}" x2="${mid - 6}" y2="${y0 + half}" stroke="${STROKE}" stroke-width="2"/>`,
        `<path d="M ${mid - 6} ${y0 - half} L ${mid + 6} ${y0} L ${mid - 6} ${y0 + half} Z" fill="none" stroke="${STROKE}" stroke-width="2"/>`,
        `<line x1="${mid + 6}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="${STROKE}" stroke-width="2"/>`,
      ].join('');
    case 'voltage':
    case 'isource': {
      const r = 11;
      const inner =
        c.kind === 'voltage'
          ? `<line x1="${mid}" y1="${y0 - 6}" x2="${mid}" y2="${y0 + 6}" stroke="${STROKE}" stroke-width="2"/><line x1="${mid - 4}" y1="${y0}" x2="${mid + 4}" y2="${y0}" stroke="${STROKE}" stroke-width="2"/>`
          : `<line x1="${mid}" y1="${y0 - 6}" x2="${mid + 4}" y2="${y0 - 2}" stroke="${STROKE}" stroke-width="2"/><line x1="${mid - 4}" y1="${y0 - 2}" x2="${mid + 4}" y2="${y0 - 2}" stroke="${STROKE}" stroke-width="2"/><line x1="${mid + 4}" y1="${y0 - 2}" x2="${mid}" y2="${y0 + 6}" stroke="${STROKE}" stroke-width="2"/><line x1="${mid}" y1="${y0 + 6}" x2="${mid - 4}" y2="${y0 - 2}" stroke="${STROKE}" stroke-width="2"/>`;
      // Ground belongs on the pin actually tied to node '0'. The unconditional
      // else both drew bars on floating sources and picked the LEFT pin for
      // the common `V1 in 0 5`, where '0' is the right pin — so the editor and
      // the rendered artifact disagreed about the same circuit.
      const zeroAt = c.nodes.indexOf('0');
      const gnd =
        zeroAt === 0 ? groundBars(x0, y0, -1) : zeroAt === 1 ? groundBars(x1, y1, 1) : '';
      return `<circle cx="${mid}" cy="${y0}" r="${r}" fill="none" stroke="${STROKE}" stroke-width="2"/>${inner}${gnd}`;
    }
    case 'subckt':
      return `<rect x="${mid - Math.abs(x1 - x0) * 0.32}" y="${y0 - 12}" width="${Math.abs(x1 - x0) * 0.64}" height="24" fill="none" stroke="${STROKE}" stroke-width="2" rx="3"/>`;
    case 'transistor':
    case 'mosfet':
      return [
        `<circle cx="${mid}" cy="${y0}" r="14" fill="none" stroke="${STROKE}" stroke-width="1.5"/>`,
        `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - 8}" stroke="${STROKE}" stroke-width="1.5"/>`,
        `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + 8}" stroke="${STROKE}" stroke-width="1.5"/>`,
        `<line x1="${x1}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="${STROKE}" stroke-width="1.5"/>`,
      ].join('');
    default:
      return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="${STROKE}" stroke-width="2"/><rect x="${mid - 10}" y="${y0 - 8}" width="20" height="16" fill="none" stroke="${STROKE}" stroke-width="1.5" rx="2"/>`;
  }
}

/** A point a given fraction along a wire polyline (for the flow dots). */
function pointAlong(points: { 0: number; 1: number }[], t: number): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { x: points[0][0], y: points[0][1] };
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    const len = Math.hypot(dx, dy);
    segs.push(len);
    total += len;
  }
  if (total === 0) return { x: points[0][0], y: points[0][1] };
  let want = t * total;
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i] || i === segs.length - 1) {
      const f = segs[i] === 0 ? 0 : want / segs[i];
      return {
        x: points[i][0] + (points[i + 1][0] - points[i][0]) * f,
        y: points[i][1] + (points[i + 1][1] - points[i][1]) * f,
      };
    }
    want -= segs[i];
  }
  const last = points[points.length - 1];
  return { x: last[0], y: last[1] };
}

export function CircuitSchematicEditor({
  sessionId,
  netlistPath,
  className,
}: {
  sessionId: string | null;
  netlistPath: string;
  className?: string;
}) {
  const [graph, setGraph] = useState<SchematicGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [flow, setFlow] = useState(false);
  const [tick, setTick] = useState(0);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ ref: string; dx: number; dy: number } | null>(null);

  const load = useCallback(async () => {
    if (!sessionId || !netlistPath) return;
    setLoading(true);
    setError(null);
    try {
      setGraph(await circuitApi.readSchematic(sessionId, netlistPath));
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load schematic');
    } finally {
      setLoading(false);
    }
  }, [sessionId, netlistPath]);

  useEffect(() => {
    void load();
  }, [load]);

  // Flow animation: one rAF tick while enabled. The dots are decorative —
  // speed tracks the trace-derived magnitude when one is supplied.
  useEffect(() => {
    if (!flow) return;
    let raf = 0;
    const loop = () => {
      setTick((t) => t + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [flow]);

  /** Where a part sits versus where its pins were drawn. Non-zero only while a
   *  drag is unacknowledged: `col`/`row` are live state, `pins` are the last
   *  server-computed geometry, and the backend places pins symmetrically about
   *  `(col*grid, row*grid)`. Without this the symbol stays put until Save. */
  const drawOffset = (c: SchematicComponent, grid: number) => ({
    ox: c.col * grid - (c.pins[0][0] + c.pins[1][0]) / 2,
    oy: c.row * grid - (c.pins[0][1] + c.pins[1][1]) / 2,
  });

  const bounds = useMemo(() => {
    if (!graph) return null;
    const grid = graph.grid || 10;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const c of graph.components) {
      const { ox, oy } = drawOffset(c, grid);
      for (const p of c.pins) { xs.push(p[0] + ox); ys.push(p[1] + oy); }
    }
    for (const w of graph.wires) for (const p of w.points) { xs.push(p[0]); ys.push(p[1]); }
    if (xs.length === 0) return { minx: 0, miny: 0, w: 100, h: 100 };
    const pad = 40;
    const minx = Math.min(...xs) - pad;
    const miny = Math.min(...ys) - pad;
    return { minx, miny, w: Math.max(...xs) + pad - minx, h: Math.max(...ys) + pad - miny };
  }, [graph]);

  const toUser = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    // The SVG is scaled to fit its container and the browser letterboxes
    // the viewBox to preserve the aspect ratio, so client pixels do NOT
    // divide evenly into the viewBox width/height. The screen CTM carries
    // the real scale + offset — invert it rather than guessing.
    const ctm = svg.getScreenCTM?.();
    if (ctm) {
      const p = svg.createSVGPoint();
      p.x = clientX;
      p.y = clientY;
      const q = p.matrixTransform(ctm.inverse());
      return { x: q.x, y: q.y };
    }
    const rect = svg.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * bounds.w + bounds.minx,
      y: ((clientY - rect.top) / rect.height) * bounds.h + bounds.miny,
    };
  }, [bounds]);

  const onPointerDown = (e: React.PointerEvent, ref: string) => {
    const c = graph?.components.find((x) => x.ref === ref);
    if (!c || !bounds) return;
    const p = toUser(e.clientX, e.clientY);
    const centerX = (c.pins[0][0] + c.pins[1][0]) / 2;
    const centerY = (c.pins[0][1] + c.pins[1][1]) / 2;
    dragRef.current = { ref, dx: p.x - centerX, dy: p.y - centerY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !graph) return;
    const p = toUser(e.clientX, e.clientY);
    const grid = graph.grid || 10;
    const col = Math.round((p.x - drag.dx) / grid);
    const row = Math.round((p.y - drag.dy) / grid);
    setGraph((prev) =>
      prev
        ? {
            ...prev,
            components: prev.components.map((c) => (c.ref === drag.ref ? { ...c, col, row } : c)),
          }
        : prev,
    );
    setDirty(true);
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const save = useCallback(async () => {
    if (!sessionId || !netlistPath || !graph) return;
    setSaving(true);
    try {
      const updated = await circuitApi.editSchematic(sessionId, {
        path: netlistPath,
        moves: graph.components.map((c) => ({ ref: c.ref, col: c.col, row: c.row, rot: c.rot })),
      });
      setGraph(updated);
      setDirty(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save layout');
    } finally {
      setSaving(false);
    }
  }, [sessionId, netlistPath, graph]);

  const resetLayout = useCallback(async () => {
    if (!sessionId || !netlistPath) return;
    setSaving(true);
    try {
      const updated = await circuitApi.editSchematic(sessionId, { path: netlistPath, auto: true });
      setGraph(updated);
      setDirty(false);
      toast.success('Layout reset');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reset layout');
    } finally {
      setSaving(false);
    }
  }, [sessionId, netlistPath]);

  if (!netlistPath) return null;

  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-testid="circuit-schematic-editor">
      <div className="flex items-center gap-1.5">
        <Waves className="size-3.5 text-muted-foreground/70" />
        <span className="truncate text-[11px] font-semibold text-foreground">Schematic</span>
        <span className="truncate text-[10px] text-muted-foreground/70">{netlistPath.split(/[\\/]/).pop()}</span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setFlow((f) => !f)}
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] transition',
              flow ? 'bg-primary/15 text-primary' : 'text-muted-foreground/70 hover:bg-muted/50',
            )}
            title="Animate current flow along the wires"
            data-testid="schematic-flow-toggle"
          >
            Flow
          </button>
          <button
            type="button"
            onClick={() => void resetLayout()}
            disabled={saving}
            className="rounded p-1 text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
            title="Reset to the auto layout"
            data-testid="schematic-reset"
          >
            <RotateCcw className="size-3" />
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="rounded p-1 text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
            title="Save the layout sidecar"
            data-testid="schematic-save"
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
          </button>
        </span>
      </div>

      {error ? (
        <p className="px-1 py-3 text-[11px] text-destructive">{error}</p>
      ) : loading && !graph ? (
        <p className="px-1 py-3 text-[11px] text-muted-foreground/70">Loading schematic…</p>
      ) : graph && bounds ? (
        <svg
          ref={svgRef}
          viewBox={`${bounds.minx} ${bounds.miny} ${bounds.w} ${bounds.h}`}
          className="w-full touch-none select-none rounded-lg border border-border/50 bg-[#fdfdfb]"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          data-testid="schematic-canvas"
        >
          {graph.wires.map((w, i) => (
            <g key={`w${i}`}>
              <path d={w.path} fill="none" stroke={WIRE_STROKE} strokeWidth="1.5" />
              {flow &&
                [0.15, 0.5, 0.85].map((base, j) => {
                  const t = (base + tick * 0.012) % 1;
                  const p = pointAlong(w.points, t);
                  return <circle key={j} cx={p.x} cy={p.y} r="3" fill="#2563eb" opacity="0.85" />;
                })}
            </g>
          ))}
          {graph.components.map((c) => {
            const centerX = (c.pins[0][0] + c.pins[1][0]) / 2;
            const centerY = (c.pins[0][1] + c.pins[1][1]) / 2;
            const { ox, oy } = drawOffset(c, graph.grid || 10);
            return (
              <g
                key={c.ref}
                transform={`translate(${ox} ${oy}) rotate(${c.rot % 2 ? 90 : 0} ${centerX} ${centerY})`}
                onPointerDown={(e) => onPointerDown(e, c.ref)}
                className="cursor-grab active:cursor-grabbing"
                data-testid={`schematic-part-${c.ref}`}
              >
                <rect
                  x={centerX - 22}
                  y={centerY - 14}
                  width="44"
                  height="28"
                  fill="transparent"
                  stroke="none"
                />
                {symbolSvg(c)}
                <text
                  x={centerX}
                  y={centerY - 16}
                  textAnchor="middle"
                  fontSize="11"
                  fontFamily="Segoe UI, system-ui, sans-serif"
                  fill="#0f172a"
                >
                  {esc(`${c.ref} ${c.value}`.trim())}
                </text>
              </g>
            );
          })}
        </svg>
      ) : (
        <p className="px-1 py-3 text-[11px] text-muted-foreground/70">No components in this deck.</p>
      )}
      {dirty ? (
        <p className="px-1 text-[10px] text-muted-foreground/70">
          Unsaved layout — saving writes the sidecar only; the netlist is untouched.
        </p>
      ) : null}
    </div>
  );
}
