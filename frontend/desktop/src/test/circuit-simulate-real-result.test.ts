/* The Circuit panel parses the tool result AS STORED IN THE TRANSCRIPT, and
 * that copy is capped at MAX_TOOL_RESULT_CHARS. A JSON string cut mid-array does
 * not parse at all, so an over-sized trace set tells the user "No simulation
 * yet" about a run that produced real data — which is exactly what two
 * 2009-point traces did at 117 KB. A hand-written sample cannot catch that, so
 * this fixture is the literal output of `circuit_simulate` on an RC .tran deck,
 * ngspice and all. */

import { describe, expect, it } from 'vitest';
import raw from './circuit-simulate-tran.fixture.json';
import {
  collectSimResults,
  parseSimResult,
} from '@/components/shell/CircuitInstruments';
import type { ChatMessage } from '@/types/chat';

/** `MAX_TOOL_RESULT_CHARS` in backend-py app/services/workbench/loop/surface.py */
const TRANSCRIPT_CAP = 64 * 1024;

const entry = {
  name: 'circuit_simulate',
  status: 'done' as const,
  result: JSON.stringify(raw),
};

describe('a real circuit_simulate result reaches the Instruments panel', () => {
  it('stays inside the transcript cap it is parsed from', () => {
    expect(entry.result.length).toBeLessThan(TRANSCRIPT_CAP);
  });

  it('carries the deck node voltages over time, not only measures', () => {
    const parsed = parseSimResult(entry);
    expect(parsed?.traces).toBeTruthy();
    const traces = parsed!.traces!;
    expect(Object.keys(traces).sort()).toEqual(['v(in)', 'v(out)']);
    for (const trace of Object.values(traces)) {
      expect(trace.x.length).toBeGreaterThan(50);
      expect(trace.x.length).toBe(trace.y.length);
      expect(trace.xunit).toBe('s');
      expect(trace.unit).toBe('V');
      // `points` reports the run's own resolution, not the thinned copy.
      expect(trace.points).toBeGreaterThan(trace.x.length);
    }
  });

  it('is collected from the message-level tool entry the drawer reads', () => {
    const messages = [{ tools: [entry] }] as unknown as ChatMessage[];
    expect(collectSimResults(messages)).toHaveLength(1);
  });
});
