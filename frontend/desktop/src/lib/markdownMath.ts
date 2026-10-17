/* Bare LaTeX to unicode, applied to what the renderer already decided.
 *
 * Models write math two ways: inside delimiters (`$\alpha \to \beta$`), which the
 * KaTeX extensions in `ChatMarkdown` render properly, and bare in prose
 * (`\alpha = 0.05`), which renders as the backslash text unless something converts
 * it. This module converts the second kind.
 *
 * WHY IT RUNS ON HTML AND NOT ON THE SOURCE
 *
 * The first implementation rewrote the markdown SOURCE before `marked` saw it, and
 * to avoid corrupting code it kept its own list of protected regions — ``` fences,
 * inline spans, `$$` and `\(\)` blocks. That list is a second markdown parser, and
 * a smaller one than the renderer: it did not know `~~~` fences, indented code
 * blocks, or HTML comments, so it rewrote inside all three. The measured damage,
 * fuzzed against `marked` itself (8,000 generated documents, 613 failing):
 *
 *   * `-->` became `-→`, so an HTML comment never terminated, the parser's HTML
 *     block ran to end of document, and every heading and paragraph after it was
 *     ESCAPED as source text — `"<!-- note -->\n\n# Real Title"` rendered no title
 *     at all. That is not a math bug; it is a whole-document rendering failure
 *     caused by a pass that only meant to prettify one character pair.
 *   * `>=`, `<=`, `!=` became `≥`, `≤`, `≠` in ordinary prose and in headings, so a
 *     title authored `# Title >= 2` displayed `Title ≥ 2` — text the document does
 *     not contain, on a surface where the user copies it back.
 *   * `x_1` became `x₁` and `x^2` became `x²` in IDENTIFIERS: `use_brain_1`,
 *     `id_2`, a column name. For a coding assistant that is a wrong name, not a
 *     typographic nicety.
 *   * a `~~~` fence and the `data-copy-code` clipboard payload beside it were both
 *     rewritten, so the Copy button handed back text different from the block.
 *
 * Two of those are unrecoverable at the source level in principle: `^`, `_`, `-`,
 * `>` and `!` are ordinary characters in markdown, URLs, diffs and code, and no
 * amount of pattern-list widening on the source can know what `marked` will decide.
 * So the ASCII shorthands and the bare superscript/subscript forms are GONE — inside
 * `$...$` KaTeX already renders them, which was always the better answer.
 *
 * What remains is the backslash command table, which is safe to look for anywhere
 * because a backslash followed by a known command name means one thing. It runs on
 * the rendered HTML now, where `marked` has already said what is code: text outside
 * tags is converted, text inside `<code>` and `<pre>` is left byte-identical, and
 * attributes — including `data-copy-code` — are never touched, because they live
 * inside the tag chunks this skips. Same reasoning that moved the heading shift
 * post-parse (see `markdownHeadings.ts`).
 */

/** Command name followed by a letter is a longer word (`\pitch`), not this command. */
const COMMANDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\\pi(?![a-zA-Z])/g, 'π'],
  [/\\theta(?![a-zA-Z])/g, 'θ'],
  [/\\alpha(?![a-zA-Z])/g, 'α'],
  [/\\beta(?![a-zA-Z])/g, 'β'],
  [/\\gamma(?![a-zA-Z])/g, 'γ'],
  [/\\delta(?![a-zA-Z])/g, 'δ'],
  [/\\epsilon(?![a-zA-Z])/g, 'ε'],
  [/\\lambda(?![a-zA-Z])/g, 'λ'],
  [/\\mu(?![a-zA-Z])/g, 'μ'],
  [/\\sigma(?![a-zA-Z])/g, 'σ'],
  [/\\omega(?![a-zA-Z])/g, 'ω'],
  [/\\sum(?![a-zA-Z])/g, '∑'],
  [/\\prod(?![a-zA-Z])/g, '∏'],
  [/\\int(?![a-zA-Z])/g, '∫'],
  [/\\partial(?![a-zA-Z])/g, '∂'],
  [/\\infty(?![a-zA-Z])/g, '∞'],
  [/\\cdot(?![a-zA-Z])/g, '·'],
  [/\\times(?![a-zA-Z])/g, '×'],
  [/\\div(?![a-zA-Z])/g, '÷'],
  [/\\pm(?![a-zA-Z])/g, '±'],
  [/\\leq(?![a-zA-Z])/g, '≤'],
  [/\\geq(?![a-zA-Z])/g, '≥'],
  [/\\neq(?![a-zA-Z])/g, '≠'],
  [/\\approx(?![a-zA-Z])/g, '≈'],
  [/\\rightarrow(?![a-zA-Z])/g, '→'],
  [/\\to(?![a-zA-Z])/g, '→'],
  [/\\in(?![a-zA-Z])/g, '∈'],
  [/\\notin(?![a-zA-Z])/g, '∉'],
];

/** `\sqrt{...}` → `√(...)`. Braced argument only; `\sqrt 2` stays as written. */
const SQRT = /\\sqrt\s*\{([^{}]+)\}/g;

const TAG = /<[^>]*>/g;
const TAG_NAME = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/;
/** Elements whose text is verbatim: a code sample with `\to` in it is a sample.
 *  `annotation` is here for the same reason and a sharper one — KaTeX puts the
 *  ORIGINAL LaTeX in `<annotation encoding="application/x-tex">`, so rewriting
 *  it destroys the copy-as-LaTeX payload and the MathML semantics a screen
 *  reader or an equation editor reads, while the rendered glyphs beside it stay
 *  correct and nothing looks broken. */
const VERBATIM = new Set(['code', 'pre', 'annotation']);

function convertText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of COMMANDS) out = out.replace(pattern, replacement);
  return out.replace(SQRT, '√($1)');
}

/** Convert bare LaTeX commands in an HTML string, leaving code and attributes alone. */
export function convertMathInHtml(html: string): string {
  if (!html.includes('\\')) return html;
  let out = '';
  let verbatimDepth = 0;
  let cursor = 0;
  for (const match of html.matchAll(TAG)) {
    const tag = match[0];
    const before = html.slice(cursor, match.index);
    out += verbatimDepth > 0 ? before : convertText(before);
    if (tag.endsWith('/>')) {
      // Self-closing: opens nothing, so nothing to count.
      out += tag;
      cursor = (match.index ?? 0) + tag.length;
      continue;
    }
    const name = TAG_NAME.exec(tag);
    if (name && VERBATIM.has(name[2].toLowerCase())) {
      verbatimDepth += name[1] === '/' ? -1 : 1;
      if (verbatimDepth < 0) verbatimDepth = 0;
    }
    out += tag;
    cursor = (match.index ?? 0) + tag.length;
  }
  out += verbatimDepth > 0 ? html.slice(cursor) : convertText(html.slice(cursor));
  return out;
}
