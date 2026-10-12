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

/* Schematic ink is THEMED (`--dt-symbol-*` in tokens.css): the hardcoded
 * slate hexes were picked for the light-paper artifact and on the dark
 * --dt-paper canvas measured 1.78:1 (bodies), 2.39:1 (wires) and 1.01:1
 * (labels, literally darker than the background). SVG presentation
 * attributes accept CSS var() values, so one constant serves both modes. */
const STROKE = 'var(--dt-symbol-stroke)';
const WIRE_STROKE = 'var(--dt-symbol-wire)';
/* Live-path tint. Distinct from WIRE_STROKE by hue and lightness, not just
 * width, so the highlight survives a greyscale print and does not rely on a
 * colour-only difference the way a faint grey would. */
const CURRENT_TINT = 'var(--dt-symbol-current)';

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

/** Mean of ALL pins — the body origin the backend's symmetric offsets centre
 *  on. For 2-terminal parts this equals the old pins[0]/pins[1] midpoint; for
 *  a 3-terminal part that midpoint is collector/base, and pivoting a drag or
 *  a rotation on it skids the body off its wires. */
function pinMean(c: SchematicComponent): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  for (const p of c.pins) {
    sx += p[0];
    sy += p[1];
  }
  const n = c.pins.length || 1;
  return { x: sx / n, y: sy / n };
}

