import { useEffect, useMemo, useRef, useState } from 'react';
import { marked, type Tokens } from 'marked';
import katex from 'katex';
import { toast } from 'sonner';
import { highlightCode } from '@/lib/code-highlight';
import { demoteRenderedHeadings } from '@/lib/markdownHeadings';
import { convertMathInHtml } from '@/lib/markdownMath';
import { safeExternalHref } from '@/lib/safe-href';
import { COPY_ICON_SVG } from '@/lib/icons';
import {
  copyFigurePng,
  downloadFigurePng,
  downloadFigureSvg,
  renderSvgFigure,
} from '@/lib/svg-figure';

const COPY_PLACEHOLDER_ATTR = 'data-copy-placeholder';
const COPY_CODE_ATTR = 'data-copy-code';
const COPY_RESET_MS = 1500;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** When true, renderCode skips highlight.js (set only during live stream parses). */
let liveMarkdownParse = false;

/**
 * Raw HTML in model output is untrusted (prompt injection can carry
 * <script>/<iframe>/<img onerror>). marked passes html tokens through
 * verbatim by default; we render them as escaped text instead. Legit
 * markdown (headings, links, tables) is unaffected — only hand-written
 * HTML inside the message body is neutralized.
 */
function renderHtml(token: Tokens.HTML | Tokens.Tag): string {
  return escapeHtml(token.text ?? '');
}

interface LinkRendererThis {
  parser: { parseInline(tokens: Tokens.Link['tokens']): string };
}

/** marked's default link renderer passes `href` straight through, and the
 *  result is applied with dangerouslySetInnerHTML — so a model-authored
 *  `[x](javascript:…)` would run in the webview. */
function renderLink(this: LinkRendererThis, token: Tokens.Link): string {
  const label = this.parser.parseInline(token.tokens);
  const href = safeExternalHref(token.href);
  if (!href) return label;
  const title = token.title ? ` title="${escapeAttr(token.title)}"` : '';
  return `<a href="${escapeAttr(href)}"${title} target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function renderCode(token: Tokens.Code): string {
  const rawLang = (token.lang || '').trim();
  const displayLang = rawLang ? rawLang.split(/\s+/)[0] : 'code';
  // A ```svg fence is a DIAGRAM, not a code sample. It is sanitized by
  // lib/svg-figure before it reaches the DOM; the code renderer's normal
  // highlight path stays for every other language.
  if (displayLang.toLowerCase() === 'svg') {
    if (liveMarkdownParse) {
      return `<div class="markdown-figure markdown-figure--pending">SVG diagram — rendering when the turn settles…</div>`;
    }
    const caption = rawLang.split(/\s+/).slice(1).join(' ');
    const figure = renderSvgFigure(token.text, caption);
    if (figure) return figure;
  }
  const langClass = rawLang ? ` class="hljs language-${escapeAttr(rawLang)}"` : ' class="hljs"';
  const code = escapeAttr(token.text);
  // Skip highlight.js while streaming — full re-highlight every flush was the
  // main cost of live markdown paints; colors apply once the turn settles.
  const highlighted = liveMarkdownParse
    ? escapeHtml(token.text)
    : highlightCode(token.text, rawLang);

  // The code block renderer returns raw HTML (marked), so the copy glyph
  // cannot be a React component. It comes from lib/icons.tsx instead of being
  // hand-copied in here — the glyph is lucide's `Copy`, kept next to the
  // brand marks so every copy affordance in the app renders the same shape
  // and there is one place to regenerate it.
  const copyIconSvg = COPY_ICON_SVG;

  return (
    `<div class="markdown-code-block relative group">` +
      `<div class="markdown-code-header flex items-center justify-between px-3.5 py-1.5 bg-muted/30 border-b border-border/30 text-xs font-mono text-muted-foreground select-none">` +
        `<span class="uppercase tracking-wider text-2xs font-medium opacity-80">${escapeHtml(displayLang)}</span>` +
        `<button type="button" ${COPY_PLACEHOLDER_ATTR} ${COPY_CODE_ATTR}="${code}" ` +
          `class="markdown-copy-btn inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">` +
          `${copyIconSvg}<span class="copy-text">Copy</span>` +
        `</button>` +
      `</div>` +
      `<pre${langClass}><code${langClass}>${highlighted}</code></pre>` +
    `</div>`
  );
}

// ── KaTeX math extension ───────────────────────────────────

