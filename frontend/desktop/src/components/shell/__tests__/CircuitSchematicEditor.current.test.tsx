/* ── CircuitSchematicEditor: current direction, polarity, live path ────────
 *
 * Three things a user cannot do with the previous renderer:
 *   1. see WHICH WAY current flows — the flow animation drew anonymous circles,
 *      which have no orientation, so direction was invisible;
 *   2. see source polarity — nothing marked + or − at all;
 *   3. see the conducting path — every wire was the same grey, so a live loop
 *      and a dead branch were drawn identically.
 *
 * THE FIXTURES BELOW MATCH THE BACKEND. `schematic.py` builds
 * `Wire(points=..., nodes=[node])` — ONE net name per wire, being the net that
 * wire is drawn on (`tests/test_schematic.py` asserts `w.nodes == ['out']`).
 * An earlier version of this file used two-element `nodes: ['in','out']`
 * wire pairs, which the backend never emits; the highlight then passed its
 * tests while `poweredNodes` produced an empty adjacency graph against real
 * data and rendered the driven net GREY. Every fixture here is single-node.
 *
 * jsdom has no layout engine, so geometry is asserted through the attributes
 * the renderer emits, not through pixels.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CircuitSchematicEditor } from '../CircuitSchematicEditor';

type Pin = { 0: number; 1: number };

/** `V1 in 0 10V`, `R1 in out 1k` — the canonical divider. */
const divider = {
  components: [
    {
      ref: 'V1', kind: 'voltage', nodes: ['in', '0'], value: '10V',
      col: 0, row: 0, rot: 0,
      pins: [{ 0: 0, 1: 0 }, { 0: 40, 1: 0 }] as [Pin, Pin],
    },
    {
      ref: 'R1', kind: 'resistor', nodes: ['in', 'out'], value: '1k',
      col: 2, row: 0, rot: 0,
      pins: [{ 0: 60, 1: 0 }, { 0: 100, 1: 0 }] as [Pin, Pin],
    },
  ],
  /* One net name per wire, exactly as the backend emits. */
  wires: [
    { nodes: ['in'], points: [{ 0: 0, 1: 0 }, { 0: 40, 1: 0 }], path: 'M 0 0 L 40 0' },
    { nodes: ['0'], points: [{ 0: 40, 1: 0 }, { 0: 40, 1: 40 }], path: 'M 40 0 L 40 40' },
    { nodes: ['out'], points: [{ 0: 60, 1: 0 }, { 0: 100, 1: 0 }], path: 'M 60 0 L 100 0' },
  ],
  nodes: ['in', '0', 'out'],
  grounded: true,
  grid: 10,
};

/* The divider plus a floating sub-circuit on nets no source reaches. */
const withFloating = {
  ...divider,
  components: [
    ...divider.components,
    {
      ref: 'XF', kind: 'subckt', nodes: ['flt', 'flt2'], value: '',
      col: 6, row: 4, rot: 0,
      pins: [{ 0: 160, 1: 60 }, { 0: 200, 1: 60 }] as [Pin, Pin],
    },
  ],
  wires: [
    ...divider.wires,
    { nodes: ['flt'], points: [{ 0: 160, 1: 60 }, { 0: 200, 1: 60 }], path: 'M 160 60 L 200 60' },
  ],
  nodes: [...divider.nodes, 'flt', 'flt2'],
};

const readSchematic = vi.fn();
const editSchematic = vi.fn();

vi.mock('@/api/circuit', () => ({
  circuitApi: {
    readSchematic: (...args: unknown[]) => readSchematic(...args),
    editSchematic: (...args: unknown[]) => editSchematic(...args),
  },
}));

async function renderEditor(g = divider) {
  readSchematic.mockResolvedValue(g);
  render(<CircuitSchematicEditor sessionId="s1" netlistPath="rc.cir" />);
  await screen.findByTestId('schematic-canvas');
}

