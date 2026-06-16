/* ── tool-progress.test.ts ─ unit tests for the pure reducer ──────── */

import { describe, it, expect } from 'vitest';
import {
  applyToolProgress,
  visibleProgress,
  MAX_VISIBLE_PROGRESS,
  type ToolProgressEvent,
  type ToolProgressMap,
} from '../tool-progress';

function ev(id: string, phase: string, extra: Partial<ToolProgressEvent> = {}): ToolProgressEvent {
  return { id, phase: phase as ToolProgressEvent['phase'], ...extra };
}

describe('applyToolProgress — empty / unknown phases', () => {
  it('returns prev unchanged for missing id', () => {
    const prev = new Map() as ToolProgressMap;
    expect(applyToolProgress(prev, { id: '', phase: 'reading' })).toBe(prev);
  });

  it('returns prev for unknown / future phases', () => {
    const prev = new Map() as ToolProgressMap;
    // @ts-expect-error — intentionally passing an unsupported phase
    expect(applyToolProgress(prev, { id: 't1', phase: 'cancelled' })).toBe(prev);
  });

  it('handles reading with no paths array as a no-op', () => {
    const prev = new Map() as ToolProgressMap;
    expect(applyToolProgress(prev, ev('t1', 'reading'))).toBe(prev);
  });

  it('handles read with no path as a no-op', () => {
    const prev = new Map() as ToolProgressMap;
    expect(applyToolProgress(prev, ev('t1', 'read'))).toBe(prev);
  });

  it('handles reading with empty paths as a no-op', () => {
    const prev = new Map() as ToolProgressMap;
    expect(applyToolProgress(prev, ev('t1', 'reading', { paths: [] }))).toBe(prev);
  });
});

