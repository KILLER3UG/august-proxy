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
    // Must sit outside VirtualizedMessageList footer so message enter anims can't
    // hide it. Asserted on the markup, not on the sentence in the comment: the
    // earlier version of this line checked that a comment existed, which dies on a
    // reword and survives deleting the indicator it describes — a gate on a label.
    const slot = /data-testid="aug-working-indicator"/.exec(src);
    expect(slot, 'the indicator slot is gone').not.toBeNull();
    const around = src.slice(Math.max(0, slot!.index - 700), slot!.index + 260);
    // Driven by `streaming` and hidden when it is not.
    expect(around).toMatch(/streaming \?[\s\S]{0,160}aria-hidden=\{!streaming\}/);
    expect(around).toMatch(/data-testid="aug-working-indicator"[\s\S]{0,80}<WorkingIndicator/);
    // Not handed to the virtualized list as its footer.
    expect(src).not.toMatch(/footer=\{[^}]*aug-working-indicator/s);
  });

  it('AUG indicator is decoupled from isLast (no `isLast && streaming` gate)', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThreadMessagePane.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).not.toMatch(/isLast\s*&&\s*streaming\s*&&\s*!showRaw\s*&&\s*\{?\s*<WorkingIndicator/);
  });
});