/**
 * A cache bounded by CONTENT SIZE rather than by entry count.
 *
 * Both caches below are keyed by markdown source, and markdown source varies
 * by three orders of magnitude: a one-line paragraph is tens of bytes, a
 * pasted file is tens of kilobytes. An entry-count cap therefore bounds
 * nothing that matters — "300 blocks" can be 15 KB or 30 MB depending on what
 * the user pasted — and these caches are module-level in a long-lived desktop
 * process, so the entries outlive the conversation that created them. A
 * session that reads a few large answers walks straight past the old cap and
 * then holds the memory for the rest of the process's life.
 *
 * Budgeting in characters bounds the thing that is actually expensive, and
 * still holds many ordinary answers: the streaming path re-parses only the
 * growing tail, so a cache that forgets a settled block costs one re-parse
 * when that block is next seen, not one per flush.
 *
 * Eviction is oldest-first on insertion order, the same policy the count cap
 * used. A single entry larger than the whole budget is kept rather than
 * dropped mid-render: it is the one currently being painted, and evicting it
 * would only make the next frame re-parse it anyway.
 *
 * Exported for its own unit test. A budget is only worth having if something
 * asserts the budget is actually respected, and a test against a COPY of this
 * class would keep passing after the real one was edited.
 */
export class SizedCache<K, V> {
  private map = new Map<K, V>();
  private total = 0;

  constructor(
    private maxChars: number,
    private sizeOf: (key: K, value: V) => number,
  ) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): V {
    const prior = this.map.get(key);
    if (prior !== undefined) this.total -= this.sizeOf(key, prior);
    this.map.set(key, value);
    this.total += this.sizeOf(key, value);
    while (this.total > this.maxChars && this.map.size > 1) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.map.get(oldest);
      this.map.delete(oldest);
      if (evicted !== undefined) this.total -= this.sizeOf(oldest, evicted);
    }
    return value;
  }

  get size(): number {
    return this.map.size;
  }

  /** Test/diagnostic read — the budget is the thing worth asserting on. */
  get approxChars(): number {
    return this.total;
  }
}

/** The figure menu is plain HTML inside dangerouslySetInnerHTML, so its
 *  actions are delegated from the markdown container. */
function handleSvgFigureAction(figure: HTMLElement, action: string): void {
  const svg = figure.querySelector<SVGSVGElement>('svg.markdown-svg');
  if (!svg) return;
  const title = figure.dataset.svgTitle || 'SVG diagram';
  if (action === 'copy') {
    void copyFigurePng(svg)
      .then(() => toast.success('Diagram copied as a PNG.'))
      .catch(() => toast.error('Copy is blocked here — use Download as PNG instead.'));
    return;
  }
  if (action === 'svg') {
    try {
      downloadFigureSvg(svg, title);
      toast.success('Downloaded the diagram as SVG.');
    } catch {
      toast.error('Could not export the diagram.');
    }
    return;
  }
  if (action === 'png') {
    void downloadFigurePng(svg, title)
      .then(() => toast.success('Downloaded the diagram as PNG.'))
      .catch(() => toast.error('Could not render the diagram.'));
  }
}

const katexCache = new SizedCache<string, string>(160_000, (k, v) => k.length + v.length);

function renderMath(body: string, displayMode: boolean): string {
  const cacheKey = `${displayMode ? 'D' : 'I'}:${body}`;
  const cached = katexCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let html: string;
  try {
    html = katex.renderToString(body, {
      displayMode,
      throwOnError: false,
      output: 'htmlAndMathml',
      strict: false,
    });
  } catch {
    // v1.1: render the raw source in normal body color (not red error).
    // CSS override ensures .katex-error spans are also neutral.
    html = `<span class="math-fallback">${escapeHtml(body)}</span>`;
  }

  katexCache.set(cacheKey, html);
  return html;
}

