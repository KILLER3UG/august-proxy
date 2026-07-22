import { useEffect, useMemo, useRef } from 'react';
import { marked, type Tokens } from 'marked';
import katex from 'katex';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import jsonLang from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';
import yaml from 'highlight.js/lib/languages/yaml';
import plaintext from 'highlight.js/lib/languages/plaintext';
import 'highlight.js/styles/vs2015.css';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('json', jsonLang);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sh', shell);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', cpp);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('text', plaintext);
hljs.registerLanguage('plaintext', plaintext);

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

function highlightCode(text: string, lang: string): string {
  const normalized = lang.toLowerCase().replace(/^language-/, '');
  try {
    if (normalized && hljs.getLanguage(normalized)) {
      return hljs.highlight(text, { language: normalized, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(text).value;
  } catch {
    return escapeHtml(text);
  }
}

/** When true, renderCode skips highlight.js (set only during live stream parses). */
let liveMarkdownParse = false;

function renderCode(token: Tokens.Code): string {
  const lang = (token.lang || '').trim();
  const langClass = lang ? ` class="hljs language-${escapeAttr(lang)}"` : ' class="hljs"';
  const code = escapeAttr(token.text);
  // Skip highlight.js while streaming — full re-highlight every flush was the
  // main cost of live markdown paints; colors apply once the turn settles.
  const highlighted = liveMarkdownParse
    ? escapeHtml(token.text)
    : highlightCode(token.text, lang);
  return (
    `<div class="markdown-code-block relative group">` +
      `<pre${langClass}><code${langClass}>${highlighted}</code></pre>` +
      `<button type="button" ${COPY_PLACEHOLDER_ATTR} ${COPY_CODE_ATTR}="${code}" ` +
        `class="markdown-copy-btn absolute right-2 top-2 inline-flex items-center gap-1 rounded-md ` +
        `border border-border/60 bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground ` +
        `opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100" ` +
        `style="z-index:10">` +
        `Copy` +
      `</button>` +
    `</div>`
  );
}

// ── KaTeX math extension (v4 §16.1) ───────────────────────────────────

function renderMath(body: string, displayMode: boolean): string {
  try {
    return katex.renderToString(body, {
      displayMode,
      throwOnError: false,
      output: 'htmlAndMathml',
      strict: false,
    });
  } catch {
    // v1.1: render the raw source in normal body color (not red error).
    // CSS override ensures .katex-error spans are also neutral.
    return `<span class="math-fallback">${body}</span>`;
  }
}

/**
 * v1.1: Convert common LaTeX-style math to unicode math symbols.
 * Skips content inside code blocks (fenced or inline) and inside
 * already-rendered KaTeX blocks. Best-effort: matches simple patterns only.
 */
function convertLatexToUnicode(input: string): string {
  // Split on code blocks and inline code so we never touch them.
  // Use a placeholder strategy: replace protected regions with
  // unique tokens, convert, then restore. Use hyphens (not underscores)
  // in the placeholder name so the subscript regex doesn't touch it.
  const placeholders: string[] = [];
  const stash = (text: string): string => {
    const idx = placeholders.length;
    placeholders.push(text);
    return `\u0000MATH-PROTECTED-${idx}\u0000`;
  };

  // 1) Protect fenced code blocks ```...```
  let s = input.replace(/```[\s\S]*?```/g, (m) => stash(m));
  // 2) Protect inline code `...`
  s = s.replace(/`[^`\n]+`/g, (m) => stash(m));
  // 3) Protect KaTeX-rendered blocks (already wrapped in \(...\) or \[...\])
  s = s.replace(/\\\([\s\S]*?\\\)/g, (m) => stash(m));
  s = s.replace(/\\\[[\s\S]*?\\\]/g, (m) => stash(m));
  s = s.replace(/\$\$[\s\S]*?\$\$/g, (m) => stash(m));

  // 4) Common LaTeX → unicode conversions
  // Greek letters (use negative lookahead to allow _ for subscripts)
  s = s.replace(/\\pi(?![a-zA-Z])/g, 'π');
  s = s.replace(/\\theta(?![a-zA-Z])/g, 'θ');
  s = s.replace(/\\alpha(?![a-zA-Z])/g, 'α');
  s = s.replace(/\\beta(?![a-zA-Z])/g, 'β');
  s = s.replace(/\\gamma(?![a-zA-Z])/g, 'γ');
  s = s.replace(/\\delta(?![a-zA-Z])/g, 'δ');
  s = s.replace(/\\epsilon(?![a-zA-Z])/g, 'ε');
  s = s.replace(/\\lambda(?![a-zA-Z])/g, 'λ');
  s = s.replace(/\\mu(?![a-zA-Z])/g, 'μ');
  s = s.replace(/\\sigma(?![a-zA-Z])/g, 'σ');
  s = s.replace(/\\omega(?![a-zA-Z])/g, 'ω');

  // Operators (same lookahead pattern)
  s = s.replace(/\\sum(?![a-zA-Z])/g, '∑');
  s = s.replace(/\\prod(?![a-zA-Z])/g, '∏');
  s = s.replace(/\\int(?![a-zA-Z])/g, '∫');
  s = s.replace(/\\partial(?![a-zA-Z])/g, '∂');
  s = s.replace(/\\infty(?![a-zA-Z])/g, '∞');
  s = s.replace(/\\sqrt\s*\{([^}]+)\}/g, '√($1)');
  s = s.replace(/\\cdot(?![a-zA-Z])/g, '·');
  s = s.replace(/\\times(?![a-zA-Z])/g, '×');
  s = s.replace(/\\div(?![a-zA-Z])/g, '÷');
  s = s.replace(/\\pm(?![a-zA-Z])/g, '±');
  s = s.replace(/\\leq(?![a-zA-Z])/g, '≤');
  s = s.replace(/\\geq(?![a-zA-Z])/g, '≥');
  s = s.replace(/\\neq(?![a-zA-Z])/g, '≠');
  s = s.replace(/\\approx(?![a-zA-Z])/g, '≈');
  s = s.replace(/\\rightarrow(?![a-zA-Z])/g, '→');
  s = s.replace(/\\to(?![a-zA-Z])/g, '→');
  s = s.replace(/\\in(?![a-zA-Z])/g, '∈');
  s = s.replace(/\\notin(?![a-zA-Z])/g, '∉');

  // Superscripts: x^2, x^n, x^{10}
  const supMap: Record<string, string> = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  };
  s = s.replace(/\^(\d)/g, (_m: string, d: string) => supMap[d] || _m);
  s = s.replace(/\^\{([^}]+)\}/g, (_m: string, body: string) =>
    body.split('').map((c: string) => supMap[c] || c).join('')
  );

  // Subscripts: x_1, x_n, x_{10}
  const subMap: Record<string, string> = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
    '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  };
  s = s.replace(/_(\d)/g, (_m: string, d: string) => subMap[d] || _m);
  s = s.replace(/_\{([^}]+)\}/g, (_m: string, body: string) =>
    body.split('').map((c: string) => subMap[c] || c).join('')
  );

  // ASCII operator shorthand (both raw and HTML-encoded forms)
  s = s.replace(/&gt;=/g, '≥');
  s = s.replace(/&lt;=/g, '≤');
  s = s.replace(/>=/g, '≥');
  s = s.replace(/<=/g, '≤');
  s = s.replace(/!=/g, '≠');
  s = s.replace(/->/g, '→');
  s = s.replace(/=>/g, '⇒');

  // 5) Restore protected regions
  const nullGuard = '\u0000';
  s = s.replace(new RegExp(nullGuard + 'MATH-PROTECTED-(\\d+)' + nullGuard, 'g'), (_m, idx) => placeholders[Number(idx)] || '');

  return s;
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
    // Try \( ... \) first
    const matchParen = /^\\(\((.*?)\\\))/s.exec(src);
    if (matchParen) {
      return {
        type: 'mathInline',
        raw: matchParen[0],
        body: matchParen[1].trim(),
      };
    }
    // Try $ ... $ (inline, non-greedy)
    const matchDollar = /^\$(.+?)\$/s.exec(src);
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
  renderer: { code: renderCode },
  extensions: [mathInlineExtension, mathBlockExtension],
});

export function Markdown({
  content,
  variant = 'default',
  live = false,
}: {
  content: string;
  /** Assistant body may use a quieter serif; code/pre stay monospace via CSS. */
  variant?: 'default' | 'assistant';
  /** When true (active stream), skip highlight.js so code DOM isn't rewritten every flush. */
  live?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    if (!content) return '';
    // v1.1: convert common LaTeX math to unicode before marked parsing
    const processed = convertLatexToUnicode(content);
    liveMarkdownParse = live;
    try {
      return marked.parse(processed, { async: false });
    } finally {
      liveMarkdownParse = false;
    }
  }, [content, live]);

  // Copy button handler
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function handleClick(e: MouseEvent) {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(`[${COPY_CODE_ATTR}]`);
      if (!btn) return;
      const code = btn.getAttribute(COPY_CODE_ATTR);
      if (!code) return;
      navigator.clipboard.writeText(code).catch(() => {});
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, COPY_RESET_MS);
    }

    el.addEventListener('click', handleClick);
    return () => el.removeEventListener('click', handleClick);
  }, []);

  // Syntax colors are applied in renderCode (highlight.js). During live
  // streams we skip highlight so each flush only escapes HTML.

  return (
    <div
      ref={ref}
      className={
        variant === 'assistant'
          ? 'markdown-content markdown-content--assistant'
          : 'markdown-content'
      }
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function renderMarkdown(content: string): string {
  if (!content) return '';
  // v1.1: convert common LaTeX math to unicode before marked parsing
  const processed = convertLatexToUnicode(content);
  return marked.parse(processed, { async: false });
}
