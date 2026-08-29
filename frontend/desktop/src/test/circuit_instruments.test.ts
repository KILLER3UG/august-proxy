/* CircuitInstruments — data extraction from message-level tool results.
 * The full simulate JSON (traces, measures) lives on ChatMessage.tools[].result;
 * the block-level summary is 240-char truncated and must never be the source. */
import { describe, it, expect } from 'vitest';
import {
  collectSimResults,
  meterRows,
  parseSimResult,
  bodeMag,
} from '@/components/shell/CircuitInstruments';
import type { ChatMessage } from '@/types/chat';

function msgWithSimTool(result: string, startedAt = 0): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: '2026-08-29T00:00:00Z',
    tools: [
      {
        name: 'circuit_simulate',
        id: 't1',
        status: 'done',
        startedAt,
        result,
      },
    ],
  } as unknown as ChatMessage;
}

const TRACES_RESULT = JSON.stringify({
  installed: true,
  measures: { 'v(out)': 3.3, 'i(v1)': 0.001 },
  traces: {
    'v(out)': { x: [0, 1, 2], y: [0, 1.65, 3.3], xunit: 's', unit: 'V', points: 3 },
  },
});

describe('CircuitInstruments data extraction', () => {
  it('parses the full result JSON from the message-level tool entry', () => {
    const entry = {
      name: 'circuit_simulate',
      status: 'done' as const,
      startedAt: 5,
      result: TRACES_RESULT,
    };
    const parsed = parseSimResult(entry);
    expect(parsed).not.toBeNull();
    expect(parsed?.measures?.['v(out)']).toBe(3.3);
    expect(parsed?.traces?.['v(out)'].points).toBe(3);
  });

  it('tolerates fence-wrapped results and rejects non-JSON / running entries', () => {
    expect(
      parseSimResult({ name: 'circuit_simulate', status: 'done', result: '```\n' + TRACES_RESULT + '\n```' }),
    ).not.toBeNull();
    expect(parseSimResult({ name: 'circuit_simulate', status: 'done', result: 'no braces here' })).toBeNull();
    expect(parseSimResult({ name: 'circuit_simulate', status: 'running', result: TRACES_RESULT })).toBeNull();
    expect(parseSimResult({ name: 'circuit_simulate', status: 'done' })).toBeNull();
  });

  it('collects newest-first across messages and skips non-simulate / error tools', () => {
    const older = msgWithSimTool(TRACES_RESULT, 10);
    const newer = msgWithSimTool(
      JSON.stringify({ measures: { 'v(2)': 5 }, traces: { 'v(2)': { x: [0], y: [5], xunit: 's', unit: 'V', points: 1 } } }),
      20,
    );
    const errored: ChatMessage = {
      id: 'm2',
      role: 'assistant',
      content: '',
      timestamp: '2026-08-29T00:00:00Z',
      tools: [{ name: 'circuit_simulate', id: 't2', status: 'error' }],
    } as unknown as ChatMessage;
    const other: ChatMessage = {
      id: 'm3',
      role: 'assistant',
      content: '',
      timestamp: '2026-08-29T00:00:00Z',
      tools: [{ name: 'circuit_test', id: 't3', status: 'done', result: TRACES_RESULT }],
    } as unknown as ChatMessage;

    const sims = collectSimResults([other, newer, errored, older]);
    expect(sims).toHaveLength(2);
    // Newest first: the v(2)=5 run (startedAt 20) leads.
    expect(sims[0].measures?.['v(2)']).toBe(5);
    expect(sims[1].measures?.['v(out)']).toBe(3.3);
  });

  it('meter rows take v()/i() measure keys and sort them', () => {
    const rows = meterRows({
      'i(v1)': 0.001,
      'v(2)': 5,
      gain: 12, // named measure — not a meter row
      'v(out)': 3.3,
    });
    expect(rows.map((r) => r.label)).toEqual(['i(v1)', 'v(2)', 'v(out)']);
    expect(rows[1].value).toBe(5);
  });

  it('bode magnitude prefers a vdb trace, else computes 20·log10 from a v() trace', () => {
    const fromVdb = bodeMag({
      'vdb(out)': { x: [10, 100, 1000], y: [0, -3, -20], xunit: 'Hz', unit: 'dB', points: 3 },
    });
    expect(fromVdb?.label).toBe('vdb(out)');
    expect(fromVdb?.y).toEqual([0, -3, -20]);

    const computed = bodeMag({
      'v(out)': { x: [10, 100], y: [1, 10 ** (-3 / 20)], xunit: 'Hz', unit: 'V', points: 2 },
    });
    expect(computed?.label).toBe('v(out) (dB)');
    expect(computed?.y[0]).toBeCloseTo(0, 5);
    expect(computed?.y[1]).toBeCloseTo(-3, 5);

    expect(bodeMag({ 'i(r1)': { x: [1], y: [1], xunit: 'Hz', unit: 'A', points: 1 } })).toBeNull();
  });
});