describe('CircuitSchematicEditor — current flow is directional', () => {
  beforeEach(() => {
    editSchematic.mockReset().mockImplementation(async () => divider);
  });

  it('draws arrowheads, not anonymous dots, when flow is on', async () => {
    await renderEditor();
    fireEvent.click(screen.getByTestId('schematic-flow-toggle'));
    await waitFor(() => expect(screen.getAllByTestId('schematic-current-arrow').length).toBeGreaterThan(0));
    const first = screen.getAllByTestId('schematic-current-arrow')[0];
    expect(first.tagName.toLowerCase()).toBe('path');
    expect(first.getAttribute('transform')).toMatch(/rotate\(-?[\d.]+\)/);
  });

  it('orients a horizontal wire arrow along the wire, not up or down', async () => {
    await renderEditor();
    fireEvent.click(screen.getByTestId('schematic-flow-toggle'));
    await waitFor(() => expect(screen.getAllByTestId('schematic-current-arrow').length).toBeGreaterThan(0));
    const angles = screen
      .getAllByTestId('schematic-current-arrow')
      .map((a) => Number(/rotate\((-?[\d.]+)\)/.exec(a.getAttribute('transform') ?? '')?.[1] ?? 'NaN'));
    // The `in` and `out` wires are horizontal (left→right = 0deg). The `0`
    // return wire is vertical (±90deg). Nothing may be NaN.
    expect(angles.every(Number.isFinite)).toBe(true);
    expect(angles.some((a) => Math.abs(a) < 1)).toBe(true);
    expect(angles.some((a) => Math.abs(Math.abs(a) - 90) < 1)).toBe(true);
  });

  it('never animates current along a wire it just declared unpowered', async () => {
    await renderEditor(withFloating);
    fireEvent.click(screen.getByTestId('schematic-flow-toggle'));
    await waitFor(() => expect(screen.getAllByTestId('schematic-current-arrow').length).toBeGreaterThan(0));
    const idle = screen.getAllByTestId('schematic-wire-idle');
    expect(idle).toHaveLength(1);
    // The floating net's wire carries no arrowhead.
    for (const wire of idle) {
      expect(wire.parentElement?.querySelectorAll('[data-testid="schematic-current-arrow"]')).toHaveLength(0);
    }
  });

  it('marks source polarity with + and −, and reads the VALUE sign', async () => {
    // Read from a single mounted tree at a time — two renders in one test both
    // contribute `[data-testid]` nodes to the document.
    const read = async (g: typeof divider) => {
      readSchematic.mockResolvedValue(g);
      const { unmount } = render(<CircuitSchematicEditor sessionId="s1" netlistPath="rc.cir" />);
      await screen.findByTestId('schematic-canvas');
      const out = Array.from(document.querySelectorAll('[data-testid="schematic-source-polarity"] text'))
        .map((m) => ({ glyph: m.textContent, x: Number(m.getAttribute('x')) }));
      unmount();
      return out;
    };

    const marks = await read(divider);
    expect(marks).toHaveLength(2);
    // `V1 in 0 10V` puts node 0 on the SECOND pin, so − must be there.
    expect(marks.map((m) => m.glyph).sort()).toEqual(['+', '−']);
    // Pin 0 (node `in`, x<0) is `+` for a positive source.
    expect(marks.find((m) => m.x < 0)?.glyph).toBe('+');

    // A NEGATIVE source flips it: for `V1 in 0 -5`, node 0 is the higher
    // potential, so `in` is the `−` terminal. Deriving only from
    // `nodes.indexOf('0')` marked a −5 V source exactly backwards.
    const neg = await read({
      ...divider,
      components: divider.components.map((c) => (c.kind === 'voltage' ? { ...c, value: '-5' } : c)),
    });
    expect(neg.find((m) => m.x < 0)?.glyph).toBe('−');
    expect(neg.find((m) => m.x > 40)?.glyph).toBe('+');
  });

  it('places each mark outside the symbol, on its OWN pin side, clear of the wire', async () => {
    // The first version computed `(dx / len) * off * Math.sign(dx)` — but
    // `dx / len` is already sign(dx), so the extra sign squared it and every
    // mark landed 15px to the RIGHT of its pin. With pins (0,0)/(40,0) the `+`
    // sat at x=15, INSIDE the r=11 circle.
    //
    // The second version nudged with `±5` on Y unconditionally, which only
    // lifts a glyph off a HORIZONTAL wire; for a vertical source it moved the
    // glyph ALONG the wire. Both mutants survived an earlier version of this
    // suite because it asserted only the SIGN of a coordinate, which the buggy
    // code also satisfies. So assert the full geometry, and assert the mark is
    // displaced PERPENDICULAR to the pin axis by a real margin — not merely
    // negative.
    const read = async (g: typeof divider) => {
      readSchematic.mockResolvedValue(g);
      const { unmount } = render(<CircuitSchematicEditor sessionId="s1" netlistPath="rc.cir" />);
      await screen.findByTestId('schematic-canvas');
      const out = Array.from(document.querySelectorAll('[data-testid="schematic-source-polarity"] text'))
        .map((m) => ({ glyph: m.textContent, x: Number(m.getAttribute('x')), y: Number(m.getAttribute('y')) }));
      unmount();
      return out;
    };

    // ── horizontal, pins (0,0)/(40,0), centre x=20 ──
    const marks = await read(divider);
    const plus = marks.find((m) => m.glyph === '+')!;
    const minus = marks.find((m) => m.glyph === '−')!;
    expect(plus.x).toBeLessThan(0);
    expect(minus.x).toBeGreaterThan(40);
    // NUDGE IS ON Y for a horizontal pin axis (ny = ∓1), with a real margin.
    expect(Math.abs(plus.y)).toBeGreaterThanOrEqual(4.9);

    // ── swapped pins swap the sides ──
    const swapped = await read({
      ...divider,
      components: divider.components.map((c) =>
        c.kind === 'voltage' ? { ...c, pins: [{ 0: 40, 1: 0 }, { 0: 0, 1: 0 }] as [Pin, Pin] } : c,
      ),
    });
    expect(swapped.find((m) => m.glyph === '+')!.x).toBeGreaterThan(40);
    expect(swapped.find((m) => m.glyph === '−')!.x).toBeLessThan(0);

    // ── vertical source: separation is on Y, and the nudge is on X ──
    // pins (0,0)/(0,40), centre (0,20). Out-along-pin puts `+` at (0,-15) and
    // `−` at (0,55) — the far pin is at y=40 and is pushed a further 15 out.
    // The perpendicular is the X axis and ny is exactly 0 here, so Y must be
    // UNCHANGED from those along-pin values.
    //
    // Asserting exact values, not magnitudes: with these symmetric fixtures the
    // perpendicular direction happens to equal the buggy `+5` constant
    // (nx = ±1), so `|x| >= 4.9` is satisfied by BOTH the correct code and the
    // `x/y ± 5` revert. That is why both nudge mutants survived an earlier
    // version of this suite. Exact Y is satisfied only by the perpendicular
    // form, which leaves Y alone.
    const vertical = await read({
      ...divider,
      components: divider.components.map((c) =>
        c.kind === 'voltage' ? { ...c, pins: [{ 0: 0, 1: 0 }, { 0: 0, 1: 40 }] as [Pin, Pin] } : c,
      ),
    });
    const vPlus = vertical.find((m) => m.glyph === '+')!;
    const vMinus = vertical.find((m) => m.glyph === '−')!;
    expect(vPlus.y).toBe(-15);
    expect(vMinus.y).toBe(55);
    // displaced across the wire, which runs vertically through x = 0
    expect(vPlus.x).toBe(-5);
    expect(vMinus.x).toBe(-5);

    // ── horizontal source: ny === ∓1, so the nudge lands on Y ──
    const exactH = await read(divider);
    const hPlus = exactH.find((m) => m.x < 0)!;
    const hMinus = exactH.find((m) => m.x > 40)!;
    expect(hPlus).toEqual({ glyph: '+', x: -15, y: 5 });
    expect(hMinus).toEqual({ glyph: '−', x: 55, y: 5 });
  });

  it('emits polarity in absolute coordinates, outside the component rotation', async () => {
    // `Component.pins()` ALREADY applies the 90° turn for odd `rot`
    // (`schematic.py:282-289`), and the component group applies it again. A
    // polarity group NESTED inside that group therefore came out rotated 90° out
    // of its own pin frame: for a source at (0,0) with rot:1 and vertical pins
    // (0,-20)/(0,20), `+` belonged to the top pin and landed to the RIGHT at
    // (35,-5), `−` to the left at (-35,-5), both at the same height and ~40px
    // from their pins.
    //
    // Removing the child's own transform did NOT fix that — the parent was the
    // doubled one. So the marks must be emitted from `c.pins` in absolute user
    // coordinates, outside the rotating group entirely.
    const rotated = {
      ...divider,
      components: divider.components.map((c) =>
        c.kind === 'voltage'
          ? { ...c, rot: 1, pins: [{ 0: 0, 1: -20 }, { 0: 0, 1: 20 }] as [Pin, Pin] }
          : c,
      ),
    };
    await renderEditor(rotated);
    const group = document.querySelector('[data-testid="schematic-source-polarity"]')!;
    // It is a sibling of the per-component groups, not a descendant.
    expect(group.getAttribute('transform')).toBeNull();
    expect(group.closest('[data-testid="schematic-part-V1"]')).toBeNull();

    // And the geometry is right: top pin (0,-20) gets `+` above it, bottom pin
    // (0,20) gets `−` below, each displaced perpendicular (in X) off the wire.
    const marks = Array.from(group.querySelectorAll('text')).map((m) => ({
      glyph: m.textContent,
      x: Number(m.getAttribute('x')),
      y: Number(m.getAttribute('y')),
    }));
    const top = marks.find((m) => m.y < -20)!;
    const bottom = marks.find((m) => m.y > 20)!;
    expect(top.glyph).toBe('+');
    expect(bottom.glyph).toBe('−');
    expect(Math.abs(top.x)).toBeGreaterThanOrEqual(4.9);
    expect(Math.abs(bottom.x)).toBeGreaterThanOrEqual(4.9);
  });

  it('does not rotate the polarity twice for a turned part', async () => {
    // Cheap attribute-level regression. The assertion that actually catches the
    // doubled PARENT rotation is the geometry test above, which this one
    // previously pretended to be: it only compared attribute strings and so
    // could not see a wrong position.
    const rotated = {
      ...divider,
      components: divider.components.map((c) => (c.kind === 'voltage' ? { ...c, rot: 1 } : c)),
    };
    await renderEditor(rotated);
    const group = document.querySelector('[data-testid="schematic-source-polarity"]')!;
    expect(group.getAttribute('transform')).toBeNull();
  });

  it('draws an actual shape for every part kind, not an escaped string', async () => {
    // The regression net for the worst bug in this file's history:
    // `symbolSvg()` returns a raw HTML string, and rendering it as a JSX child
    // made React 19 escape it into an inert TEXT NODE. Every part drew nothing
    // — 0 stroked shapes in the DOM, each present as a literal
    // `"<circle cx=..."`. It went unnoticed because the suite only ever
    // asserted attributes and testids, and SVG paints no text outside <text>,
    // so there was no visual artifact either.
    //
    // This asserts on real DOM nodes, so an escape-back-to-plain-text
    // regression fails it.
    const kinds = ['voltage', 'resistor', 'capacitor', 'diode', 'inductor', 'transistor'] as const;
    for (const kind of kinds) {
      const g = {
        ...divider,
        components: divider.components.map((c, i) => ({
          ...c,
          kind: i === 0 ? kind : c.kind,
          value: i === 0 ? '5' : c.value,
          nodes: i === 0 ? ['in', '0'] : c.nodes,
        })),
      };
      readSchematic.mockResolvedValue(g);
      const { unmount } = render(<CircuitSchematicEditor sessionId="s1" netlistPath="rc.cir" />);
      await screen.findByTestId('schematic-canvas');
      const sym = document.querySelector('[data-testid="schematic-symbol"]');
      expect(sym, `no symbol group rendered for ${kind}`).not.toBeNull();
      const shapes = sym!.querySelectorAll('circle, polyline, path, line, rect');
      expect(shapes.length, `${kind} rendered no stroked SVG shape`).toBeGreaterThan(0);
      // And nothing may have leaked into the DOM as escaped markup text.
      expect(sym!.textContent ?? '').not.toContain('<');
      unmount();
    }
  });

  it('highlights the whole divider: every net the source reaches', async () => {
    // The regression this guards: adjacency built from wire node PAIRS yields
    // an empty graph on real backend data, so only the source's own two nets
    // light up and `out` — the net driven through R1 — renders grey.
    await renderEditor();
    const live = screen.getAllByTestId('schematic-wire-live');
    // queryAll — getAllBy throws on an empty list, which is exactly what this
    // assertion is checking for.
    const idle = screen.queryAllByTestId('schematic-wire-idle');
    expect(live).toHaveLength(3);
    expect(idle).toHaveLength(0);

    // Wider and a different hue than an idle wire would be — compared against
    // each other, not a literal hex, so it cannot drift with the palette.
  });

  it('distinguishes a live wire from an idle one by weight AND hue', async () => {
    await renderEditor(withFloating);
    await waitFor(() => expect(screen.getAllByTestId('schematic-wire-idle')).toHaveLength(1));
    const livePath = screen.getAllByTestId('schematic-wire-live')[0];
    const idlePath = screen.getAllByTestId('schematic-wire-idle')[0];
    expect(Number(livePath.getAttribute('stroke-width'))).toBeGreaterThan(
      Number(idlePath.getAttribute('stroke-width')),
    );
    expect(livePath.getAttribute('stroke')).not.toBe(idlePath.getAttribute('stroke'));
  });

  it('leaves a floating sub-circuit unpowered', async () => {
    await renderEditor(withFloating);
    expect(screen.getAllByTestId('schematic-wire-live')).toHaveLength(3);
    expect(screen.getAllByTestId('schematic-wire-idle')).toHaveLength(1);
  });

  it('highlights nothing when the circuit has no source', async () => {
    const noSource = {
      ...divider,
      components: [divider.components[1]],
    };
    await renderEditor(noSource);
    expect(screen.queryAllByTestId('schematic-wire-live')).toHaveLength(0);
    expect(screen.getAllByTestId('schematic-wire-idle').length).toBeGreaterThan(0);
  });
});