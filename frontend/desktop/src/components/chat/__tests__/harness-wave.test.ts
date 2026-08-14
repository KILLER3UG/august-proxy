import { describe, expect, it } from 'vitest';
import { resolveActiveWave } from '../harness-wave';

describe('resolveActiveWave', () => {
  it('returns zeros when there are no waves', () => {
    expect(resolveActiveWave([], [])).toEqual({ now: 0, total: 0 });
  });

  it('picks the wave that has a live workstream', () => {
    expect(
      resolveActiveWave(
        [['explore'], ['implement'], ['review']],
        ['implement'],
        'running',
      ),
    ).toEqual({ now: 2, total: 3 });
  });

  it('sits on the last wave when the job completed', () => {
    expect(
      resolveActiveWave([['a'], ['b']], [], 'completed'),
    ).toEqual({ now: 2, total: 2 });
  });
});