describe('applyToolProgress — reading phase', () => {
  it('adds new paths in arrival order', () => {
    const next1 = applyToolProgress(new Map(), ev('t1', 'reading', { paths: ['a.ts', 'b.ts'] }));
    expect(next1.get('t1')?.map(e => e.path)).toEqual(['a.ts', 'b.ts']);
    expect(next1.get('t1')?.every(e => e.status === 'reading')).toBe(true);
  });

  it('appends new paths to an existing list, preserving order', () => {
    let m = applyToolProgress(new Map(), ev('t1', 'reading', { paths: ['a.ts'] }));
    m = applyToolProgress(m, ev('t1', 'reading', { paths: ['b.ts', 'c.ts'] }));
    expect(m.get('t1')?.map(e => e.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('dedupes paths that arrive twice', () => {
    let m = applyToolProgress(new Map(), ev('t1', 'reading', { paths: ['a.ts', 'b.ts'] }));
    m = applyToolProgress(m, ev('t1', 'reading', { paths: ['a.ts', 'c.ts'] }));
    expect(m.get('t1')?.map(e => e.path)).toEqual(['b.ts', 'a.ts', 'c.ts']);
  });
});

describe('applyToolProgress — read phase', () => {
  it('marks an in-flight path as read', () => {
    let m = applyToolProgress(new Map(), ev('t1', 'reading', { paths: ['a.ts', 'b.ts'] }));
    m = applyToolProgress(m, ev('t1', 'read', { path: 'a.ts' }));
    const e = m.get('t1');
    expect(e?.find(x => x.path === 'a.ts')?.status).toBe('read');
    expect(e?.find(x => x.path === 'b.ts')?.status).toBe('reading');
  });

  it('preserves arrival order when marking read', () => {
    let m = applyToolProgress(new Map(), ev('t1', 'reading', { paths: ['a.ts', 'b.ts', 'c.ts'] }));
    m = applyToolProgress(m, ev('t1', 'read', { path: 'b.ts' }));
    expect(m.get('t1')?.map(e => `${e.path}:${e.status[0]}`)).toEqual(['a.ts:r', 'b.ts:r', 'c.ts:r']);
  });

  it('creates an entry when read arrives without a prior reading (defensive)', () => {
    const m = applyToolProgress(new Map(), ev('t1', 'read', { path: 'a.ts' }));
    expect(m.get('t1')?.map(e => `${e.path}:${e.status}`)).toEqual(['a.ts:read']);
  });

  it('does not downgrade read back to reading if a duplicate reading event arrives', () => {
    let m = applyToolProgress(new Map(), ev('t1', 'reading', { paths: ['a.ts'] }));
    m = applyToolProgress(m, ev('t1', 'read', { path: 'a.ts' }));
    m = applyToolProgress(m, ev('t1', 'reading', { paths: ['a.ts'] })); // weird but defensive
    expect(m.get('t1')?.find(x => x.path === 'a.ts')?.status).toBe('read');
  });
});

describe('applyToolProgress — done / error', () => {
  it('removes the entry on done', () => {
    let m = applyToolProgress(new Map(), ev('t1', 'reading', { paths: ['a.ts'] }));
    m = applyToolProgress(m, ev('t1', 'read', { path: 'a.ts' }));
    expect(m.has('t1')).toBe(true);
    m = applyToolProgress(m, ev('t1', 'done'));
    expect(m.has('t1')).toBe(false);
  });

  it('removes the entry on error', () => {
    let m = applyToolProgress(new Map(), ev('t1', 'reading', { paths: ['a.ts'] }));
    m = applyToolProgress(m, ev('t1', 'error'));
    expect(m.has('t1')).toBe(false);
  });

  it('returns prev unchanged if done is fired for an unknown tool id', () => {
    const prev = new Map() as ToolProgressMap;
    expect(applyToolProgress(prev, ev('unknown', 'done'))).toBe(prev);
  });
});

describe('applyToolProgress — multiple tools in parallel', () => {
  it('keeps per-tool state independent', () => {
    let m = applyToolProgress(new Map(), ev('t1', 'reading', { paths: ['a.ts'] }));
    m = applyToolProgress(m, ev('t2', 'reading', { paths: ['b.ts', 'c.ts'] }));
    m = applyToolProgress(m, ev('t1', 'read', { path: 'a.ts' }));
    expect(m.get('t1')?.map(e => `${e.path}:${e.status[0]}`)).toEqual(['a.ts:r']);
    expect(m.get('t2')?.map(e => `${e.path}:${e.status[0]}`)).toEqual(['b.ts:r', 'c.ts:r']);
    m = applyToolProgress(m, ev('t2', 'done'));
    expect(m.has('t1')).toBe(true);
    expect(m.has('t2')).toBe(false);
  });
});

describe('applyToolProgress — pure / immutability', () => {
  it('does not mutate the input map or its entries', () => {
    const prev: ToolProgressMap = new Map([
      ['t1', [{ path: 'a.ts', status: 'reading' }]],
    ]);
    const snapshot = new Map(prev);
    const snapshotEntries = [...(prev.get('t1') || [])];
    const next = applyToolProgress(prev, ev('t1', 'read', { path: 'a.ts' }));
    expect(prev).toEqual(snapshot);
    expect(prev.get('t1')).toEqual(snapshotEntries);
    expect(next).not.toBe(prev);
  });
});

describe('applyToolProgress — running phase (no-op)', () => {
  it('does not add or modify entries', () => {
    const m0 = new Map() as ToolProgressMap;
    const m1 = applyToolProgress(m0, ev('t1', 'running'));
    expect(m1.has('t1')).toBe(false);
    let m2 = applyToolProgress(new Map(), ev('t1', 'reading', { paths: ['a.ts'] }));
    const m2Before = m2.get('t1');
    m2 = applyToolProgress(m2, ev('t1', 'running'));
    expect(m2.get('t1')).toEqual(m2Before);
  });
});

describe('visibleProgress', () => {
  it('returns empty for undefined / empty', () => {
    expect(visibleProgress(undefined)).toEqual([]);
    expect(visibleProgress([])).toEqual([]);
  });

  it('returns the full list when under the cap', () => {
    const entries = [
      { path: 'a.ts', status: 'reading' as const },
      { path: 'b.ts', status: 'read' as const },
    ];
    expect(visibleProgress(entries)).toEqual(entries);
  });

  it('truncates to the last N entries when over the cap', () => {
    const entries = Array.from({ length: MAX_VISIBLE_PROGRESS + 4 }, (_, i) => ({
      path: `${String.fromCharCode(97 + i)}.ts`,
      status: 'reading' as const,
    }));
    const visible = visibleProgress(entries);
    expect(visible.length).toBe(MAX_VISIBLE_PROGRESS);
    expect(visible[0].path).toBe(`${String.fromCharCode(97 + 4)}.ts`);
    expect(visible[visible.length - 1].path).toBe(`${String.fromCharCode(97 + MAX_VISIBLE_PROGRESS + 3)}.ts`);
  });
});
