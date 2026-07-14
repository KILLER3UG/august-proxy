import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearStreamPerf,
  enableStreamPerf,
  getStreamPerfSnapshot,
  streamPerfContent,
  streamPerfEnd,
  streamPerfFlush,
  streamPerfStart,
  summarizeStreamPerf,
} from '../stream-perf';

describe('stream-perf (P0.4)', () => {
  beforeEach(() => {
    clearStreamPerf();
    enableStreamPerf(true);
  });

  it('records TTFT on first content after start', () => {
    streamPerfStart('s1');
    streamPerfContent('s1');
    streamPerfContent('s1'); // no-op second
    const snap = getStreamPerfSnapshot();
    const first = snap.find((e) => e.kind === 'first_content');
    expect(first).toBeDefined();
    if (first && first.kind === 'first_content') {
      expect(first.ttftMs).toBeGreaterThanOrEqual(0);
    }
    expect(snap.filter((e) => e.kind === 'first_content')).toHaveLength(1);
  });

  it('records flush duration and end summary', () => {
    streamPerfStart('s2');
    streamPerfContent('s2');
    streamPerfFlush('s2', () => {
      // simulate work
      let x = 0;
      for (let i = 0; i < 1000; i++) x += i;
      return x;
    });
    streamPerfFlush('s2', () => undefined);
    streamPerfEnd('s2');
    const sum = summarizeStreamPerf('s2');
    expect(sum.nFlush).toBe(2);
    expect(sum.ttftMs).not.toBeNull();
    expect(sum.p50FlushMs).not.toBeNull();
    const end = getStreamPerfSnapshot().find((e) => e.kind === 'end');
    expect(end).toBeDefined();
  });

  it('is a no-op when disabled', () => {
    enableStreamPerf(false);
    streamPerfStart('s3');
    streamPerfFlush('s3', () => 1);
    expect(getStreamPerfSnapshot()).toHaveLength(0);
  });
});