function symbolSvg(c: SchematicComponent): string {
  const [p0, p1, p2] = c.pins;
  if (!p0 || !p1) return '';
  const { 0: x0, 1: y0 } = p0;
  const { 0: x1, 1: y1 } = p1;
  const half = 8;
  const mid = (x0 + x1) / 2;
  /** Leads for the pins this symbol's body does not connect to. A 3-pin `X`
   *  instance or a 5-node unknown part is generated one pin per node on the
   *  backend, and a wire that lands beside a body drawn between two pins reads
   *  as an unconnected net — the same silence the backend fix closed. */
  const extraLeads = (cx: number, cy: number, from: number, bodyRadius: number) =>
    c.pins.slice(from)
      .map((p) => {
        const { 0: ex, 1: ey } = p;
        const a = Math.atan2(cy - ey, cx - ex);
        const reach = Math.max(6, Math.hypot(cx - ex, cy - ey) - bodyRadius);
        return `<line x1="${ex}" y1="${ey}" x2="${(ex + reach * Math.cos(a)).toFixed(0)}" y2="${(ey + reach * Math.sin(a)).toFixed(0)}" stroke="${STROKE}" stroke-width="1.5"/>`;
      })
      .join('');
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
      return `<rect x="${mid - Math.abs(x1 - x0) * 0.32}" y="${y0 - 12}" width="${Math.abs(x1 - x0) * 0.64}" height="24" fill="none" stroke="${STROKE}" stroke-width="2" rx="3"/>` + extraLeads(mid, y0, 2, 10);
    case 'transistor':
    case 'mosfet':
    case 'jfet':
    case 'mesfet': {
      if (!p2) {
        // Stale payload from a backend that still emitted 2-pin parts: draw
        // the round body so the part is at least visible where its wires land.
        return `<circle cx="${mid}" cy="${y0}" r="14" fill="none" stroke="${STROKE}" stroke-width="1.5"/>`;
      }
      const { 0: xc, 1: yc } = p0;
      const { 0: xb, 1: yb } = p1;
      const { 0: xe, 1: ye } = p2;
      // Body centre = the mean of ALL the part's pins — the same origin the
      // backend's symmetric offsets guarantee, so drags and the rotated group
      // pivot exactly here. Averaging only the first three put the 4-terminal
      // MESFET's body off the bulk pin its wire routes to.
      const { x: bcx, y: bcy } = pinMean(c);
      const barX = bcx - 4;
      // Only a MOSFET-type gate is insulated (second bar); a JFET/MESFET gate
      // is a Schottky contact, drawn as one bar like a BJT base.
      const gateX = c.kind === 'mosfet' ? barX - 4 : barX;
      const emitY = bcy + 4;
      const ang = Math.atan2(ye - emitY, xe - barX);
      const hx = xe - 7 * Math.cos(ang);
      const hy = ye - 7 * Math.sin(ang);
      const pxp = -3 * Math.cos(ang + Math.PI / 2);
      const pyp = -3 * Math.sin(ang + Math.PI / 2);
      // Terminals past the three this symbol is built around (the MESFET bulk,
      // a multi-pin block's extra nodes) get a lead toward the body, exactly as
      // the backend's static SVG draws them — otherwise a wired net ends in
      // empty air beside a part that looks two-terminal.
      const extras = extraLeads(bcx, bcy, 3, 14);
      return [
        `<circle cx="${bcx}" cy="${bcy}" r="14" fill="none" stroke="${STROKE}" stroke-width="1.5"/>`,
        `<line x1="${xb}" y1="${yb}" x2="${gateX}" y2="${yb}" stroke="${STROKE}" stroke-width="1.5"/>`,
        `<line x1="${barX}" y1="${bcy - 7}" x2="${barX}" y2="${bcy + 7}" stroke="${STROKE}" stroke-width="1.5"/>`,
        c.kind === 'mosfet'
          ? `<line x1="${gateX}" y1="${bcy - 7}" x2="${gateX}" y2="${bcy + 7}" stroke="${STROKE}" stroke-width="1.5"/>`
          : '',
        `<line x1="${barX}" y1="${bcy - 4}" x2="${xc}" y2="${yc}" stroke="${STROKE}" stroke-width="1.5"/>`,
        c.kind === 'transistor'
          ? // NPN arrow: the head points at the emitter pin.
            `<line x1="${barX}" y1="${emitY}" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}" stroke="${STROKE}" stroke-width="1.5"/>` +
            `<path d="M ${(hx + pxp).toFixed(1)} ${(hy + pyp).toFixed(1)} L ${xe} ${ye} L ${(hx - pxp).toFixed(1)} ${(hy - pyp).toFixed(1)} Z" fill="${STROKE}" stroke="none"/>`
          : `<line x1="${barX}" y1="${emitY}" x2="${xe}" y2="${ye}" stroke="${STROKE}" stroke-width="1.5"/>`,
        extras,
      ].join('');
    }
    default:
      return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="${STROKE}" stroke-width="2"/><rect x="${mid - 10}" y="${y0 - 8}" width="20" height="16" fill="none" stroke="${STROKE}" stroke-width="1.5" rx="2"/>` + extraLeads(mid, y0, 2, 10);
  }
}

/** A point a given fraction along a wire polyline, WITH the local direction.
 *
 * The flow animation used to take `pointAlong` alone and draw an anonymous
 * circle, so three identical dots slid along every wire and the direction of
 * conventional current was not visible anywhere — a moving dot says "something
 * is happening here", an arrowhead says which way it goes. The tangent is
 * returned as an angle in degrees so the caller can rotate one arrow glyph to
 * match. */
function pointAndTangentAlong(
  points: { 0: number; 1: number }[],
  t: number,
): { x: number; y: number; angle: number } {
  if (points.length === 0) return { x: 0, y: 0, angle: 0 };
  if (points.length === 1) return { x: points[0][0], y: points[0][1], angle: 0 };
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    segs.push(len);
    total += len;
  }
  if (total === 0) return { x: points[0][0], y: points[0][1], angle: 0 };
  let want = t * total;
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i] || i === segs.length - 1) {
      const f = segs[i] === 0 ? 0 : want / segs[i];
      const x = points[i][0] + (points[i + 1][0] - points[i][0]) * f;
      const y = points[i][1] + (points[i + 1][1] - points[i][1]) * f;
      // A zero-length segment (a repeated corner) has no bearing. Return angle 0
      // rather than calling atan2 on a zero vector: the arrow still renders at
      // the right place, it just does not claim a direction it cannot know.
      const angle = segs[i] === 0
        ? 0
        : (Math.atan2(points[i + 1][1] - points[i][1], points[i + 1][0] - points[i][0]) * 180) / Math.PI;
      return { x, y, angle };
    }
    want -= segs[i];
  }
  const last = points[points.length - 1];
  return { x: last[0], y: last[1], angle: 0 };
}

/** Nets that carry the source's potential.
 *
 * The graph the backend returns is topology only — components, wires, node
 * names and a `grounded` flag. There is no per-node voltage on it, so the
 * highlight is derived rather than read: flood net adjacency out of every
 * voltage/current source and mark what it reaches.
 *
 * **Adjacency comes from COMPONENTS, not from wires.** The first version built
 * it from `w.nodes` assuming a wire carries a `[from, to]` pair. It does not:
 * `schematic.py` constructs `Wire(points=..., nodes=[node])` — a SINGLE name,
 * being the net that wire is drawn on (`tests/test_schematic.py` asserts
 * `w.nodes == ['out']`). So `const [a, b] = w.nodes` yielded `b === undefined`,
 * the link guard was never true, `adj` was always empty, and the flood
 * degenerated to "the source's own two net names". That is not merely dead but
 * **inverted**: for `V1 in 0 5 / R1 in out 1k`, net `in` and `0` rendered live
 * while `out` — the net the source actually drives through R1 — rendered grey.
 *
 * A component is what joins two nets, so it is the right edge to traverse: the
 * source drives `out` *through* R1. That is reachability, not a solved DC
 * operating point — a capacitor in steady state carries no current, and topology
 * cannot know that. It is the honest approximation and it is strictly better
 * than one flat grey.
 *
 * Returns the set of net names the source reaches. No source yields an empty
 * set, which the renderer treats as "highlight nothing". */
function poweredNodes(graph: SchematicGraph): Set<string> {
  const adj = new Map<string, Set<string>>();
  const nodesOf = (c: SchematicComponent) => c.nodes.filter(Boolean);
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const c of graph.components) {
    const ns = nodesOf(c);
    // A two-or-more terminal part joins its nets: net[0] to every other, which
    // covers 3+ terminals too without assuming a series chain.
    for (let i = 1; i < ns.length; i++) link(ns[0], ns[i]);
  }

  const reached = new Set<string>();
  for (const c of graph.components) {
    if (c.kind !== 'voltage' && c.kind !== 'isource') continue;
    /* Seed BOTH terminals — but not for the reason previously claimed.
     *
     * The old comment said "the return leg only becomes reachable if the source
     * seeds both ends", which is false: `link(ns[0], ns[i])` above already joins
     * a source's own nets, so seeding the first terminal always reaches the
     * second. A mutation to `.slice(0, 1)` left every test green, which is how
     * the redundancy was found.
     *
     * Seeding both is kept anyway for the case the source's own nets are NOT
     * linked — a two-terminal part with an unparsed/missing node entry — where
     * the far leg would otherwise be unreachable and its return wire drawn dead.
     * Both terminals is a superset, so it can only ever add reachability a user
     * would expect. */
    for (const start of nodesOf(c)) {
      const queue = [start];
      const seen = new Set<string>([start]);
      while (queue.length) {
        const cur = queue.shift()!;
        reached.add(cur);
        for (const next of adj.get(cur) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return reached;
}

/** Source terminal polarity: `+` on the higher-potential pin, `−` on the lower.
 *
 *  Two facts, not one. SPICE's `V1 in 0 5` puts node 0 on the SECOND pin, so
 *  the ground side follows `nodes.indexOf('0')` rather than assuming left is
 *  positive — the same reason the ground bars are placed that way. AND the
 *  value's own sign flips it: for `V1 in 0 -5`, node `0` is the HIGHER
 *  potential, so `in` is the `−` terminal. Deriving only from `indexOf('0')`
 *  marked a −5 V source exactly backwards, which is the whole point of drawing
 *  polarity at all.
 *
 *  Emitted in absolute user coordinates — `Component.pins()` already applies the
 *  odd-`rot` 90° turn, so these are final screen positions and must not be
 *  nested inside the component group's own rotation. */
function sourcePolarity(c: SchematicComponent): string {
  const [p0, p1] = c.pins;
  if (!p0 || !p1) return '';
  const zeroAt = c.nodes.indexOf('0');
  const groundPin = zeroAt === 0 ? 0 : 1;
  const value = String(c.value ?? '').trim();
  // `V1 in 0 DC -5` / `-5V` / `- 5`. A leading `-` means the ground node sits at
  // the HIGHER potential, so the signs swap.
  const groundIsHigher = /^-\s*[\d.]/.test(value);
  const negIndex = groundIsHigher ? (groundPin === 0 ? 1 : 0) : groundPin;
  const cx = (p0[0] + p1[0]) / 2;
  const cy = (p0[1] + p1[1]) / 2;
  /* Push each mark out along the pin's own direction from the symbol centre.
   *
   * The first version wrote `(dx / len) * off * Math.sign(dx)`, but
   * `dx / Math.hypot(dx, 0)` IS `sign(dx)` already — the extra `Math.sign`
   * squared it, so the offset was always `+off`. Every mark landed 15px to the
   * RIGHT of its own pin regardless of which side that pin was on: with pins
   * at (0,0) and (40,0) the `+` was drawn at x=15, inside the r=11 circle, and
   * swapping the pins still put `+` at 55. A single unit vector from centre to
   * pin has no such failure mode. */
  const RADIUS = 15;
  const out: string[] = [];
  /* Iterate PIN INDEX only — never a `[index, glyph]` pair carrying a default.
   * The pair version hard-coded pin 1 as `−` and then used
   * `i === negIndex ? '−' : glyph`, so `negIndex` could subtract a `+` but could
   * never promote pin 1 back to `+`. Any source whose ground node was on pin 0
   * (`V1 0 in 5`) rendered `−` on BOTH terminals — caught by the negative-value
   * case below, which no earlier test exercised. */
  for (const i of [0, 1] as const) {
    const p = i === 0 ? p0 : p1;
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const len = Math.hypot(dx, dy) || 1;
    const x = p[0] + (dx / len) * RADIUS;
    const y = p[1] + (dy / len) * RADIUS;
    /* Nudge PERPENDICULAR to the pin axis, not always in y. An unconditional
     * `±5` on y only lifts the glyph off a horizontal wire; for an odd-`rot`
     * (vertical) source the wire runs vertically through x, so the same nudge
     * moved the glyph ALONG the wire it was meant to clear. Rotating the
     * perpendicular by the pin's own bearing keeps the two cases symmetric. */
    const nx = -dy / len;
    const ny = dx / len;
    const side = i === 0 ? -1 : 1;
    const px = x + nx * 5 * side;
    const py = y + ny * 5 * side;
    out.push(
      `<text x="${px.toFixed(1)}" y="${py.toFixed(1)}" font-size="12" font-weight="700" ` +
        `text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" fill="${CURRENT_TINT}">` +
        `${i === negIndex ? '−' : '+'}</text>`,
    );
  }
  return out.join('');
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
    ox: c.col * grid - pinMean(c).x,
    oy: c.row * grid - pinMean(c).y,
  });

  const powered = useMemo(() => (graph ? poweredNodes(graph) : new Set<string>()), [graph]);

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
    const mean = pinMean(c);
    dragRef.current = { ref, dx: p.x - mean.x, dy: p.y - mean.y };
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
        <Waves className="size-3 text-muted-foreground/70" />
        <span className="truncate text-2xs font-semibold text-foreground">Schematic</span>
        <span className="truncate text-2xs text-muted-foreground/70">{netlistPath.split(/[\\/]/).pop()}</span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setFlow((f) => !f)}
            className={cn(
              'rounded px-1.5 py-0.5 text-2xs transition',
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
            title="Save this layout"
            data-testid="schematic-save"
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
          </button>
        </span>
      </div>

      {error ? (
        <p className="px-1 py-3 text-2xs text-destructive">{error}</p>
      ) : loading && !graph ? (
        <p className="px-1 py-3 text-2xs text-muted-foreground/70">Loading schematic…</p>
      ) : graph && bounds ? (
        <svg
          ref={svgRef}
          viewBox={`${bounds.minx} ${bounds.miny} ${bounds.w} ${bounds.h}`}
          className="w-full touch-none select-none rounded-lg border border-border/50 bg-paper"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          data-testid="schematic-canvas"
        >
          {graph.wires.map((w, i) => {
            /* A wire names ONE net (`nodes=[node]`), so membership is tested
             * against the whole list rather than an assumed [from, to] pair. */
            const live = w.nodes.some((n) => powered.has(n));
            return (
              <g key={`w${i}`} data-testid={`schematic-wire-${i}`} data-live={live ? 'true' : undefined}>
                {/* The conducting path is drawn wider and in the current tint
                    so it reads as "this is live" before the animation is even
                    switched on. A dead branch stays the base grey. */}
                <path
                  d={w.path}
                  fill="none"
                  stroke={live ? CURRENT_TINT : WIRE_STROKE}
                  strokeWidth={live ? 2.5 : 1.5}
                  opacity={live ? 1 : 0.75}
                  data-testid={live ? 'schematic-wire-live' : 'schematic-wire-idle'}
                />
                {/* Arrowheads only on a live wire. Animating current along a
                    branch the same renderer just declared unpowered would
                    contradict the highlight directly above it. */}
                {flow && live &&
                  [0.15, 0.5, 0.85].map((base, j) => {
                    const t = (base + tick * 0.012) % 1;
                    // Arrowheads, not dots: the tangent comes from the polyline
                    // so each one points along the wire in the direction the
                    // point is travelling. A circle had no orientation at all.
                    const { x, y, angle } = pointAndTangentAlong(w.points, t);
                    return (
                      <path
                        key={j}
                        data-testid="schematic-current-arrow"
                        d="M -4 -3.2 L 4 0 L -4 3.2 Z"
                        fill={CURRENT_TINT}
                        transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${angle.toFixed(1)})`}
                      />
                    );
                  })}
              </g>
            );
          })}
          {graph.components.map((c) => {
            const mean = pinMean(c);
            const { ox, oy } = drawOffset(c, graph.grid || 10);
            return (
              <g
                key={c.ref}
                transform={`translate(${ox} ${oy}) rotate(${c.rot % 2 ? 90 : 0} ${mean.x} ${mean.y})`}
                onPointerDown={(e) => onPointerDown(e, c.ref)}
                className="cursor-grab active:cursor-grabbing"
                data-testid={`schematic-part-${c.ref}`}
              >
                <rect
                  x={mean.x - 22}
                  y={mean.y - 14}
                  width="44"
                  height="28"
                  fill="transparent"
                  stroke="none"
                />
                {/* `symbolSvg()` returns a raw HTML STRING. Rendered as a JSX
                    child, React 19 escapes it into an inert text node — so
                    every part drew NOTHING: no circle, no zig-zag, no
                    capacitor plates, no BJT. Measured: 0 stroked shapes in the
                    DOM for all six part kinds, each present as a literal
                    `"<circle cx=..."` text node. Silent, because SVG only
                    paints text inside <text>, so there was no visual artifact
                    either — just labels floating over a wire tangle.

                    The fix is `dangerouslySetInnerHTML`, which is what the
                    polarity group below already does and which demonstrably
                    works. The backend does not have this bug: `render_svg`
                    joins `_symbol_svg` output as raw strings. The header
                    comment claiming editor and backend "show the same circuit"
                    was false until now.

                    The 15-test suite missed it because none of them query
                    `circle|polyline|path|line`. A test that asserts a stroked
                    shape exists for each kind is added below. */}
                <g
                  data-testid="schematic-symbol"
                  dangerouslySetInnerHTML={{ __html: symbolSvg(c) }}
                />
                <text
                  x={mean.x}
                  y={mean.y - 16}
                  textAnchor="middle"
                  fontSize="11"
                  fontFamily="Segoe UI, system-ui, sans-serif"
                  /* Label colour follows the theme. The hardcoded #0f172a came
                     from the light-paper artifact renderer and on the dark
                     --dt-paper canvas measured 1.01:1 — the label was
                     literally darker than the background it sat on. */
                  fill="var(--dt-foreground)"
                >
                  {esc(`${c.ref} ${c.value}`.trim())}
                </text>
              </g>
            );
          })}
          {/* Polarity is drawn OUTSIDE the per-component <g>, in absolute user
              coordinates, because `Component.pins()` ALREADY applies the 90°
              rotation for odd `rot` (`schematic.py:282-289`) and the component
              group applies it a second time. Drawing inside that group therefore
              rotated the marks 90° out of their own pin frame: for `V1 in 0 5`
              with `rot:1`, `+` belonged to the top pin and landed to the right,
              `−` belonged to the bottom pin and landed to the left, both at the
              same height and 38px from their pins.
              Removing the child's own transform did NOT fix that — it was the
              parent that was doubled. Emitting from `c.pins`, which are already
              final screen coordinates, sidesteps both rotations entirely and is
              correct for any `rot`. */}
          {graph.components.map((c) =>
            c.kind === 'voltage' || c.kind === 'isource' ? (
              <g
                key={`pol-${c.ref}`}
                dangerouslySetInnerHTML={{ __html: sourcePolarity(c) }}
                data-testid="schematic-source-polarity"
              />
            ) : null,
          )}
        </svg>
      ) : (
        <p className="px-1 py-3 text-2xs text-muted-foreground/70">No components in this deck.</p>
      )}
    </div>
  );
}
