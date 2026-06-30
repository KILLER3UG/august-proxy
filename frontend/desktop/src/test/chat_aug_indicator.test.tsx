import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('AUG working indicator visibility', () => {
  it('ChatThread renders WorkingIndicator anchored above the composer when streaming', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    // Composer-anchored indicator driven by `streaming`, not `isLast`
    expect(src).toMatch(/streaming\s*&&[^}]{0,60}<WorkingIndicator/);
  });

  it('AUG indicator is decoupled from isLast (no `isLast && streaming` gate)', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    // The old per-message gate should be removed
    expect(src).not.toMatch(/isLast\s*&&\s*streaming\s*&&\s*!showRaw\s*&&\s*\{?\s*<WorkingIndicator/);
  });
});
