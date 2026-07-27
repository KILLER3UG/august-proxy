/* Model ranking: pinned → free → display name (shared by dropdown + settings). */
import { describe, it, expect } from 'vitest';
import { compareModelsRanked } from '../model-display';

describe('compareModelsRanked', () => {
  it('puts pinned models first, even over free ones', () => {
    const pinned = { id: 'zeta', pinned: true };
    const free = { id: 'alpha', isFree: true };
    expect([free, pinned].sort(compareModelsRanked)[0]).toBe(pinned);
  });

  it('puts free models before paid within the same pin tier', () => {
    const paid = { id: 'aaa-paid' };
    const free = { id: 'zzz-free', isFree: true };
    expect([paid, free].sort(compareModelsRanked)[0]).toBe(free);
  });

  it('falls back to display name order', () => {
    const b = { id: 'provider:beta' };
    const a = { id: 'provider:alpha' };
    expect([b, a].sort(compareModelsRanked).map((m) => m.id)).toEqual([
      'provider:alpha',
      'provider:beta',
    ]);
  });

  it('ranks a full mixed list pinned → free → name', () => {
    const models = [
      { id: 'mid' },
      { id: 'free-one', isFree: true },
      { id: 'pinned-one', pinned: true },
      { id: 'aaa' },
    ];
    expect(models.sort(compareModelsRanked).map((m) => m.id)).toEqual([
      'pinned-one',
      'free-one',
      'aaa',
      'mid',
    ]);
  });
});
