"""Schematic layout over a SPICE netlist — the sidecar model.

The **netlist stays the SPICE source of truth** (this is what every
simulator reads). The schematic is a *sidecar*: a ``<name>.layout.json``
next to the deck holding only **positions and wire routes** (nothing about
values, connectivity or parameters). Both the human editor (drag a part)
and the model's tools (place/align a part) write the same sidecar, so there
is exactly one graph — the netlist — and one layout file describing where
to draw it. Deleting the sidecar loses nothing; the circuit still simulates.

The model is deliberately tiny:

* a **grid** — positions are integer grid cells (``0.5`` step), so both
  sides place parts on the same lattice and hand-saved JSON stays tidy;
* **components** — one entry per netlist element carrying its parsed
  refdes / kind / nodes / value plus the layout ``{col, row}`` and a
  per-component ``rot`` (0 = horizontal body, 1 = vertical rung);
* **wires** — orthogonal (Manhattan) polylines between component pins,
  derived from the layout by :func:`derive_wires` unless the sidecar
  overrides a route explicitly (wire-drawing tools may do that).

Everything renders to a plain SVG with real schematic symbols (resistor
zig-zag, capacitor plates, inductor arcs, V/I sources, ground) — no GPL
renderer is embedded.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.services.sandbox.paths import bind_path

# ── Grid ───────────────────────────────────────────────────────────────────

GRID = 10.0          # px per grid cell
# kind -> pin offsets in grid cells, relative to the component's layout
# origin. Most parts are 2-terminal and symmetric; sources get their + on
# the left. The 3-terminal entries follow SPICE node order — `Q<ref> NC NB NE`
# is collector, base, emitter and `M<ref> ND NG NS` is drain, gate, source —
# and the three offsets must average to (0, 0): the editor pivots drags and
# labels on the mean of the pins, and a mean off the origin skids the body.
# The old 2-pin entries made build_graph drop the third node silently (the
# `i >= len(comp_pins)` break), so no wire ever attached to an emitter or a
# source terminal.
PIN_OFFSETS: dict[str, tuple[tuple[float, float], ...]] = {
    'resistor': ((-2, 0), (2, 0)),
    'capacitor': ((-2, 0), (2, 0)),
    'inductor': ((-2, 0), (2, 0)),
    'diode': ((-2, 0), (2, 0)),  # anode left
    'voltage': ((-2, 0), (2, 0)),
    'isource': ((-2, 0), (2, 0)),
    'transistor': ((1, -1), (-2, 0), (1, 1)),   # C, B, E
    'mosfet': ((1, -1), (-2, 0), (1, 1)),       # D, G, S
    'jfet': ((1, -1), (-2, 0), (1, 1)),         # D, G, S
    # Berkeley SPICE `B` is the 4-terminal MESFET: ND NG NS NB. Drain and
    # source on the right column, gate and bulk on the left, so the mean is
    # exactly the origin like every entry above (x: 2-2+2-2, y: -1+1-0.5+0.5).
    'mesfet': ((2, -1), (-2, -0.5), (2, 1), (-2, 0.5)),
    'subckt': ((-2, 0), (2, 0)),
    'switch': ((-2, 0), (2, 0)),
}
DEFAULT_OFFSETS = ((-2, 0), (2, 0))

# The three-to-plus-terminal silicon. All four draw from the FET branch of
# `_symbol_svg`: bar + two channel leads, with the insulated second bar only
# for `mosfet` and the emitter arrow only for `transistor` (channel polarity
# for J/B lives on the model card, which the graph does not carry).
_FET_KINDS = ('transistor', 'mosfet', 'jfet', 'mesfet')


def pin_offsets(kind: str, node_count: int) -> tuple[tuple[float, float], ...]:
    """Pin offsets for `kind`, ALWAYS with one entry per netlist node.

    The table owns the shape for the classes it knows. When a part has more
    nodes than its entry has offsets — a 5-pin `X` instance, a device letter
    the table does not name — the extra pins are generated symmetric about the
    origin rather than dropped: `build_graph` used to `break` at the end of the
    pin list, so those nodes got no pin, no wire, and drew floating. Generated
    pins are recentred because the editor pivots drags and labels on the mean
    of the pins, and a mean off the origin skids the body.
    """
    offs = PIN_OFFSETS.get(kind, DEFAULT_OFFSETS)
    if len(offs) >= max(node_count, 2):
        # `max(…, 2)`: `_symbol_svg` draws its body between pins 0 and 1, so a
        # one-node (malformed) element still needs the 2-pin shape.
        return offs
    # Left/right columns of pairs. An even count mirrors the rows about y=0;
    # an odd count adds one pin at the bottom centre and biases the rows up by
    # half a step so the sums cancel. Both stay in multiples of 0.5, so the
    # mean is (0,0) exactly and not to within float noise — the pin mean is
    # what the editor pivots on and what the tests compare against px().
    k = node_count // 2
    step = (k - 1) / 2 if node_count % 2 == 0 else k / 2
    pts: list[tuple[float, float]] = []
    for j in range(k):
        y = float(j - step)
        pts.append((-2.0, y))
        pts.append((2.0, y))
    if node_count % 2:
        pts.append((0.0, float(k)))
    return tuple(pts)

# Layout sidecar file name for a deck: `rc.cir` -> `rc.layout.json`.
def layout_path_for(netlist_path: Path) -> Path:
    return netlist_path.with_suffix('.layout.json')


def _bind(path: str, workspace: str, for_write: bool) -> Path:
    bound, err = bind_path(path, workspace, for_write=for_write)
    if err or bound is None:
        raise ValueError(err or f'Invalid path: {path}')
    return bound


# ── Netlist → elements ─────────────────────────────────────────────────────

_ELEMENT_LINE_RE = re.compile(r'^([A-Za-z])(\w*)\s+(.+)$')

_ELEMENT_KINDS = {
    'R': 'resistor', 'C': 'capacitor', 'L': 'inductor', 'V': 'voltage',
    'I': 'isource', 'D': 'diode', 'Q': 'transistor', 'M': 'mosfet',
    # J and B were parsed for their 3/4 nodes by _NODE_COUNT but had no kind,
    # so they rendered as anonymous 'part' with two pins and lost a wire.
    'J': 'jfet', 'B': 'mesfet',
    'X': 'subckt', 'S': 'switch', 'W': 'switch', 'K': 'coupled',
}
# Node count per device class (same table circuit_tools lints with).
# KNOWN LIMIT, stated rather than left to be rediscovered: letters outside this
# table are sliced to two nodes, so an `.lib`-defined `X` (no `.subckt` in this
# deck to count pins from) and the 4-terminal E/G/F behavioural and MESFET forms
# lose their extra nets at PARSE time — before the pin guarantee below ever sees
# them. Widening this table means widening the linter's copy too; `pin_offsets`
# already handles any count the parser produces.
_NODE_COUNT = {'Q': 3, 'J': 3, 'M': 3, 'B': 4}


@dataclass
class Element:
    ref: str
    kind: str
    nodes: list[str]
    value: str
    params: str = ''      # raw tail after the value (model name etc.)


def _subckt_pin_counts(deck_text: str) -> dict[str, int]:
    """`SUBCKTNAME` → how many pins it declares, from the deck's own
    ``.subckt`` lines. An `X` instance's node count is not static (a 4-pin
    opamp block is as legal as a 2-pin one), and slicing it to 2 hid every
    node past the second — the net existed on the block but never got a pin or
    a wire. Names defined outside this deck (`.lib`) are absent here, and the
    caller keeps the 2-node default for those."""
    counts: dict[str, int] = {}
    for raw in deck_text.splitlines():
        s = raw.strip()
        if not s.lower().startswith('.subckt'):
            continue
        toks = s.split()
        if len(toks) >= 3:
            counts[toks[1].upper()] = len(toks) - 2
    return counts


def parse_elements(deck_text: str) -> list[Element]:
    """Extract (ref, kind, nodes, value) per element line, skipping
    comments, dot-cards, ``.control`` and ``.subckt`` bodies and
    continuations — the same rules ``circuit_tools._parse_components`` /
    ``lint_netlist`` apply."""
    subckt_pins = _subckt_pin_counts(deck_text)
    out: list[Element] = []
    in_control = False
    in_subckt = False
    for raw in deck_text.splitlines():
        s = raw.strip()
        low = s.lower()
        if low.startswith('.control'):
            in_control = True
            continue
        if low.startswith('.endc'):
            in_control = False
            continue
        # A subckt's private nodes (i, n1, o …) are not part of the top-level
        # circuit; the X instance already stands for the whole block. Emitting
        # its body drew the same subcircuit twice, as free-floating parts.
        if low.startswith('.subckt'):
            in_subckt = True
            continue
        if low.startswith('.ends'):
            in_subckt = False
            continue
        if in_control or in_subckt or not s or s.startswith(('*', '+', '.')):
            continue
        m = _ELEMENT_LINE_RE.match(s)
        if not m:
            continue
        letter, ref_suffix, rest = m.groups()
        toks = rest.split()
        if len(toks) < 2:
            continue
        kind = _ELEMENT_KINDS.get(letter.upper(), 'part')
        n = _NODE_COUNT.get(letter.upper(), 2)
        if letter.upper() == 'X':
            # The block's own pin count wins, found by locating its name in the
            # line: everything before the name is a node, everything after is
            # the name plus value/params.
            for i, tok in enumerate(toks):
                if i >= 2 and tok.strip('[]').upper() in subckt_pins:
                    n = i
                    break
        nodes = [t.strip('[]') for t in toks[:n]]
        tail = toks[n:]
        value = ''
        params = ''
        for t in tail:
            if re.match(r'^[+-]?[\d.]+[A-Za-z]*', t) or t.startswith('{') or re.match(
                r'^[+-]?[\d.]+(meg|MEG|Meg|k|K|m|u|n|p|f)', t
            ):
                value = t
                params = ' '.join(tail[tail.index(t) + 1:])
                break
        out.append(Element(ref=letter.upper() + ref_suffix, kind=kind,
                           nodes=nodes, value=value, params=params))
    return out


def deck_nodes(elements: list[Element]) -> list[str]:
    """Ordered, de-duplicated node names (ground `0` excluded, returned last)."""
    seen: list[str] = []
    for el in elements:
        for n in el.nodes:
            if n != '0' and n not in seen:
                seen.append(n)
    return seen


# ── Auto layout ────────────────────────────────────────────────────────────

# A 2-terminal part spans ±2 cells plus its leads, so neighbours need this much
# column clearance or their bodies overlap and wires cross through them.
_COL_STEP = 5
# Row clearance has to fit the body, the ref/value label above it and the
# current annotation below.
_ROW_STEP = 6


def auto_layout(elements: list[Element]) -> dict[str, dict[str, float]]:
    """Place parts left-to-right by signal depth, stacking parallel branches
    into rows.

    Every part used to land in column 0 on its own row, which meant each net
    became a long vertical rail down one side and the drawing did not read as a
    circuit. Depth from the nearest source gives a signal-flow layout instead.
    Purely geometric and deterministic — no simulation knowledge — so a human or
    the model can drag parts from here and the sidecar records the result.
    """
    if not elements:
        return {}

    refs = [el.ref for el in elements]
    by_ref = {el.ref: el for el in elements}
    nets: dict[str, list[str]] = {}
    for el in elements:
        for node in el.nodes:
            if node == '0':
                continue
            nets.setdefault(node, []).append(el.ref)

    # Adjacency over shared signal nets.
    neighbours: dict[str, set[str]] = {ref: set() for ref in refs}
    for members in nets.values():
        for a in members:
            for b in members:
                if a != b:
                    neighbours[a].add(b)

    # Sources (and anything wired straight to ground) start the chain.
    seeds = [el.ref for el in elements if el.kind in ('voltage', 'isource')]
    if not seeds:
        seeds = [el.ref for el in elements if '0' in el.nodes] or [refs[0]]

    depth: dict[str, int] = {}
    frontier = list(dict.fromkeys(seeds))
    for ref in frontier:
        depth[ref] = 0
    level = 0
    while frontier:
        level += 1
        nxt: list[str] = []
        for ref in frontier:
            for other in sorted(neighbours[ref]):
                if other not in depth:
                    depth[other] = level
                    nxt.append(other)
        frontier = nxt
    for ref in refs:  # islands with no path to a source
        depth.setdefault(ref, 0)

    # Row = index within its own column, so a column of parallel branches fans
    # out vertically instead of colliding.
    per_column: dict[int, list[str]] = {}
    for ref in refs:  # keep deck order for determinism
        per_column.setdefault(depth[ref], []).append(ref)

    layout: dict[str, dict[str, float]] = {}
    for col_index, refs_in_col in sorted(per_column.items()):
        span = len(refs_in_col)
        for slot, ref in enumerate(refs_in_col):
            kind = by_ref[ref].kind
            # Tall parts (3-pin devices) need more room than a 2-terminal one.
            tall = kind in ('transistor', 'mosfet')
            layout[ref] = {
                'col': col_index * _COL_STEP,
                'row': (slot - (span - 1) / 2) * (_ROW_STEP + (2 if tall else 0)),
                'rot': 0,
            }
    return layout


# ── Sidecar read/write ─────────────────────────────────────────────────────

def read_layout(netlist_path: Path) -> dict[str, Any]:
    """Load the sidecar, or synthesize a default from the deck."""
    lp = layout_path_for(netlist_path)
    if lp.exists():
        try:
            data = json.loads(lp.read_text(encoding='utf-8'))
            if isinstance(data, dict):
                data.setdefault('grid', GRID)
                data.setdefault('components', {})
                return data
        except Exception:
            pass  # corrupt sidecar — fall back to auto layout below
    return {'grid': GRID, 'components': {}, 'auto': True}


def write_layout(netlist_path: Path, layout: dict[str, Any]) -> Path:
    lp = layout_path_for(netlist_path)
    lp.parent.mkdir(parents=True, exist_ok=True)
    lp.write_text(json.dumps(layout, indent=2), encoding='utf-8')
    return lp


# ── Graph (netlist + layout) ───────────────────────────────────────────────

@dataclass
class Component:
    ref: str
    kind: str
    nodes: list[str]
    value: str
    params: str
    col: float
    row: float
    rot: int
    wires: list[dict] = field(default_factory=list)   # attached wires, for hit-test

    def px(self) -> tuple[float, float]:
        return (self.col * GRID, self.row * GRID)

    def pins(self) -> list[tuple[float, float]]:
        offs = pin_offsets(self.kind, len(self.nodes))
        cx, cy = self.px()
        if self.rot % 2:
            # Rotate the offsets 90° about the centre: (dx, dy) -> (-dy, dx).
            # Reading the row offsets alone here returned the centre twice,
            # so every wire on a vertical part attached to its middle.
            return [(cx - ly * GRID, cy + lx * GRID) for (lx, ly) in offs]
        return [(cx + lx * GRID, cy + ly * GRID) for (lx, ly) in offs]


@dataclass
class Wire:
    points: list[tuple[float, float]]
    nodes: list[str]

    def path_d(self) -> str:
        return ' '.join(
            ('M' if i == 0 else 'L') + f' {x:.0f} {y:.0f}' for i, (x, y) in enumerate(self.points)
        )


def build_graph(deck_text: str, layout: dict[str, Any]) -> dict[str, Any]:
    """Merge the netlist graph (SoT) with the layout sidecar into renderable
    components and wires. Unknown sidecar refs are ignored; deck elements
    without a layout entry get the next free auto slot."""
    elements = parse_elements(deck_text)
    positions = layout.get('components') or {}
    assigned: set[str] = set()
    components: list[Component] = []
    auto = auto_layout(elements)
    for el in elements:
        p = positions.get(el.ref) or auto.get(el.ref) or {'col': 0, 'row': 0, 'rot': 0}
        assigned.add(el.ref)
        components.append(
            Component(ref=el.ref, kind=el.kind, nodes=el.nodes, value=el.value,
                      params=el.params, col=float(p.get('col', 0)),
                      row=float(p.get('row', 0)), rot=int(p.get('rot', 0)))
        )
    # Wires: route each shared net as a horizontal bus with vertical stubs.
    # Explicit wireRoutes in the sidecar (keyed "ref:node") win.
    net_pins: dict[str, list[tuple[str, int, tuple[float, float]]]] = {}
    for comp in components:
        # zip, not an index loop with a `break`: pin_offsets guarantees one pin
        # per node now, so a part with more nodes than the table has offsets
        # attaches every one of its nets instead of silently losing node 3+.
        for i, (node, pin) in enumerate(zip(comp.nodes, comp.pins())):
            net_pins.setdefault(node, []).append((comp.ref, i, pin))
    explicit = layout.get('wireRoutes') or {}
    wires: list[Wire] = []
    for node, node_pins in net_pins.items():
        if len(node_pins) < 2:
            continue
        route = explicit.get(node)
        if route and isinstance(route, list) and route:
            explicit_pts: list[tuple[float, float]] = [
                (float(p[0]), float(p[1]))
                for p in route
                if isinstance(p, (list, tuple)) and len(p) >= 2
            ]
            if len(explicit_pts) >= 2:
                wires.append(Wire(points=explicit_pts, nodes=[node]))
                continue
        ordered = sorted(node_pins, key=lambda t: t[2][0])
        ys = [pos[1] for _, _, pos in ordered]
        if node == '0':
            # A ground rail below the lowest pin keeps the return path
            # visible instead of leaving every ground pin dangling.
            bus_y: float = max(ys) + 2 * GRID
        else:
            # Snap the bus onto the grid — the plain mean of two pin rows
            # parks every stub on a fractional coordinate.
            bus_y = round((sum(ys) / len(ys)) / GRID) * GRID
        # Bus-and-stub: walk the bus to the pin's column, drop a stub onto the
        # pin, climb back. Stepping straight from the bus to the next pin drew
        # a diagonal whenever two pins differed in BOTH x and y.
        pts: list[tuple[float, float]] = [(ordered[0][2][0], bus_y)]
        for i, (_ref, _idx, (px_, py_)) in enumerate(ordered):
            pts.append((px_, bus_y))
            pts.append((px_, py_))
            if i < len(ordered) - 1:
                pts.append((px_, bus_y))
        cleaned: list[tuple[float, float]] = []
        for p in pts:
            if not cleaned or p != cleaned[-1]:
                cleaned.append(p)
        wires.append(Wire(points=cleaned, nodes=[node]))
    return {
        'components': components,
        'wires': wires,
        'nodes': [n for n in deck_nodes(elements) if n != '0'],
        'grounded': any('0' in el.nodes for el in elements),
    }


# ── Symbols ────────────────────────────────────────────────────────────────

def _esc(t: object) -> str:
    return (str(t).replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


def _resistor_path(x0: float, y: float, x1: float, y1: float) -> str:
    span = abs(x1 - x0) or 20
    lead = span * 0.15
    body = span - 2 * lead
    steps = 6
    zig = body / steps
    pts = [(x0, y)]
    sx = 1 if x1 >= x0 else -1
    for i in range(steps):
        pts.append((x0 + sx * (lead + zig * i), y - (zig / 2 if i % 2 == 0 else -zig / 2)))
    pts.append((x1, y))
    _ = y1
    return ' '.join(f'{x:.1f},{y_:.1f}' for x, y_ in pts)


def _inductor_path(x0: float, y: float, x1: float) -> str:
    span = abs(x1 - x0) or 20
    lead = span * 0.15
    body = span - 2 * lead
    r = body / 8
    d = [f'M {x0:.1f} {y:.1f}', f'L {x0 + lead:.1f} {y:.1f}']
    for i in range(4):
        d.append(f'A {r:.1f} {r:.1f} 0 0 1 {x0 + lead + r * (i + 1):.1f} {y:.1f}')
    d.append(f'L {x1:.1f} {y:.1f}')
    return ' '.join(d)


def _symbol_svg(comp: Component, color: str, voltage: float | None,
                current: float | None) -> list[str]:
    parts: list[str] = []
    vertical = comp.rot % 2 == 1
    stroke = '#334155'
    label = _esc(f'{comp.ref} {comp.value}'.strip())
    if vertical:
        # Draw the horizontal symbol at the origin and put it on the grid with
        # translate-then-rotate. Rotating alone about (cx, cy) also slides the
        # origin-drawn body by (cy, -cx), which landed vertical parts tens of
        # pixels away from the pins the wires were routed to.
        cx, cy = comp.px()
        return [f'<g transform="translate({cx:.0f} {cy:.0f}) rotate(90)">'
                + '\n'.join(_symbol_svg(Component(comp.ref, comp.kind, comp.nodes,
                                                   comp.value, comp.params, 0, 0, 0), color, voltage, current))
                + '</g>']
    ps = comp.pins()
    # Round-bodied parts (sources r=11, the FET family r=14) need the label clear of
    # the circle; a 14px gap used to print the ref straight onto the symbol.
    label_gap = 26 if comp.kind in ('voltage', 'isource') + _FET_KINDS else 20
    if comp.kind in _FET_KINDS and len(ps) >= 3:
        # SPICE node order — Q: collector, base, emitter; M/J: drain, gate,
        # source; B: drain, gate, source, bulk — matches the pin order, so ps[0]
        # is the output-side terminal that used to exist only as a zero-length
        # line while ps[2] (the emitter/source) had no pin at all and no wire
        # could attach.
        (xc, yc), (xb, yb), (xe, ye) = ps[0], ps[1], ps[2]
        # The body sits on the mean of ALL its pins — which is the layout
        # origin, and what the editor's drags and labels pivot on. Averaging
        # only the first three left the 4-terminal MESFET's circle high of the
        # pins the wires were routed to.
        bcx = sum(p[0] for p in ps) / len(ps)
        bcy = sum(p[1] for p in ps) / len(ps)
        bar_x = bcx - 4
        gate_x = bar_x - 4 if comp.kind == 'mosfet' else bar_x
        parts.append(f'<circle cx="{bcx:.0f}" cy="{bcy:.0f}" r="14" fill="none" stroke="{stroke}" stroke-width="1.5"/>')
        parts.append(f'<line x1="{xb:.0f}" y1="{yb:.0f}" x2="{gate_x:.0f}" y2="{yb:.0f}" stroke="{stroke}" stroke-width="1.5"/>')
        parts.append(f'<line x1="{bar_x:.0f}" y1="{bcy - 7:.0f}" x2="{bar_x:.0f}" y2="{bcy + 7:.0f}" stroke="{stroke}" stroke-width="1.5"/>')
        if comp.kind == 'mosfet':
            # The insulated gate is a second bar parallel to the channel bar;
            # without it a MOSFET reads as an arrowless BJT.
            parts.append(f'<line x1="{gate_x:.0f}" y1="{bcy - 7:.0f}" x2="{gate_x:.0f}" y2="{bcy + 7:.0f}" stroke="{stroke}" stroke-width="1.5"/>')
        parts.append(f'<line x1="{bar_x:.0f}" y1="{bcy - 4:.0f}" x2="{xc:.0f}" y2="{yc:.0f}" stroke="{stroke}" stroke-width="1.5"/>')
        emit_y = bcy + 4
        if comp.kind == 'transistor':
            # NPN arrow: conventional current leaves through the emitter, so
            # the head points at the emitter pin. (The netlist's model card
            # decides NPN/PNP and the graph does not carry it; NPN is the
            # common case and the arrow direction is the only difference.)
            ang = math.atan2(ye - emit_y, xe - bar_x)
            hx, hy = xe - 7 * math.cos(ang), ye - 7 * math.sin(ang)
            px_, py_ = -3 * math.cos(ang + math.pi / 2), -3 * math.sin(ang + math.pi / 2)
            parts.append(f'<line x1="{bar_x:.0f}" y1="{emit_y:.0f}" x2="{hx:.1f}" y2="{hy:.1f}" stroke="{stroke}" stroke-width="1.5"/>')
            parts.append(f'<path d="M {hx + px_:.1f} {hy + py_:.1f} L {xe:.1f} {ye:.1f} L {hx - px_:.1f} {hy - py_:.1f} Z" fill="{stroke}" stroke="none"/>')
        else:
            parts.append(f'<line x1="{bar_x:.0f}" y1="{emit_y:.0f}" x2="{xe:.0f}" y2="{ye:.0f}" stroke="{stroke}" stroke-width="1.5"/>')
        label_x, label_y = bcx, bcy - label_gap
        cur_y = bcy + label_gap + 8
    else:
        (x0, y0), (x1, y1) = ps[0], ps[1]
        label_x, label_y = (x0 + x1) / 2, y0 - label_gap
        cur_y = y0 + label_gap + 8
    # Every pin the body does not already connect to still carries a net, so it
    # gets a lead toward the body: the FET family draws pins 0-2 (so the MESFET
    # bulk needs one), every other symbol is drawn between pins 0 and 1 (so a
    # 3-pin `X` instance or an unrecognised 4-node letter needs one from pin 2).
    # Without it the wire routes to a pin and stops in empty air beside a part
    # that looks two-terminal — the same class of silence this commit fixed.
    if comp.kind in _FET_KINDS and len(ps) >= 3:
        lead_from, bc_x, bc_y = 3, sum(p[0] for p in ps) / len(ps), sum(p[1] for p in ps) / len(ps)
    else:
        (bx0, by0), (bx1, by1) = ps[0], ps[1]
        lead_from, bc_x, bc_y = 2, (bx0 + bx1) / 2, (by0 + by1) / 2
    for (ex, ey) in ps[lead_from:]:
        ang = math.atan2(bc_y - ey, bc_x - ex)
        dist = math.hypot(bc_x - ex, bc_y - ey)
        # 14 is the FET circle's radius; the generic body is a ~10px box, so the
        # stub stops at half the gap rather than overshooting into the symbol.
        reach = max(6.0, dist - (14.0 if lead_from == 3 else 10.0))
        parts.append(
            f'<line x1="{ex:.0f}" y1="{ey:.0f}" '
            f'x2="{ex + reach * math.cos(ang):.0f}" y2="{ey + reach * math.sin(ang):.0f}" '
            f'stroke="{stroke}" stroke-width="1.5"/>'
        )
    half = 8  # body half-height (capacitor plates, diode triangle)
    if comp.kind == 'resistor':
        parts.append(f'<polyline points="{_resistor_path(x0 + 4, y0, x1 - 4, y0)}" fill="none" stroke="{stroke}" stroke-width="2"/>')
    elif comp.kind == 'capacitor':
        parts.append(f'<line x1="{x0:.0f}" y1="{y0:.0f}" x2="{(x0 + x1) / 2 - 2:.0f}" y2="{y0:.0f}" stroke="{stroke}" stroke-width="2"/>')
        parts.append(f'<line x1="{(x0 + x1) / 2 - 2:.0f}" y1="{y0 - half}" x2="{(x0 + x1) / 2 - 2:.0f}" y2="{y0 + half}" stroke="{stroke}" stroke-width="2"/>')
        parts.append(f'<line x1="{(x0 + x1) / 2 + 2:.0f}" y1="{y0 - half}" x2="{(x0 + x1) / 2 + 2:.0f}" y2="{y0 + half}" stroke="{stroke}" stroke-width="2"/>')
        parts.append(f'<line x1="{(x0 + x1) / 2 + 2:.0f}" y1="{y0:.0f}" x2="{x1:.0f}" y2="{y0:.0f}" stroke="{stroke}" stroke-width="2"/>')
    elif comp.kind == 'inductor':
        parts.append(f'<path d="{_inductor_path(x0 + 4, y0, x1 - 4)}" fill="none" stroke="{stroke}" stroke-width="2"/>')
    elif comp.kind == 'diode':
        mid = (x0 + x1) / 2
        parts.append(f'<line x1="{x0:.0f}" y1="{y0:.0f}" x2="{mid - 6:.0f}" y2="{y0:.0f}" stroke="{stroke}" stroke-width="2"/>')
        parts.append(f'<line x1="{x0:.0f}" y1="{y0 + half}" x2="{mid - 6:.0f}" y2="{y0 + half}" stroke="{stroke}" stroke-width="2"/>')
        parts.append(f'<path d="M {mid - 6:.0f} {y0 - half} L {mid + 6:.0f} {y0} L {mid - 6:.0f} {y0 + half} Z" fill="none" stroke="{stroke}" stroke-width="2"/>')
        parts.append(f'<line x1="{mid + 6:.0f}" y1="{y0:.0f}" x2="{x1:.0f}" y2="{y0:.0f}" stroke="{stroke}" stroke-width="2"/>')
    elif comp.kind in ('voltage', 'isource'):
        mid = (x0 + x1) / 2
        r = 11
        parts.append(f'<circle cx="{mid:.0f}" cy="{y0:.0f}" r="{r}" fill="none" stroke="{stroke}" stroke-width="2"/>')
        if comp.kind == 'voltage':
            parts.append(f'<line x1="{mid:.0f}" y1="{y0 - 6:.0f}" x2="{mid:.0f}" y2="{y0 + 6:.0f}" stroke="{stroke}" stroke-width="2"/>')
            parts.append(f'<line x1="{mid - 4:.0f}" y1="{y0:.0f}" x2="{mid + 4:.0f}" y2="{y0:.0f}" stroke="{stroke}" stroke-width="2"/>')
        else:
            parts.append(f'<line x1="{mid:.0f}" y1="{y0 - 6:.0f}" x2="{mid + 4:.0f}" y2="{y0 - 2:.0f}" stroke="{stroke}" stroke-width="2"/>')
            parts.append(f'<line x1="{mid - 4:.0f}" y1="{y0 - 2:.0f}" x2="{mid + 4:.0f}" y2="{y0 - 2:.0f}" stroke="{stroke}" stroke-width="2"/>')
            parts.append(f'<line x1="{mid + 4:.0f}" y1="{y0 - 2:.0f}" x2="{mid:.0f}" y2="{y0 + 6:.0f}" stroke="{stroke}" stroke-width="2"/>')
            parts.append(f'<line x1="{mid:.0f}" y1="{y0 + 6:.0f}" x2="{mid - 4:.0f}" y2="{y0 - 2:.0f}" stroke="{stroke}" stroke-width="2"/>')
        # Ground belongs on the pin that is actually tied to node '0'. The
        # unconditional else drew a ground bar on every source, including
        # floating ones that have no connection to ground at all.
        zero = next((i for i, n in enumerate(comp.nodes[:2]) if n == '0'), None)
        if zero == 0:
            parts.append(_ground_svg(x0, y0, -1))
        elif zero == 1:
            parts.append(_ground_svg(x1, y1, 1))
    elif comp.kind == 'subckt':
        w, h = abs(x1 - x0), 24
        mid = (x0 + x1) / 2
        parts.append(f'<rect x="{(x0 + x1) / 2 - abs(x1 - x0) * 0.32:.0f}" y="{y0 - h / 2:.0f}" width="{abs(x1 - x0) * 0.64:.0f}" height="{h}" fill="none" stroke="{stroke}" stroke-width="2" rx="3"/>')
        _ = w, mid
    elif comp.kind in _FET_KINDS:
        # Already drawn from all three pins above; the generic 2-pin body
        # would draw an unrelated box over it.
        pass
    else:
        parts.append(f'<line x1="{x0:.0f}" y1="{y0:.0f}" x2="{x1:.0f}" y2="{y0:.0f}" stroke="{stroke}" stroke-width="2"/>')
        parts.append(f'<rect x="{(x0 + x1) / 2 - 10:.0f}" y="{y0 - 8:.0f}" width="20" height="16" fill="none" stroke="{stroke}" stroke-width="1.5" rx="2"/>')
    parts.append(f'<text x="{label_x:.0f}" y="{label_y:.0f}" text-anchor="middle" font-size="11" font-family="Segoe UI, system-ui, sans-serif" fill="#0f172a">{label}</text>')
    cur = current
    if cur is not None and math.isfinite(cur):
        parts.append(f'<text x="{label_x:.0f}" y="{cur_y:.0f}" text-anchor="middle" font-size="10" font-family="Segoe UI, system-ui, sans-serif" fill="#b91c1c">{cur:.3g} A</text>')
    _ = voltage
    return parts


def _ground_svg(x: float, y: float, direction: int) -> str:
    bars = ''.join(
        f'<line x1="{x - (6 - i * 2):.0f}" y1="{y + direction * i * 4:.0f}" x2="{x + (6 - i * 2):.0f}" y2="{y + direction * i * 4:.0f}" stroke="#334155" stroke-width="1.5"/>'
        for i in range(3)
    )
    return bars


def render_svg(graph: dict[str, Any], title: str = 'Schematic',
               voltages: dict[str, float] | None = None,
               currents: dict[str, float] | None = None) -> str:
    """Render the graph to a standalone SVG document (native symbols)."""
    comps: list[Component] = graph['components']
    wires: list[Wire] = graph['wires']
    pad = 40
    xs: list[float] = []
    ys: list[float] = []
    for c in comps:
        for (x, y) in c.pins():
            xs.append(x)
            ys.append(y)
    for w in wires:
        for (x, y) in w.points:
            xs.append(x)
            ys.append(y)
    if not xs:
        xs, ys = [0, 100], [0, 100]
    minx, maxx = min(xs) - pad, max(xs) + pad
    # Extra headroom for the title, which is drawn at miny + 20 and used to
    # overprint the topmost part's label.
    miny, maxy = min(ys) - pad - 26, max(ys) + pad
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{minx:.0f} {miny:.0f} {maxx - minx:.0f} {maxy - miny:.0f}" '
        f'font-family="Segoe UI, system-ui, sans-serif">',
        f'<rect x="{minx:.0f}" y="{miny:.0f}" width="{maxx - minx:.0f}" height="{maxy - miny:.0f}" fill="#fdfdfb"/>',
        f'<text x="{minx + 8:.0f}" y="{miny + 20:.0f}" font-size="14" font-weight="600" fill="#0f172a">{_esc(title)}</text>',
    ]
    # wires
    for w in wires:
        parts.append(f'<path d="{w.path_d()}" fill="none" stroke="#475569" stroke-width="1.5"/>')
    # components
    vmap = voltages or {}
    cmap = currents or {}
    cur_ci = {k.lower(): v for k, v in cmap.items()}
    for c in comps:
        parts.extend(_symbol_svg(c, '#334155', vmap.get(c.nodes[0]) if c.nodes else None,
                                 cur_ci.get(c.ref.lower())))
    return '\n'.join(parts + ['</svg>'])


# Serialization for the frontend (one JSON blob the editor + animation use).
def graph_to_wire_payload(graph: dict[str, Any]) -> dict[str, Any]:
    return {
        'components': [
            {
                'ref': c.ref, 'kind': c.kind, 'nodes': c.nodes, 'value': c.value,
                'col': c.col, 'row': c.row, 'rot': c.rot,
                'pins': c.pins(),
            }
            for c in graph['components']
        ],
        'wires': [
            {'nodes': w.nodes, 'points': w.points, 'path': w.path_d()}
            for w in graph['wires']
        ],
        'nodes': graph['nodes'],
        'grounded': graph['grounded'],
        'grid': GRID,
    }
