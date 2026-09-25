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
PIN_OFFSETS: dict[str, tuple[tuple[int, int], tuple[int, int]]] = {
    # kind -> ((left-pin col,row), (right-pin col,row)) in grid cells,
    # relative to the component's layout origin. 2-terminal parts are
    # symmetric; sources get their + on the left.
    'resistor': ((-2, 0), (2, 0)),
    'capacitor': ((-2, 0), (2, 0)),
    'inductor': ((-2, 0), (2, 0)),
    'diode': ((-2, 0), (2, 0)),  # anode left
    'voltage': ((-2, 0), (2, 0)),
    'isource': ((-2, 0), (2, 0)),
    'transistor': ((-1, 0), (1, 0)),
    'mosfet': ((-1, 0), (1, 0)),
    'subckt': ((-2, 0), (2, 0)),
    'switch': ((-2, 0), (2, 0)),
}
DEFAULT_OFFSETS = ((-2, 0), (2, 0))

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
    'X': 'subckt', 'S': 'switch', 'W': 'switch', 'K': 'coupled',
}
# Node count per device class (same table circuit_tools lints with).
_NODE_COUNT = {'Q': 3, 'J': 3, 'M': 3, 'B': 4}


@dataclass
class Element:
    ref: str
    kind: str
    nodes: list[str]
    value: str
    params: str = ''      # raw tail after the value (model name etc.)


def parse_elements(deck_text: str) -> list[Element]:
    """Extract (ref, kind, nodes, value) per element line, skipping
    comments, dot-cards, ``.control`` and ``.subckt`` bodies and
    continuations — the same rules ``circuit_tools._parse_components`` /
    ``lint_netlist`` apply."""
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


def auto_layout(elements: list[Element]) -> dict[str, dict[str, int]]:
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

    layout: dict[str, dict[str, int]] = {}
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
        (lx, ly), (rx, ry) = PIN_OFFSETS.get(self.kind, DEFAULT_OFFSETS)
        cx, cy = self.px()
        if self.rot % 2:
            # Rotate the offsets 90° about the centre: (dx, dy) -> (-dy, dx).
            # Reading the row offsets alone here returned the centre twice,
            # so every wire on a vertical part attached to its middle.
            return [(cx - ly * GRID, cy + lx * GRID),
                    (cx - ry * GRID, cy + rx * GRID)]
        return [(cx + lx * GRID, cy + ly * GRID),
                (cx + rx * GRID, cy + ry * GRID)]


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
        comp_pins = comp.pins()
        for i, node in enumerate(comp.nodes):
            if i >= len(comp_pins):
                break
            net_pins.setdefault(node, []).append((comp.ref, i, comp_pins[i]))
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
    (x0, y0), (x1, y1) = comp.pins()
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
    half = 8  # body half-height
    # Round-bodied parts (sources r=11, BJT/MOSFET r=14) need the label clear of
    # the circle; a 14px gap used to print the ref straight onto the symbol.
    label_gap = 26 if comp.kind in ('voltage', 'isource', 'transistor', 'mosfet') else 20
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
    elif comp.kind in ('transistor', 'mosfet'):
        parts.append(f'<circle cx="{(x0 + x1) / 2:.0f}" cy="{y0:.0f}" r="14" fill="none" stroke="{stroke}" stroke-width="1.5"/>')
        for pin, yy in ((x0, y0 - 8), (x0, y0 + 8), (x1, y0)):
            parts.append(f'<line x1="{pin:.0f}" y1="{y0:.0f}" x2="{pin:.0f}" y2="{yy:.0f}" stroke="{stroke}" stroke-width="1.5"/>')
    else:
        parts.append(f'<line x1="{x0:.0f}" y1="{y0:.0f}" x2="{x1:.0f}" y2="{y0:.0f}" stroke="{stroke}" stroke-width="2"/>')
        parts.append(f'<rect x="{(x0 + x1) / 2 - 10:.0f}" y="{y0 - 8:.0f}" width="20" height="16" fill="none" stroke="{stroke}" stroke-width="1.5" rx="2"/>')
    parts.append(f'<text x="{(x0 + x1) / 2:.0f}" y="{y0 - label_gap:.0f}" text-anchor="middle" font-size="11" font-family="Segoe UI, system-ui, sans-serif" fill="#0f172a">{label}</text>')
    cur = current
    if cur is not None and math.isfinite(cur):
        parts.append(f'<text x="{(x0 + x1) / 2:.0f}" y="{y0 + label_gap + 8:.0f}" text-anchor="middle" font-size="10" font-family="Segoe UI, system-ui, sans-serif" fill="#b91c1c">{cur:.3g} A</text>')
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
