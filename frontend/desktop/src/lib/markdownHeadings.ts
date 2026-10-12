/* Heading-level shift for an authored markdown document rendered as CONTENT.
 *
 * Lives in its own module rather than beside the `Markdown` component because
 * react-refresh only keeps a file hot when it exports components — the rule this
 * satisfies by moving, instead of by suppressing it with an inline disable.
 *
 * A drafted skill body, a memory file and a release note are each a whole
 * document that legitimately begins at level 1. Inside the settings dialog they
 * are content under a panel that is itself one of twenty-something sections, so
 * a level-1 heading there is the §4.4 defect the section sweep closed for
 * hand-written JSX, re-introduced through markdown.
 */

/** Fence markers: three or more of one character, and a backtick fence may not
 *  carry a backtick in its info string (CommonMark). */
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^\s{0,3}(`+|~+)\s*$/;

/** A setext h1 underline (`Title` + a line of `=`). Only the `=` form is
 *  touched: its heading level is 1, which is what must not appear in the
 *  dialog. A `-` underline is already level 2, and rewriting those would risk
 *  colliding with thematic breaks (`---`) and list markers for no gain. */
const SETEXT_H1 = /^\s{0,3}=+\s*$/;

/** Blocks whose first line is not a paragraph, so a following `=====` is not a
 *  setext underline for it. */
const NOT_PARAGRAPH = /^\s{0,3}(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|`{3,}|~{3,})/;

/**
 * Shift every heading one level down (`# T` → `## T`), capped at h6, skipping
 * fenced code.
 *
 * The fence tracker keeps the marker CHARACTER and LENGTH, the way CommonMark
 * does: a closing fence must use the same character and be at least as long as
 * the opening one. A single boolean "are we in a fence" got both of these wrong
 * and both directions of failure were reachable — ``` inside a `~~~` block read
 * as a fence end, so a shell comment in code was rewritten to `##`, while a
 * `~~~` inside a ``` block read as a fence start, so a real heading after it was
 * skipped and shipped to the dialog as an h1.
 */
export function demoteMarkdownHeadings(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let fence: { char: '`' | '~'; len: number } | null = null;

  for (const line of lines) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        fence = null;
      }
      out.push(line);
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    if (open) {
      const marker = open[1];
      const char = marker[0] as '`' | '~';
      const info = open[2] ?? '';
      if (!(char === '`' && info.includes('`'))) {
        fence = { char, len: marker.length };
        out.push(line);
        continue;
      }
    }

    // Setext h1: fold the pair into one ATX h2 and drop the underline.
    if (SETEXT_H1.test(line) && out.length > 0) {
      const prev = out[out.length - 1];
      if (prev.trim() && !NOT_PARAGRAPH.test(prev)) {
        out[out.length - 1] = `## ${prev.trim()}`;
        continue;
      }
    }

    out.push(line.replace(/^(\s{0,3})(#{1,5})(?=\s)/, (_all, ws: string, hashes: string) => `${ws}${hashes}#`));
  }

  return out.join('\n');
}
