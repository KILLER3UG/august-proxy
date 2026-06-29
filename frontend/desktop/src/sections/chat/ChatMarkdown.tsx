import { useEffect, useMemo, useRef } from 'react';
import { marked, type Tokens } from 'marked';
import katex from 'katex';

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

function renderCode(token: Tokens.Code): string {
  const lang = (token.lang || '').trim();
  const langClass = lang ? ` class="language-${escapeAttr(lang)}"` : '';
  const code = escapeAttr(token.text);
  return (
    `<div class="markdown-code-block relative group">` +
      `<pre${langClass}><code${langClass}>${token.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>` +
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
    // On error, render the raw source in an error color
    return `<span style="color: var(--dt-danger, #d2503f);">${body}</span>`;
  }
}

const mathInlineExtension = {
  name: 'mathInline',
  level: 'inline',
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
  renderer(token: any) {
    return renderMath(token.body, false);
  },
};

const mathBlockExtension = {
  name: 'mathBlock',
  level: 'block',
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
  renderer(token: any) {
    return renderMath(token.body, true);
  },
};

marked.use({
  gfm: true,
  breaks: true,
  renderer: { code: renderCode },
  extensions: [mathInlineExtension, mathBlockExtension],
});

export function Markdown({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    if (!content) return '';
    return marked.parse(content, { async: false }) as string;
  }, [content]);

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

  // Prism-like highlighting for code blocks via highlight.js (already loaded)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Highlight all code blocks
    const blocks = el.querySelectorAll<HTMLElement>('pre code[class*="language-"]');
    if (blocks.length > 0 && (window as any).hljs) {
      blocks.forEach((block) => {
        try { (window as any).hljs.highlightElement(block); } catch {}
      });
    }
  }, [html]);

  return (
    <div
      ref={ref}
      className="markdown-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function renderMarkdown(content: string): string {
  if (!content) return '';
  return marked.parse(content, { async: false }) as string;
}
