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
 *
 *  The class-list leg alone was not enough, and shipped a regression: `de1d5a8b`
 *  capped the shell wrapper by adding `.august-chat-column` to a stylesheet
 *  selector group instead of a utility class, which the scan could not see. A
 *  cap on that element is not a narrower column — it is a left-anchored `flex-1`
 *  item that stops growing at 58rem, so the whole transcript sits 196px off
 *  centre in a 1600px window (measured) and the remainder is dead space. Both
 *  routes a cap can arrive by are therefore checked here.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const srcRoot = resolve(__dirname, '..');

/** Every selector that a stylesheet rule gives an explicit `max-width`.
 *
 *  Comments are stripped first (one sitting directly above a selector would
 *  otherwise be read as part of it), and preludes containing parentheses are
 *  skipped so an `@media`/`@container` query's own `max-width:` is not mistaken
 *  for a declaration — its nested rules are still walked, as simple rules.
 */
function cappedSelectors(css: string): string[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set<string>();
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selectorText, body] = match;
    if (selectorText.includes('@') || selectorText.includes('(')) continue;
    if (!/\bmax-width\s*:/.test(body)) continue;
    for (const selector of selectorText.split(',')) {
      const name = selector.trim();
      if (name) out.add(name);
    }
  }
  return [...out];
}

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

  it('no stylesheet rule caps the chat column wrapper', () => {
    const css = readFileSync(resolve(__dirname, '../styles/chat.css'), 'utf8');
    const capped = cappedSelectors(css);
    // Reach control: the scan must find the caps that ARE there, or a broken
    // regex would report "nothing is capped" and pass for the wrong reason.
    expect(capped).toContain('.august-message-list');
    expect(capped).toContain('.august-composer-slot');
    expect(capped.filter((s) => s.includes('.august-chat-column'))).toEqual([]);
  });

  it('only the shell wrapper carries the chat-column hook class', () => {
    // The cap and the drawer reservation below it are both keyed on this class,
    // so a second element borrowing it inherits rules meant for the wrapper —
    // which is exactly how the transcript came to be capped. Walked across all
    // of `src`, not a named list: a new borrower is the failure mode here, and
    // a whitelist cannot see one.
    const owners: string[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.tsx')) {
          scanned += 1;
          if (/className=["'`][^"'`]*\baugust-chat-column\b/.test(readFileSync(full, 'utf8'))) {
            owners.push(relative(srcRoot, full).replaceAll('\\', '/'));
          }
        }
      }
    };
    walk(srcRoot);
    expect(scanned, 'the walk found no .tsx files — it is not reaching the tree').toBeGreaterThan(
      100,
    );
    owners.sort();
    expect(owners).toEqual(['components/shell/ChatLayout.tsx']);
  });
});
