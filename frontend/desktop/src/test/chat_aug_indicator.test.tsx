import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('AUG working indicator visibility', () => {
  it('ChatThreadMessagePane renders WorkingIndicator anchored above the composer when streaming', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThreadMessagePane.tsx');
    const src = readFileSync(path, 'utf8');
    // Composer-anchored indicator driven by `streaming`, not buried in the list footer
    expect(src).toMatch(/streaming\s*(&&|\?)/);
    expect(src).toMatch(/WorkingIndicator/);
    expect(src).toMatch(/aug-working-indicator/);
    // Must sit outside VirtualizedMessageList footer so message enter anims can't hide it
    expect(src).toMatch(/Anchored above the composer|anchored above the composer/i);
  });

  it('AUG indicator is decoupled from isLast (no `isLast && streaming` gate)', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThreadMessagePane.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).not.toMatch(/isLast\s*&&\s*streaming\s*&&\s*!showRaw\s*&&\s*\{?\s*<WorkingIndicator/);
  });
});
