/* Circuit artifact collection across the gated /circuit family.
 *
 * The contract these fixtures enforce: an artifact path is a RESULT key.
 * `context` on a tool record is the model's input
 * (`makeStreamHandlers.onToolUse` → `JSON.stringify(input)`), and the
 * `toolResult` reducer branch never writes it — so the previous fixtures,
 * which hand-built a `context` containing `{waveFile: …}`, described a wire
 * shape that never occurs. Everything here goes through a `result`. */
import { describe, it, expect } from 'vitest';
import {
  collectArtifacts,
  artifactFields,
  type CircuitToolEntry,
} from '@/lib/circuit-artifacts';
import { collectCircuitDeliverables } from '@/components/chat/CircuitArtifactCard';
import { collectWaveformArtifacts } from '@/components/shell/CircuitWaveformViewer';

/** Mirror the record `makeStreamHandlers` appends to `message.tools[]`. */
function tool(
  name: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  over: Partial<CircuitToolEntry> = {},
): CircuitToolEntry {
  return {
    name,
    status: 'done',
    startedAt: 1,
    context: JSON.stringify(input, null, 2),
    result: JSON.stringify(result),
    ...over,
  };
}

function withTools(...tools: CircuitToolEntry[]) {
  return [{ id: 'm1', role: 'assistant', content: '', timestamp: '', tools }];
}

describe('collectArtifacts reads results, not arguments', () => {
  it('surfaces circuit_render_schematic, whose args name no path at all', () => {
    const arts = collectArtifacts([
      tool(
        'circuit_render_schematic',
        { netlist: 'V1 in 0 5\nR1 in out 1k\n.end', name: 'filter' },
        { path: 'C:/ws/filter.svg', savedTo: 'C:/ws/filter.svg', components: 2, wires: 3 },
      ),
    ]);
    expect(arts).toHaveLength(1);
    expect(arts[0].path).toBe('C:/ws/filter.svg');
    expect(arts[0].data.components).toBe(2);
  });

  it('surfaces the whole family via its own result key', () => {
    const cases: Array<[string, string, string, Record<string, unknown>]> = [
      ['hdl_timing_diagram', 'svgFile', 'C:/ws/t.timing.svg', { wavejson: '{signal:[]}' }],
      ['hdl_test', 'junitFile', 'C:/ws/report.xml', { module: 'tb' }],
      ['fpga_compile', 'sofFile', 'C:/ws/build.sof', { source: 'top.vhd' }],
      ['kicad_render', 'renderedFile', 'C:/ws/board.png', { pcb: 'x.kicad_pcb' }],
      ['firmware_compile', 'hexFile', 'C:/ws/blink.hex', { source: 'int main(){}' }],
      ['circuit_export_vcd', 'vcdFile', 'C:/ws/digital.vcd', { netlist: 'd.cir' }],
    ];
    for (const [name, key, path, input] of cases) {
      const arts = collectArtifacts([tool(name, input, { [key]: path, ok: true })]);
      expect(arts, name).toHaveLength(1);
      expect(arts[0].path, name).toBe(path);
    }
  });

  it('still honours a caller-chosen output path that only exists in the args', () => {
    const arts = collectArtifacts([
      tool('circuit_create_netlist', { path: 'C:/ws/divider.cir', content: 'V1 in 0 5\n.end' }, { path: 'C:/ws/divider.cir', lines: 2 }),
    ]);
    expect(arts[0].path).toBe('C:/ws/divider.cir');
  });

  it('skips a deck that was just deleted, and any non-circuit tool', () => {
    expect(collectArtifacts([
      tool('circuit_delete_netlist', { path: 'C:/ws/gone.cir' }, { ok: true }),
    ])).toHaveLength(0);
    expect(collectArtifacts([
      tool('write_file', { path: 'C:/ws/keep.cir' }, { path: 'C:/ws/keep.cir' }),
    ])).toHaveLength(0);
  });

  it('lets the result win where both carry the key', () => {
    const fields = artifactFields(
      tool('circuit_render_3d', { path: 'C:/ws/requested.png' }, { path: 'C:/ws/actual.png' }),
    );
    expect(fields.path).toBe('C:/ws/actual.png');
  });

  it('dedupes by path across windows separators', () => {
    const arts = collectArtifacts([
      tool('circuit_simulate', { netlist: 'a.cir' }, { savedTo: 'C:\\ws\\a.cir' }),
      tool('circuit_simulate', { netlist: 'a.cir' }, { savedTo: 'C:/ws/a.cir' }),
    ]);
    expect(arts).toHaveLength(1);
  });
});

describe('chat deliverable cards report real numbers', () => {
  it('reads componentCount and lines off the result', () => {
    const items = collectCircuitDeliverables([
      tool('circuit_render_3d', { path: 'C:/ws/board.png', netlistOrPath: 'a.cir' }, { path: 'C:/ws/board.png', componentCount: 7 }),
      tool('circuit_create_netlist', { path: 'C:/ws/div.cir', content: 'x' }, { path: 'C:/ws/div.cir', lines: 12 }),
      tool('circuit_simulate', { netlist: 'a.cir' }, { savedTo: 'C:/ws/a_sim.txt', measures: { vout: 4.9, i_v1: 0.005 } }),
    ]);
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i.detail]));
    expect(byLabel['board.png']).toBe('7 components');
    expect(byLabel['div.cir']).toBe('12 lines · SPICE');
    expect(byLabel['a_sim.txt']).toBe('2 measures');
  });

  it('never claims a schemdraw render for the native renderer', () => {
    const items = collectCircuitDeliverables([
      tool('circuit_render_schematic', { netlist: 'x', name: 'top' }, { savedTo: 'C:/ws/top.svg', components: 3 }),
    ]);
    expect(items[0].detail).toBe('Native schematic');
    expect(items[0].detail.toLowerCase()).not.toContain('schemdraw');
  });
});

describe('waveform picker', () => {
  it('lists an hdl_simulate waveform', () => {
    const waves = collectWaveformArtifacts(
      withTools(tool('hdl_simulate', { source: 'tb', name: 'sim' }, { waveFile: 'C:/ws/sim.vcd' })),
    );
    expect(waves.map((w) => w.path)).toEqual(['C:/ws/sim.vcd']);
  });
});