const mathInlineExtension = {
  name: 'mathInline',
  level: 'inline' as const,
  start(src: string) {
    // Look for \( or $ (but not digit-adjacent $)
    const idx1 = src.indexOf('\\(');
    const idx2 = src.indexOf('$');
    // Skip $ if preceded by a digit (currency guard)
    const candidates: number[] = [];
    if (idx1 !== -1) candidates.push(idx1);
    if (idx2 !== -1) {
      // Only add $ if preceded by non-digit or start of string
      if (idx2 === 0 || !/\d/.test(src[idx2 - 1])) {
        candidates.push(idx2);
      }
    }
    return candidates.length > 0 ? Math.min(...candidates) : -1;
  },
  tokenizer(src: string) {
    // Try \( ... \) first. The capture is the CONTENT only: the shipped
    // pattern (`/^\\(\((.*?)\\\))/`) let the second `\(` open a capture group
    // instead of matching a literal paren, so the body arrived as
    // `(x + y\)` — which KaTeX rejects, silently degrading every \(…\) span to
    // the raw-source fallback. Measured on marked 18.0.5.
    const matchParen = /^\\\((.*?)\\\)/s.exec(src);
    if (matchParen) {
      return {
        type: 'mathInline',
        raw: matchParen[0],
        body: matchParen[1].trim(),
      };
    }
    // Try $ ... $ (inline). The opener may not be followed by whitespace, the
    // closer may not be preceded by whitespace or followed by a digit — the
    // MathJax defaults, adopted because the old `/^\$(.+?)\$/` paired two
    // prices: "I paid $5 and then $10 more." rendered "5 and then" as math,
    // and "It costs $5. The formula is $x + y$." swallowed the real expression
    // into "5. The formula is". Cost of the rule, stated: `$x$2` and `$ x $`
    // no longer render as math (`$x$ 2` does).
    const matchDollar = /^\$(?!\s)([^$]+?)(?<!\s)\$(?!\d)/s.exec(src);
    if (matchDollar) {
      return {
        type: 'mathInline',
        raw: matchDollar[0],
        body: matchDollar[1].trim(),
      };
    }
    return undefined;
  },
  renderer(token: { body: string }) {
    return renderMath(token.body, false);
  },
} as const;

const mathBlockExtension = {
  name: 'mathBlock',
  level: 'block' as const,
  start(src: string) {
    return src.indexOf('$$');
  },
  tokenizer(src: string) {
    // Try $$ ... $$ (display)
    const match = /^\$\$([\s\S]*?)\$\$/s.exec(src);
    if (match) {
      return {
        type: 'mathBlock',
        raw: match[0],
        body: match[1].trim(),
      };
    }
    // Try \[ ... \] (display)
    const matchBracket = /^\\\[([\s\S]*?)\\\]/s.exec(src);
    if (matchBracket) {
      return {
        type: 'mathBlock',
        raw: matchBracket[0],
        body: matchBracket[1].trim(),
      };
    }
    return undefined;
  },
  renderer(token: { body: string }) {
    return renderMath(token.body, true);
  },
} as const;

marked.use({
  gfm: true,
  breaks: true,
  renderer: { code: renderCode, html: renderHtml, link: renderLink },
  extensions: [mathInlineExtension, mathBlockExtension],
});

/**
 * While streaming, the final table row arrives one character at a time and is
 * not yet newline-terminated. marked's GFM parser renders that half-received
 * line as a short/partial row, so the table paints with "cut" borders that
 * only settle once the turn finishes. During a live parse we hold back the
 * trailing incomplete table row (the line reappears next flush once complete),
 * so only fully-received rows are ever painted. Never trims inside an open code
 * fence — a `|` line there is code, not a table.
 */
