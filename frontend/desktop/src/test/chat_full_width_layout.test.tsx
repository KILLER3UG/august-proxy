/** The chat column must stay uncapped, and settings must be an overlay.
 *
 *  This file used to grep `ChatLayout.tsx` for the shapes that made both true,
 *  which had two problems: the scan looked at the 800 characters BEFORE the
 *  `august-chat-column` anchor while the cap it forbids sits AFTER it, in the
 *  same class attribute — so re-adding `max-w-3xl` kept the test green; and the
 *  assertions were strings, so they died on a reformat and survived a behavior
 *  change. What is left here is the one property a source scan can actually
 *  establish (the class list of the element carrying the hook class), and the
 *  route/overlay behaviour moved to `settingsRouteElement.test.tsx`, which
 *  renders the shapes instead of reading the text that describes them.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('ChatLayout full-width chat column', () => {
  const path = resolve(__dirname, '../components/shell/ChatLayout.tsx');
  const src = readFileSync(path, 'utf8');

  it('the chat column element carries no width cap in its own class list', () => {
    // The element is the hook for `--august-drawer-w` (see chat.css), so the
    // guard anchors on the class attribute that names it and reads THE WHOLE
    // attribute — the earlier version sliced the text before the anchor, which
    // is where the cap could never be.
    const m = /className="([^"]*august-chat-column[^"]*)"/.exec(src);
    expect(m, 'no element carries the august-chat-column hook class').not.toBeNull();
    const classes = m![1].split(/\s+/);
    const capped = classes.filter((c) => /^(max-w-|justify-center)/.test(c));
    expect(capped).toEqual([]);
    // The scroll container spans the chat area; the readable max-width is applied
    // inside ChatThread, not on this wrapper.
    expect(classes).toContain('flex-1');
  });
});
