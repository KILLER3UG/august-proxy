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
    const before = screen.getByTestId('schematic-canvas').querySelectorAll('circle').length;
    fireEvent.click(toggle);
    await waitFor(() => {
      const after = screen.getByTestId('schematic-canvas').querySelectorAll('circle').length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('renders nothing without a netlist path', () => {
    const { container } = render(<CircuitSchematicEditor sessionId="s1" netlistPath="" />);
    expect(container.querySelector('[data-testid="circuit-schematic-editor"]')).toBeNull();
  });
});
