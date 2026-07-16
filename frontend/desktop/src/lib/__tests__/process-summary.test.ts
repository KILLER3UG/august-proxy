import { describe, expect, it } from 'vitest';
import { buildProcessSummaryLine } from '../process-summary';

describe('buildProcessSummaryLine', () => {
  it('returns a short first-sentence gist from thinking', () => {
    const line = buildProcessSummaryLine([
      'I am weighing mixed performance metrics and questioning module effectiveness. Then more detail follows here.',
    ]);
    expect(line).toMatch(/weighing mixed performance metrics/i);
    expect(line!.length).toBeLessThan(160);
  });

  it('returns null for empty or tiny thinking', () => {
    expect(buildProcessSummaryLine([])).toBeNull();
    expect(buildProcessSummaryLine(['ok'])).toBeNull();
  });

  it('strips code fences and markdown noise', () => {
    const line = buildProcessSummaryLine([
      '```ts\nconst x = 1\n``` Looking up the antirez MTP flash notes next.',
    ]);
    expect(line).toMatch(/Looking up the antirez/i);
    expect(line).not.toMatch(/const x/);
  });
});
