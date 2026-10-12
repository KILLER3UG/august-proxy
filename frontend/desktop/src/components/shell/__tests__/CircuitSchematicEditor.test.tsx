/* ── CircuitSchematicEditor ──────────────────────────────────────────────
 * Renders the graph from the backend, drags a part and saves the layout
 * sidecar, and toggles the flow animation. The netlist is never touched —
 * the save call only sends moves.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CircuitSchematicEditor } from '../CircuitSchematicEditor';

const graph = {
  components: [
    {
      ref: 'R1', kind: 'resistor', nodes: ['in', 'out'], value: '1k',
      col: 0, row: 0, rot: 0,
      pins: [{ 0: -20, 1: 0 }, { 0: 20, 1: 0 }] as [{ 0: number; 1: number }, { 0: number; 1: number }],
    },
    {
      ref: 'V1', kind: 'voltage', nodes: ['in', '0'], value: '10',
      col: 0, row: 4, rot: 0,
      pins: [{ 0: -20, 1: 40 }, { 0: 20, 1: 40 }] as [{ 0: number; 1: number }, { 0: number; 1: number }],
    },
  ],
  wires: [{ nodes: ['in'], points: [{ 0: 0, 1: 0 }, { 0: 0, 1: 40 }], path: 'M 0 0 L 0 40' }],
  nodes: ['in', 'out'],
  grounded: true,
  grid: 10,
  layoutExists: true,
  autoLayout: false,
};

const readSchematic = vi.fn();
const editSchematic = vi.fn();

vi.mock('@/api/circuit', () => ({
  circuitApi: {
    readSchematic: (...args: unknown[]) => readSchematic(...args),
    editSchematic: (...args: unknown[]) => editSchematic(...args),
  },
}));

describe('CircuitSchematicEditor', () => {
  beforeEach(() => {
    readSchematic.mockReset().mockResolvedValue(graph);
    editSchematic.mockReset().mockImplementation(async (_s: string, body: { moves: { ref: string }[] }) => ({
      ...graph,
      components: graph.components.map((c) => {
        const m = body.moves.find((mv) => mv.ref === c.ref);
        return m ? { ...c, ...m } : c;
      }),
    }));
  });

  it('renders a part per component and a path per wire', async () => {
    render(<CircuitSchematicEditor sessionId="s1" netlistPath="rc.cir" />);
    await waitFor(() => expect(screen.getByTestId('schematic-canvas')).toBeInTheDocument());
    expect(screen.getByTestId('schematic-part-R1')).toBeInTheDocument();
    expect(screen.getByTestId('schematic-part-V1')).toBeInTheDocument();
    expect(screen.getByTestId('schematic-canvas').querySelectorAll('path')).toHaveLength(1);
  });

  it('starts clean and enables save only after a change', async () => {
    render(<CircuitSchematicEditor sessionId="s1" netlistPath="rc.cir" />);
    await waitFor(() => expect(screen.getByTestId('schematic-part-R1')).toBeInTheDocument());
    expect(screen.getByTestId('schematic-save')).toBeDisabled();
  });

  it('toggles the flow animation', async () => {
    render(<CircuitSchematicEditor sessionId="s1" netlistPath="rc.cir" />);
    await waitFor(() => expect(screen.getByTestId('schematic-canvas')).toBeInTheDocument());
    const toggle = screen.getByTestId('schematic-flow-toggle');
    // The flow markers are arrowheads (`path` + rotate), not circles: a circle
    // has no orientation, so current direction was invisible before.
    const before = screen.queryAllByTestId('schematic-current-arrow').length;
    fireEvent.click(toggle);
    await waitFor(() => {
      const after = screen.getAllByTestId('schematic-current-arrow').length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('renders nothing without a netlist path', () => {
    const { container } = render(<CircuitSchematicEditor sessionId="s1" netlistPath="" />);
    expect(container.querySelector('[data-testid="circuit-schematic-editor"]')).toBeNull();
  });
});

/* The editor must draw what the backend's static SVG draws: one pin per node,
 * and a FET body for every FET family. `J` (3 pins) and `B` (4, the last being
 * the bulk) used to fall through to the generic two-terminal box here even once
 * the backend emitted their third and fourth pins, so the live canvas and the
 * exported artifact showed different circuits. */
