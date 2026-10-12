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
 *
 * Every rule here was checked against `marked` — the renderer the dialog uses —
 * not against a recollection of CommonMark. The shapes and their measured output
 * are pinned in `sections/chat/__tests__/ChatMarkdown.test.tsx`.
 */

/** Fence markers: three or more of one character, and a backtick fence may not
 *  carry a backtick in its info string (CommonMark).
 *
 *  The indent is SPACES ONLY, and that is the CommonMark rule rather than a
 *  simplification: a tab advances to the next 4-column tab stop, so `\t# Title`
 *  and a tab-indented ``` are indented CODE, not a heading and not a fence.
 *  Counting a tab as one character of the allowed 0-3 made both look like markup
 *  — a tab-indented Makefile recipe (`\t# comment`) was rewritten to `##`,
 *  corrupting text the dialog then showed differently from the file. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`+|~+)\s*$/;

/** A setext h1 underline (`Title` + a line of `=`). Only `=` is touched: that
 *  form is level 1, which is what must not appear in the dialog. A `-` underline
 *  is already level 2, and rewriting it would collide with thematic breaks
 *  (`---`). Tested on the line's REMAINDER, after its block indent is stripped,
 *  which is what lets a nested item's `    =====` count. */
const SETEXT_H1 = /^ {0,3}=+\s*$/;

/** A list bullet or ordered marker — the only markers that open a CONTENT
 *  COLUMN. A blockquote does not: `> a` above an indented `    # T` is a
 *  paragraph in `marked`, so treating a quote as owning a column would promote
 *  indented code into a heading and rewrite it. */
const LIST_MARKER = /^ {0,3}(?:[-*+][ \t]+|\d+[.)][ \t]+)/;

/** One block marker that can own the line a heading sits on.
 *
 *  `> # T`, `># T` and `>\t# T` are all a quoted h1 in marked, while `> \t# T`
 *  (> + space + TAB) is indented CODE — the tab advances to the next 4-column
 *  stop and lands past the three that a heading may have. So the quote takes at
 *  most ONE separator character: widening it to `[ \t]*` swallowed the space AND
 *  the tab and rewrote a code sample. List markers take a run, because a list's
 *  content column is measured past the run (`-   item` starts at column 4). */
