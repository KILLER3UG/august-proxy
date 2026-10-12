import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(
  resolve(__dirname, '../sections/settings/HarnessImprovementsSection.tsx'),
  'utf8',
);

describe('a memory decision the backend could not apply', () => {
  it('shows the backend sentence, never the operator string', () => {
    // The panel is the only place this copy is decided for the memory queue, so
    // this reads the shipped markup rather than a copy of the logic: a future edit
    // that drops `userMessage` and goes back to `res.error` would show
    // "apply_retire_decision(7): database is locked (simulated)" in Settings.
    expect(src).toMatch(/res\?\.userMessage\s*\?\?\s*res\?\.error/);
    expect(src).toMatch(/ok\?: boolean/);
    expect(src).toMatch(/userMessage\?: string/);
  });

  it('keeps the failure non-silent', () => {
    // The route answers HTTP 200 + {ok:false}; swallowing that would leave the
    // card looking approved with nothing applied.
    expect(src).toMatch(/if \(!res\?\.ok\) throw new Error\(/);
  });
});
