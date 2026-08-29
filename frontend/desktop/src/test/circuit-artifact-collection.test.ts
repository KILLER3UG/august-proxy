/* Circuit panel artifact collection — the gated /circuit family (circuit_*,
 * firmware_*, hdl_*, vcd_parse, fpga_compile, kicad_*) must land its
 * artifacts in the panel: the new family returns waveFile/svgFile/junitFile/
 * sofFile/renderedFile keys that the original circuit_-only collectors
 * never saw. */
import { describe, it, expect } from 'vitest';
import { collectWaveformArtifacts } from '@/components/shell/CircuitWaveformViewer';
import type { ChatMessage } from '@/types/chat';

function msgWithTool(name: string, context: string, startedAt = 0): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: '2026-08-29T00:00:00Z',
    blocks: [
      {
        id: 'b1',
        type: 'toolCall',
        tool: {
          id: 't1',
          name,
          status: 'done',
          startedAt,
          context,
        },
      },
    ],
  } as unknown as ChatMessage;
}

describe('collectWaveformArtifacts across the /circuit family', () => {
  it('picks up hdl_simulate .vcd via waveFile', () => {
    const ctx = JSON.stringify({ ok: true, waveFile: 'C:/ws/sim.vcd' });
    const waves = collectWaveformArtifacts([msgWithTool('hdl_simulate', ctx)]);
    expect(waves).toHaveLength(1);
    expect(waves[0].path).toBe('C:/ws/sim.vcd');
    expect(waves[0].tool).toBe('hdl_simulate');
  });

  it('still picks up circuit_export_vcd via vcdFile', () => {
    const ctx = JSON.stringify({ ok: true, vcdFile: 'C:/ws/digital.vcd' });
    const waves = collectWaveformArtifacts([msgWithTool('circuit_export_vcd', ctx)]);
    expect(waves).toHaveLength(1);
    expect(waves[0].tool).toBe('circuit_export_vcd');
  });

  it('ignores non-waveform artifacts and non-circuit tools', () => {
    const hdlSvg = msgWithTool('hdl_timing_diagram', JSON.stringify({ svgFile: 'C:/ws/t.timing.svg' }));
    const other = msgWithTool('write_file', JSON.stringify({ path: 'C:/ws/sim.vcd' }));
    expect(collectWaveformArtifacts([hdlSvg, other])).toHaveLength(0);
  });

  it('dedupes by path (first occurrence wins) and sorts newest first', () => {
    // startedAt is a wall-clock ms timestamp (append-block-event.ts
    // Date.now()); three calls a(100), c(200), b(300), a and b share a path.
    const a = msgWithTool('hdl_simulate', JSON.stringify({ waveFile: 'C:/ws/sim.vcd' }), 100);
    const c = msgWithTool('circuit_export_vcd', JSON.stringify({ vcdFile: 'C:/ws/other.vcd' }), 200);
    const b = msgWithTool('hdl_simulate', JSON.stringify({ waveFile: 'C:/ws/sim.vcd' }), 300);
    const waves = collectWaveformArtifacts([a, c, b]);
    expect(waves).toHaveLength(2);
    // Dedupe keeps the FIRST occurrence of a path (a, ts=100); distinct
    // paths then sort newest first → c(200), a(100).
    expect(waves[0].tool).toBe('circuit_export_vcd');
    expect(waves[0].ts).toBe(200);
    expect(waves[1].tool).toBe('hdl_simulate');
    expect(waves[1].ts).toBe(100);
  });
});