const OWNING_MARKER = /^ {0,3}(?:>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/;

/** The heading itself, once the owning markers are gone: 1-6 `#` then a space, a
 *  tab, or nothing. `#hashtag` is a paragraph and `#######` is out of range, so
 *  neither may be touched. */
const ATX_HEADING = /^(#{1,6})([ \t]|$)/;

/** Leading SPACES of a line — never a tab; see `FENCE_OPEN`. */
function indentOf(line: string): number {
  return /^ */.exec(line)![0].length;
}

/** Where a line's block structure ends and its content begins.
 *
 *  `- # Title`, `> # Title`, `1. # Title`, `> - # Title` and the continuation
 *  form (`- a` above an indented `    # Title`) all render a real `<h1>` INSIDE
 *  the block, because a list item strips its content column before parsing what
 *  is left. Testing only the bare line missed every one of them and the dialog
 *  kept the level 1.
 *
 *  `stack` holds the content columns of the open list items, outermost last-
 *  nearest. A continuation line owns no marker, so it is stripped by column count
 *  — that is what makes `    # T` under `- a` a heading instead of code. A
 *  blockquote owns no column: `> a` above an indented `    # T` is a paragraph in
 *  `marked`, so giving quotes a content column would promote indented code into
 *  a heading and rewrite it.
 */
function splitBlock(
  line: string,
  stack: number[],
): { prefix: string; rest: string; opened: number[] } {
  let at = 0;
  let prefix = '';
  const opened: number[] = [];

  const col = stack[stack.length - 1];
  if (col !== undefined && col > 0 && indentOf(line) >= col) {
    prefix = line.slice(0, col);
    at = col;
  }

  for (let depth = 0; depth < 4; depth += 1) {
    const tail = line.slice(at);
    const m = OWNING_MARKER.exec(tail);
    if (!m) break;
    // A marker separates itself from its content with spaces or a tab, and the
    // content column is the whole run (`-   item` starts at column 4). ONLY a
    // list marker opens one: a blockquote has no content column, so an indented
    // line under `> a` stays the indented code `marked` says it is.
    const pad = /^ +/.exec(tail.slice(m[0].length))?.[0].length ?? 0;
    prefix += m[0] + ' '.repeat(pad);
    at += m[0].length + pad;
    if (LIST_MARKER.test(tail)) opened.push(at);
  }

  return { prefix, rest: line.slice(at), opened };
}

/** Demote one line's ATX heading, whatever block owns it. Null means "not a
 *  heading line", and the caller passes the line through untouched. */
function demoteAtx(rest: string): string | null {
  const indent = /^ {0,3}/.exec(rest)?.[0] ?? '';
  const body = rest.slice(indent.length);
  const heading = ATX_HEADING.exec(body);
  if (!heading) return null;
  const hashes = heading[1];
  if (hashes.length >= 6) return null; // h6 is the bottom of the range
  return `${indent}${hashes}#${body.slice(hashes.length)}`;
}

/**
 * Shift every heading one level down (`# T` → `## T`), capped at h6, skipping
 * fenced code.
 *
 * The fence tracker keeps the marker CHARACTER and LENGTH, the way CommonMark
 * does: a closing fence must use the same character and be at least as long as
 * the opening one. A single boolean "are we in a fence" got both wrong and both
 * failure directions were reachable — ``` inside a `~~~` block read as a fence
 * end, so a shell comment in code was rewritten to `##`, while a `~~~` inside a
 * ``` block read as a fence start, so the real heading after it was skipped and
 * shipped to the dialog as an h1.
 */
export function demoteMarkdownHeadings(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let fence: { char: '`' | '~'; len: number } | null = null;
  // Content columns of the list items open as of the previous line. A blank line
  // does not close them (`- a`, blank, `    # T` is still an h1 in that item),
  // but it does close a setext paragraph — which is `paraStart`.
  let stack: number[] = [];
  let paraStart = -1;

  for (const line of lines) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        fence = null;
      }
      out.push(line);
      paraStart = -1;
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
        paraStart = -1;
        continue;
      }
    }

    if (!line.trim()) {
      // A blank line closes a setext PARAGRAPH (`- a`, blank, `  ===` is two
      // paragraphs in marked) but NOT a list item: `- a`, blank, `    # T` is
      // still an h1 inside that item. So the dedent pop happens after this
      // branch, not before — a blank line's zero indent would otherwise close
      // every open item and the heading below would read as top-level code.
      out.push(line);
      paraStart = -1;
      continue;
    }
    const indent = indentOf(line);
    while (stack.length && indent < stack[stack.length - 1]) stack.pop();

    const { prefix, rest, opened } = splitBlock(line, stack);
    const restIndent = /^ {0,3}/.exec(rest)?.[0] ?? '';
    const content = rest.slice(restIndent.length);
    // Where this line's own paragraph began, for the setext fold below.
    const para = paraStart === -1 ? out.length : paraStart;

    if (SETEXT_H1.test(rest) && para < out.length) {
      // The underline belongs to the whole paragraph above it: `one` / `two` /
      // `===` is ONE h1 reading "onetwo", so folding only the line nearest the
      // underline left the earlier lines as a stray paragraph and moved text
      // across a block boundary.
      //
      // The underline must also sit in the SAME block as what it underlines.
      // `Title` + `> ===` is a paragraph and a blockquote, and `> Title` + a bare
      // `===` is lazy continuation text — neither is a heading in marked, and the
      // `>` on both lines is what kept that distinction.
      const head = out[para];
      const quoted = (s: string) => /^ {0,3}>/.test(s);
      const headSplit = splitBlock(head, stack);
      const headIndent = /^ {0,3}/.exec(headSplit.rest)?.[0] ?? '';
      const headText = headSplit.rest.slice(headIndent.length);
      if (headText.trim() && !/^[#`~]/.test(headText) && quoted(head) === quoted(line)) {
        out[para] = `${headSplit.prefix}${headIndent}## ${headText.trim()}`;
        paraStart = -1;
        continue; // the underline is consumed by the fold
      }
    }

    const demoted = demoteAtx(rest);
    out.push(demoted === null ? line : `${prefix}${demoted}`);
    // A paragraph is a run of plain lines; a heading, a fence-ish line or a blank
    // ends it, and an h1 can only sit under a plain run.
    paraStart = demoted === null && !/^[#`~]/.test(content) ? para : -1;
    stack = [...stack, ...opened].slice(-4);
  }

  return out.join('\n');
}