function stabilizeLiveTables(src: string): string {
  if (src.endsWith('\n')) return src;
  const nlIdx = src.lastIndexOf('\n');
  const lastLine = src.slice(nlIdx + 1);
  // Cheap checks first. Fence parity needs a whole-document scan, and the
  // overwhelming majority of flushes end on an ordinary paragraph or list
  // line where the answer is "not a table row, leave it alone" — so the
  // common case is O(last line) instead of O(document). Two pure predicates
  // in a different order give the same answer; only the cost changed.
  if (!/^\s*\|/.test(lastLine)) return src;
  // Odd number of fences => we're inside an unclosed code block; leave as-is.
  if (((src.match(/```/g) || []).length) % 2 === 1) return src;
  return src.slice(0, nlIdx + 1);
}

/**
 * A.1 cheap live markdown. While streaming, the full LaTeX pass +
 * marked.parse + whole-tree innerHTML replace ran on every ~32ms flush, which
 * is the main text-stutter cost on long answers. Instead, live rendering
 * splits the content at blank-line boundaries (never inside a fenced code
 * block), renders every *complete* block exactly once into a module-level
 * cache, and re-parses only the still-growing tail block each flush. Each
 * block is its own React element keyed by position, so settled blocks are
 * never rewritten — React skips identical __html strings — and only the tail
 * div's innerHTML changes per flush.
 *
 * The settle path (live=false) is untouched: one full parse, byte-identical
 * to the pre-A.1 output, so final rendering (and highlight.js colors) is
 * exactly what the whole-content parse produces.
 */

/**
 * Cached rendered blocks. The cache stores the ready-to-pass
 * ``dangerouslySetInnerHTML`` PROP OBJECT, not just the html string — React
 * bails out of rewriting a block's innerHTML only when it sees the SAME
 * object reference across renders. A fresh ``{__html}`` per render makes
 * React re-parse the block's HTML on every flush (measured ~14x slower in
 * jsdom), which defeats the whole point of the incremental renderer.
 */
const LIVE_BLOCK_HTML_CACHE = new SizedCache<string, { __html: string }>(
  400_000,
  (k, v) => k.length + v.__html.length,
);

/** One `marked` parse, then the math pass on the RESULT. Shared by the cached
 *  live path and the settle/preview path so the two cannot drift on options or
 *  on the math pass. The conversion runs after parsing on purpose — see
 *  `lib/markdownMath.ts` for what rewriting the source did to a document that
 *  contained an HTML comment. */
function parseMarkdownSource(src: string): string {
  return convertMathInHtml(marked.parse(src, { async: false }));
}

function renderLiveBlock(block: string, demote: boolean): { __html: string } {
  // The flag belongs in the cache KEY and not only in the render: the same
  // streamed block is level 1 in chat and one level down in the settings dialog,
  // and a cache that ignored that served one surface's HTML to the other.
  const key = `${demote ? 'd' : 'c'}\u0000${block}`;
  const cached = LIVE_BLOCK_HTML_CACHE.get(key);
  if (cached !== undefined) return cached;
  liveMarkdownParse = true;
  let html: string;
  try {
    html = parseMarkdownSource(block);
  } finally {
    liveMarkdownParse = false;
  }
  return LIVE_BLOCK_HTML_CACHE.set(key, { __html: demote ? demoteRenderedHeadings(html) : html });
}

/**
 * Incremental live-block split (A.1 follow-up).
 *
 * The first cut of this cached the PARSE but still re-derived the BLOCKS from
 * scratch every flush: `split('\n')` over the whole document, three regex
 * tests per line, then a `join` per block. Parsing was O(new text) but
 * splitting was O(document), so a 17KB answer over 120 flushes spent
 * quadratic time scanning text that had not changed since the previous frame
 * — which is the stutter this renderer exists to remove, just moved from
 * marked into the splitter.
 *
 * A stream only ever APPENDS, so the previous input is a prefix of the next
 * one. This keeps the offsets and fence state from the last flush and scans
 * only the bytes that arrived since. The `startsWith` guard is a native
 * memcmp against the previous prefix and is what makes the fast path
 * trustworthy: if the content was rewritten rather than appended (an edit to
 * the turn, a branch switch, a re-render with different text), the guard
 * fails and the scan restarts from zero rather than producing blocks split at
 * offsets that no longer mean anything.
 *
 * The state is per-instance, held in a ref, NOT module-level: sub-agent
 * timelines and the main stream can interleave, and one shared cursor would
 * make two live answers evict each other into a full rescan per frame.
 */
interface LiveSplitState {
  /** Exact string the offsets below refer to. */
  input: string;
  /** Completed blocks, in order. */
  complete: string[];
  /** Offset in `input` up to which whole lines have been consumed. */
  scannedTo: number;
  /** Offset where the still-growing block's text begins. */
  blockStart: number;
  inFence: boolean;
  fenceMarker: string;
}

function emptySplitState(): LiveSplitState {
  return { input: '', complete: [], scannedTo: 0, blockStart: 0, inFence: false, fenceMarker: '' };
}

// Exported for the equivalence test that pins the incremental splitter
// against the straightforward algorithm. A caching rewrite is only allowed to
// be faster if it is also indistinguishable, and that has to be asserted
// somewhere — the renderer has no other way to fail loudly.
// eslint-disable-next-line react-refresh/only-export-components
export function splitLiveBlocksIncremental(
  src: string,
  state: LiveSplitState,
): { complete: string[]; tail: string; state: LiveSplitState } {
  const resuming = src.length >= state.input.length && src.startsWith(state.input);
  if (!resuming) {
    // Not an append (or a different string entirely): start over.
    state = emptySplitState();
  }
  state.input = src;

  // Consume only whole lines from the new region. The trailing partial line
  // is left for the next flush, which is exactly what a "still growing tail"
  // means — and it is why `blockStart` is tracked as an offset rather than
  // rebuilt from an array of lines each time.
  let lineEnd = src.indexOf('\n', state.scannedTo);
  while (lineEnd !== -1) {
    const line = src.slice(state.scannedTo, lineEnd);
    const lineStart = state.scannedTo;
    if (!state.inFence) {
      const fenceMatch = /^\s*(```|~~~)/.exec(line);
      if (fenceMatch) {
        state.inFence = true;
        state.fenceMarker = fenceMatch[1];
      } else if (/^\s*$/.test(line) && lineStart - 1 > state.blockStart) {
        // The guard is `lineStart - 1 > blockStart`, NOT `blockStart < lineStart`:
        // the text of a block that would be committed is
        // src.slice(blockStart, lineStart - 1), and that slice is EMPTY when the
        // document opens with blank lines (blockStart 0, first blank at index 1
        // gives slice(0, 0)). The looser guard commits an empty block there,
        // which renders as a stray empty div — and it also breaks the
        // double-blank case the naive algorithm handles by refusing to commit
        // while `current` is empty.
        // A blank line closes the open block — but ONLY if something follows
        // it. This is the one place the incremental design cannot simply copy
        // the straightforward algorithm, and the reason is worth stating
        // because it reads like an off-by-one and is not.
        //
        // `split('\n')` makes content ending in a newline end with a virtual
        // EMPTY line, so the naive algorithm treats a trailing newline as a
        // block separator: at 'a\n\nb\n' it has already committed 'b'. One
        // flush later, at 'a\n\nb\nc', that same block has no blank line after
        // it any more and falls BACK into the tail. The naive algorithm
        // un-commits a block as the stream grows. An incremental splitter
        // cannot: `complete` only grows, and pretending otherwise is how a
        // paragraph ends up rendered as two separate divs mid-stream.
        //
        // So: commit only on a blank line that has content after it, and
        // leave a trailing blank line unconsumed so the next flush re-decides
        // it. The last block therefore stays in the tail and is re-parsed
        // each frame — one block, which is exactly what the pre-incremental
        // code already paid for its tail.
        if (lineEnd + 1 >= src.length) {
          state.scannedTo = lineStart;
          lineEnd = -1;
          break;
        }
        // The block's text ends at the newline BEFORE the blank line, so the
        // slice stops one short of lineStart; otherwise every committed block
        // would carry a trailing '\n' the naive algorithm never includes.
        state.complete.push(src.slice(state.blockStart, lineStart - 1));
        state.blockStart = lineEnd + 1;
        state.scannedTo = lineEnd + 1;
        lineEnd = src.indexOf('\n', state.scannedTo);
        continue;
      }
    } else {
      const closeRe = state.fenceMarker === '```' ? /^\s*`{3,}/ : /^\s*~{3,}/;
      if (closeRe.test(line)) state.inFence = false;
    }
    state.scannedTo = lineEnd + 1;
    lineEnd = src.indexOf('\n', state.scannedTo);
  }

  return {
    complete: state.complete,
    tail: src.slice(state.blockStart),
    state,
  };
}

export function Markdown({
  content,
  variant = 'default',
  live = false,
  demoteHeadings = false,
}: {
  content: string;
  /** Assistant body may use a quieter serif; code/pre stay monospace via CSS. */
  variant?: 'default' | 'assistant';
  /** When true (active stream), skip highlight.js so code DOM isn't rewritten every flush. */
  live?: boolean;
  /** Render an authored document as CONTENT inside a container (the settings
   *  dialog) whose section headings are all h2, so a level-1 heading in the
   *  body would be the only h1 in that subtree. Shifts the RENDERED headings
   *  down a level, after `marked` has decided what they are; see
   *  `@/lib/markdownHeadings` for why that is the only place the decision can
   *  live. */
  demoteHeadings?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const prevLive = useRef(live);
  // Per-instance incremental split cursor (see splitLiveBlocksIncremental).
  // A ref, not module state: two live answers must not share one cursor.
  const splitState = useRef<LiveSplitState>(emptySplitState());
  const [justSettled, setJustSettled] = useState(false);

  useEffect(() => {
    if (prevLive.current && !live) {
      setJustSettled(true);
      const id = window.setTimeout(() => setJustSettled(false), 180);
      prevLive.current = live;
      return () => window.clearTimeout(id);
    }
    prevLive.current = live;
  }, [live]);

  const html = useMemo(() => {
    if (!content) return '';
    if (live) {
      // A.1: incremental live render. Complete blocks are cached; only the
      // still-growing tail block re-parses each flush (see renderLiveBlock),
      // and only the bytes that arrived since the last flush are re-scanned
      // for block boundaries (see splitLiveBlocksIncremental). The settle
      // pass (live=false) below produces the exact full parse.
      const stabilized = stabilizeLiveTables(content);
      const { complete, tail, state } = splitLiveBlocksIncremental(stabilized, splitState.current);
      splitState.current = state;
      const parts: { __html: string }[] = complete.map((block) => renderLiveBlock(block, demoteHeadings));
      if (tail) parts.push(renderLiveBlock(tail, demoteHeadings));
      return parts;
    }
    // During a live stream, hold back an incomplete trailing table row so the
    // table never paints half-formed rows with cut borders.
    const parsed = parseMarkdownSource(content);
    // Shifted AFTER the parse, so `marked` is the only thing that ever decided
    // which lines are headings — see `@/lib/markdownHeadings`.
    return demoteHeadings ? demoteRenderedHeadings(parsed) : parsed;
  }, [content, live, demoteHeadings]);

  const liveBlocks = live && typeof html !== 'string' ? (html as { __html: string }[]) : null;

  // Copy button handler
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function handleClick(e: MouseEvent) {
      const figureAction = (e.target as HTMLElement).closest<HTMLElement>('[data-svg-action]');
      if (figureAction) {
        e.preventDefault();
        const figure = figureAction.closest<HTMLElement>('[data-svg-figure]');
        const details = figureAction.closest('details');
        if (details) details.open = false;
        if (figure) handleSvgFigureAction(figure, figureAction.dataset.svgAction || '');
        return;
      }
      const btn = (e.target as HTMLElement).closest<HTMLElement>(`[${COPY_CODE_ATTR}]`);
      if (!btn) return;
      const code = btn.getAttribute(COPY_CODE_ATTR);
      if (!code) return;
      navigator.clipboard.writeText(code).catch(() => {});
      const label = btn.querySelector('.copy-text');
      if (label) {
        label.textContent = 'Copied!';
        setTimeout(() => { label.textContent = 'Copy'; }, COPY_RESET_MS);
      } else {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, COPY_RESET_MS);
      }
    }

    function closeFigureMenus(event: MouseEvent) {
      document.querySelectorAll<HTMLDetailsElement>('details.markdown-figure-menu[open]').forEach((details) => {
        if (!details.contains(event.target as Node)) details.open = false;
      });
    }

    function closeFigureMenusOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      document.querySelectorAll<HTMLDetailsElement>('details.markdown-figure-menu[open]').forEach((details) => {
        details.open = false;
      });
    }

    el.addEventListener('click', handleClick);
    document.addEventListener('click', closeFigureMenus);
    document.addEventListener('keydown', closeFigureMenusOnEscape);
    return () => {
      el.removeEventListener('click', handleClick);
      document.removeEventListener('click', closeFigureMenus);
      document.removeEventListener('keydown', closeFigureMenusOnEscape);
    };
  }, []);

  // Syntax colors are applied in renderCode (highlight.js). During live
  // streams we skip highlight so each flush only escapes HTML.

  return (
    <div
      ref={ref}
      className={
        (variant === 'assistant'
          ? 'markdown-content markdown-content--assistant assistant-copy'
          : 'markdown-content') + (justSettled ? ' markdown-content--settle' : '')
      }
      {...(liveBlocks ? {} : { dangerouslySetInnerHTML: { __html: html as string } })}
    >
      {liveBlocks &&
        liveBlocks.map((blockProp, i) =>
          blockProp.__html ? (
            <div
              key={i}
              className={i === liveBlocks.length - 1 ? 'md-live-tail' : undefined}
              dangerouslySetInnerHTML={blockProp}
            />
          ) : null,
        )}
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function renderMarkdown(content: string): string {
  if (!content) return '';
  return parseMarkdownSource(content);
}
