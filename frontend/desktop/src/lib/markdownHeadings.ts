/* Heading-level shift for an authored document rendered as CONTENT.
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
 * WHY THIS POSTPROCESSES HTML AND DOES NOT REWRITE MARKDOWN
 *
 * The first implementation rewrote the SOURCE text — find the lines that are h1s,
 * prefix another `#` — and that makes this module a second CommonMark
 * implementation, which has to be right about every shape the renderer accepts.
 * Fuzzed against `marked` itself (217,831 generated documents, both directions:
 * an h1 must not survive, a non-heading must come back byte-identical), it
 * disagreed in 12 distinct ways. Each one was a real defect in one of two
 * directions — an h1 that reached the dialog, or text the file does not contain:
 *
 *   * HTML blocks end at their close tag (types 1–5) or at a blank line
 *     (6–7), so a demoter that treated one as "until the next blank line" both
 *     skipped headings after `</pre>` and rewrote raw HTML at a blank line; and
 *     `<a@b.com>`, `<https://x>` and `<div\t>` open no block at all;
 *   * a fence opened inside a blockquote, or inside a list item, is closed by
 *     the container ending — with a too-short closer, or a sibling item;
 *   * a setext underline belongs to a paragraph, so `| a | b` + `===` and
 *     `` `code` `` + `===` fold and ``    code`` + `===` must not;
 *   * tabs make columns, not character counts, the unit of every one of those
 *     rules; and `src.replace(/\r\n?/g, '\n')` rewrote the line endings of every
 *     CRLF document, which is a byte difference on a surface that promises bytes.
 *
 * Underneath all of it is one fact: `marked` is the authority on which lines are
 * headings, and it has already answered by the time this runs. So let it answer,
 * then shift the tags it emitted. Code is escaped (`&lt;h1&gt;` cannot match a
 * tag), which is the same protection the fence tracking used to approximate.
 *
 * Shifting a raw, authored `<h1>` too is deliberate: it renders as a level-1
 * heading, which is the thing that must not appear.
 */

/** `<h1>`–`<h5>` open and close tags, one level down; `<h6>` is the floor.
 *
 *  The lookahead is what keeps `<header>`, `<hr>` and `<h1abc>` out. Case is
 *  ignored because authored raw HTML may be uppercase, and the replacement is
 *  lowercased — HTML element names are case-insensitive, so that changes nothing
 *  the browser renders.
 *
 *  Known limit: an attribute VALUE containing the literal text `<h1 ` (e.g.
 *  `<img alt="<h1 draft">`) would be rewritten inside the attribute. Marked
 *  escapes `&lt;` in text and in code, so this is reachable only through raw
 *  inline HTML with a heading spelled inside a quoted attribute value. */
const HEADING_TAG = /<(\/?)h([1-5])(?=[\s>])/gi;

export function demoteRenderedHeadings(html: string): string {
  return html.replace(HEADING_TAG, (_match, slash: string, level: string) => `<${slash}h${Number(level) + 1}`);
}