describe('CircuitSchematicEditor — FET families draw from their own pins', () => {
  const pin = (x: number, y: number) => ({ 0: x, 1: y });
  const fetGraph = {
    components: [
      {
        ref: 'J1', kind: 'jfet', nodes: ['d', 'g', 's'], value: 'Jmod',
        col: 0, row: 0, rot: 0,
        pins: [pin(10, -10), pin(-20, 0), pin(10, 10)],
      },
      {
        ref: 'B1', kind: 'mesfet', nodes: ['bd', 'bg', 'bs', 'bb'], value: 'Bmod',
        col: 0, row: 6, rot: 0,
        pins: [pin(20, 50), pin(-20, 55), pin(20, 70), pin(-20, 65)],
      },
    ],
    wires: [],
    nodes: ['d', 'g', 's'],
    grounded: false,
    grid: 10,
    layoutExists: true,
    autoLayout: false,
  };

  beforeEach(() => {
    readSchematic.mockReset().mockResolvedValue(fetGraph);
    editSchematic.mockReset();
  });

  /** Only the symbol group — every part also carries a transparent `<rect>`
   *  hit-box, which is not the drawn body. */
  const symbolOf = (ref: string) =>
    screen.getByTestId(`schematic-part-${ref}`).querySelector('[data-testid="schematic-symbol"]')!
      .innerHTML;

  it('draws the JFET as a round-body FET, not the generic box', async () => {
    render(<CircuitSchematicEditor sessionId="s1" netlistPath="amp.cir" />);
    await waitFor(() => expect(screen.getByTestId('schematic-part-J1')).toBeInTheDocument());
    const svg = symbolOf('J1');
    expect(svg).toContain('<circle');
    // The generic two-terminal body this kind used to fall through to is a
    // stroked rect; a FET body is a circle.
    expect(svg).not.toContain('<rect');
    // A JFET gate is a Schottky contact: ONE bar. Only a MOSFET gets the
    // second, insulated bar — otherwise the two are indistinguishable here
    // exactly as they are in the exported SVG.
    expect((svg.match(/<line x1="-4" y1="-7" x2="-4" y2="7"/g) ?? []).length).toBe(1);
    expect(svg).not.toContain('<path'); // no collector arrow on a JFET
  });

  it('aims the extra leads at the body when the part is rotated', async () => {
    /* rot=90° swaps the pin axes, so `(mid, y0)` — the midpoint the horizontal
     * layout implies — is a PIN of a vertical part. Stubs drawn toward it aimed
     * at another pin instead of the body, and the live canvas diverged from the
     * artifact the backend exports. The mean of all pins is rotation-invariant. */
    readSchematic.mockReset().mockResolvedValue({
      ...fetGraph,
      components: [
        {
          ref: 'B9', kind: 'mesfet', nodes: ['bd', 'bg', 'bs', 'bb'], value: 'Bmod',
          col: 4, row: 4, rot: 1,
          pins: [pin(90, 100), pin(75, 120), pin(110, 120), pin(95, 140)],
        },
      ],
    });
    render(<CircuitSchematicEditor sessionId="s1" netlistPath="amp.cir" />);
    await waitFor(() => expect(screen.getByTestId('schematic-part-B9')).toBeInTheDocument());
    const svg = symbolOf('B9');
    // mean of the four pins = (92.5, 120) — the body sits there, not on a pin.
    expect(svg).toContain('<circle cx="92.5" cy="120" r="14"');
    expect(svg).toMatch(/<line x1="95" y1="140" x2="9[0-4]" y2="1[23][0-9]"/);
  });

  it('draws a lead for the MESFET bulk pin so its wire lands on something', async () => {
    render(<CircuitSchematicEditor sessionId="s1" netlistPath="amp.cir" />);
    await waitFor(() => expect(screen.getByTestId('schematic-part-B1')).toBeInTheDocument());
    const svg = symbolOf('B1');
    // Pins 0-2 build the symbol; pin 3 (the bulk, at -20,65) must still get a
    // lead toward the body...
    expect(svg).toMatch(/<line x1="-20" y1="65" x2="[-\d]+" y2="[-\d]+"/);
    // ...and the body must sit on the mean of ALL FOUR pins — (0, 60), the
    // layout origin — not the mean of the first three, which is off it.
    expect(svg).toContain('<circle cx="0" cy="60" r="14"');
    // One bar: like a JFET, a MESFET gate is not insulated.
    expect((svg.match(/<line x1="-4" y1="53" x2="-4" y2="67"/g) ?? []).length).toBe(1);
    expect(svg).not.toContain('x1="-8"');
  });
});