/* CircuitWaveformViewer — VCD artifact discovery from block contexts. */
import {
  collectWaveformArtifacts,
  rawFileUrl,
} from '@/components/shell/CircuitWaveformViewer';

describe('CircuitWaveformViewer artifact discovery', () => {
  const vcdMsg = {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: '2026-08-29T00:00:00Z',
    blocks: [
      {
        type: 'toolCall',
        tool: {
          name: 'circuit_export_vcd',
          context: JSON.stringify({ vcdFile: 'C:/ws/digital.vcd', savedTo: 'C:/ws/digital.vcd' }),
          startedAt: 10,
        },
      },
    ],
  } as unknown as ChatMessage;
  const pngMsg = {
    id: 'm2',
    role: 'assistant',
    content: '',
    timestamp: '2026-08-29T00:00:00Z',
    blocks: [
      {
        type: 'toolCall',
        tool: {
          name: 'circuit_render_3d',
          context: JSON.stringify({ path: 'C:/ws/board.png' }),
          startedAt: 20,
        },
      },
    ],
  } as unknown as ChatMessage;
  const newerVcdMsg = {
    id: 'm3',
    role: 'assistant',
    content: '',
    timestamp: '2026-08-29T00:00:00Z',
    blocks: [
      {
        type: 'toolCall',
        tool: {
          name: 'circuit_export_vcd',
          context: JSON.stringify({ vcdFile: 'C:/ws/counter.vcd' }),
          startedAt: 30,
        },
      },
    ],
  } as unknown as ChatMessage;

  it('collects only vcd/fst/ghw circuit artifacts, newest first, deduped', () => {
    const waves = collectWaveformArtifacts([vcdMsg, pngMsg, newerVcdMsg, vcdMsg]);
    expect(waves.map((w) => w.label)).toEqual(['counter.vcd', 'digital.vcd']);
    expect(waves[0].tool).toBe('circuit_export_vcd');
  });

  it('ignores non-JSON contexts and non-circuit tools', () => {
    const noise = {
      id: 'm4',
      role: 'assistant',
      content: '',
      timestamp: '2026-08-29T00:00:00Z',
      blocks: [
        { type: 'toolCall', tool: { name: 'run_command', context: JSON.stringify({ path: 'C:/x/a.vcd' }), startedAt: 5 } },
        { type: 'toolCall', tool: { name: 'circuit_simulate', context: 'not json', startedAt: 6 } },
      ],
    } as unknown as ChatMessage;
    expect(collectWaveformArtifacts([noise])).toHaveLength(0);
  });

  it('builds the absolute /files/raw URL with the resolved base', async () => {
    const { whenReady } = await import('@/api/client');
    // whenReady resolves the backend base (http://127.0.0.1:PORT in Tauri,
    // null same-origin in dev) — rawFileUrl must handle both.
    const url = await rawFileUrl('C:/ws/digital.vcd', 'sess-1');
    expect(url).toContain('/api/workbench/files/raw?');
    expect(url).toContain(encodeURIComponent('C:/ws/digital.vcd'));
    expect(url).toContain('sessionId=sess-1');
    void whenReady;
  });
});
