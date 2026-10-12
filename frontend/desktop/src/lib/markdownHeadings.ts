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

/** A fence marker: three or more of one character, tested on the line's
 *  REMAINDER after the block's own indentation is stripped — see the loop for
 *  why the left margin is not the measurement. A backtick fence may not carry a
 *  backtick in its info string, and a closing fence must be the same character
 *  and at least as long as the opener, both per CommonMark.
 *
 *  Indentation is SPACES ONLY, and that is the CommonMark rule rather than a
 *  simplification: a tab advances to the next 4-column tab stop, so `\t# Title`
 *  and a tab-indented ``` are indented CODE, not a heading and not a fence.
 *  Counting a tab as one character of the allowed 0-3 made both look like markup
 *  — a tab-indented Makefile recipe (`\t# comment`) was rewritten to `##`,
 *  corrupting text the dialog then showed differently from the file. */
const FENCE_MARKER = /^(`{3,}|~{3,})(.*)$/;

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

  // Four levels is a ceiling someone would hit by accident, not by writing a
  // document: `> > > > > # T` and a fifth-nested bullet are both a real h1 in
  // marked, and a cap that stops short ships it to the dialog. The loop cannot
  // run away — each iteration consumes at least two characters of the line.
  for (let depth = 0; depth < 12; depth += 1) {
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

/** What kind of block a line opens, for the paragraph run a setext fold may span.
 *
 *  A setext underline belongs to one paragraph, so the fold has to know where the
 *  current paragraph began. "Starts a block" is not one question with one answer:
 *
 *    * a new LIST ITEM is a new block — `- a` / `- b` / `  ===` underlines `b`
 *      only, and marked renders the first item as plain text;
 *    * a `>` line continues the blockquote it is already in — `> one` / `> two` /
 *      `> ===` is ONE h1 reading "one\\ntwo";
 *    * an unmarked, indented line continues the open item — `- Title` / `  more` /
 *      `  ===` underlines the whole paragraph;
 *    * a thematic break, raw HTML, a table row, an ATX heading or a fence is not
 *      paragraph text at all, so nothing may fold across or onto it.
 *
 *  Getting this wrong is worse than the bug it fixes: the first cut folded
 *  `Title` / `> quote` / `===` into `## Title` and DELETED the `===` paragraph,
 *  and `A` / `* * *` / `===` lost two lines, on inputs that have no h1 in marked
 *  and must come back untouched.
 */
function markerSig(line: string): 'quote' | 'item' | 'break' | 'other' | 'plain' {
  // A thematic break may carry spaces between its run characters (`* * *`), and
  // CommonMark allows one to three of leading indentation. Without the spaced
  // form here, `* * *` read as a bullet — which is what `A` / `* * *` / `===`
  // became `A` / `* * ## *`: a heading injected INTO a horizontal rule.
  if (/^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) return 'break';
  if (/^ {0,3}(?:<|\||#|`|~)/.test(line)) return 'other';
  if (/^ {0,3}>/.test(line)) return 'quote';
  if (/^ {0,3}(?:[-*+]\s|\d+[.)]\s)/.test(line)) return 'item';
  return 'plain';
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
  // Where the CURRENT paragraph starts (index into `out`) and what opened it, so
  // a setext underline can only fold back over its own paragraph — see markerSig.
  let paraStart = -1;
  let paraSig: 'quote' | 'item' | 'break' | 'other' | 'plain' | 'none' = 'none';

  for (const line of lines) {
    // Fences are tested on the line's REMAINDER, not its left margin: a fence
    // opened inside a list item sits at the item's content column, which is past
    // the 0-3 an unindented fence may have. Ignoring that read the opening fence
    // as prose, the `# comment` under it as a heading (a code sample rewritten in
    // the dialog), and the CLOSING fence as a new opener — which then swallowed
    // every heading after the block, so `# H` reached the dialog at level 1. Same
    // document, two verdicts, and on CRLF input only one of them happened.
    const probe = FENCE_MARKER.exec(splitBlock(line, stack).rest.replace(/^ {0,3}/, ''));
    if (probe && (!fence || probe[1][0] === fence.char)) {
      const marker = probe[1];
      const char = marker[0] as '`' | '~';
      const info = probe[2] ?? '';
      const closes: boolean = Boolean(
        fence && char === fence.char && marker.length >= fence.len && !info.trim(),
      );
      const opens: boolean = !fence && marker.length >= 3 && !(char === '`' && info.includes('`'));
      if (closes || opens) {
        fence = opens ? { char, len: marker.length } : null;
        out.push(line);
        paraStart = -1;
        continue;
      }
    }

    if (fence) {
      // Inside a fence nothing is markup: the line goes out exactly as it came.
      out.push(line);
      continue;
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
    const sig = markerSig(line);
    if (demoted !== null || sig === 'other' || sig === 'break') {
      // Not paragraph text: a heading, a thematic break, raw HTML, a table row.
      paraStart = -1;
      paraSig = 'none';
    } else if (paraStart === -1) {
      paraStart = out.length - 1;
      paraSig = sig;
    } else if (sig === 'item' || (sig === 'quote' && paraSig !== 'quote')) {
      // A new list item, or a quote that opens where none was open: a fresh
      // paragraph, and the fold may not reach back over it.
      paraStart = out.length - 1;
      paraSig = sig;
    }
    stack = [...stack, ...opened];
  }

  return out.join('\n');
}
