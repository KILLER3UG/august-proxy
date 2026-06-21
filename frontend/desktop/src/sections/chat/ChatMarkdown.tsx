import { useEffect, useMemo, useRef } from 'react';
import { marked, type Tokens } from 'marked';

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

function decodeAttr(value: string): string {
  return value
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function renderCode(token: Tokens.Code): string {
  const lang = (token.lang || '').trim();
  const langClass = lang ? ` class="language-${escapeAttr(lang)}"` : '';
  const code = escapeAttr(token.text);
  // Placeholder button carries the raw code as an attribute; a React
  // useEffect replaces it with a real button that owns the "Copied!"
  // feedback state.
  return (
    `<div class="markdown-code-block relative group">` +
      `<button type="button" ${COPY_PLACEHOLDER_ATTR} ${COPY_CODE_ATTR}="${code}" ` +
        `class="markdown-copy-btn absolute right-2 top-2 inline-flex items-center gap-1 rounded-md ` +
        `border border-border/60 bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground ` +
        `opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100">` +
        `Copy` +
      `</button>` +
      `<pre${langClass}><code${langClass}>${token.text}</code></pre>` +
    `</div>`
  );
}

marked.use({
  gfm: true,
  breaks: true,
  renderer: { code: renderCode },
});

export function Markdown({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const blocks = useMemo(() => {
    if (!content) return [];
    return marked.lexer(content)
      .filter(token => token.type !== 'space')
      .map((token, index) => {
        const raw = token.raw ?? '';
        let html = '';
        try {
          html = marked.parser([token]) as string;
        } catch {
          html = marked.parse(raw) as string;
        }
        return {
          key: `${index}-${token.type}-${raw.slice(0, 32).replace(/\s+/g, '')}`,
          html
        };
      });
  }, [content]);

  // Hydrate copy-button placeholders into real React-driven buttons so they
  // can own their "Copied!" state and call navigator.clipboard.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const placeholders = Array.from(
      root.querySelectorAll<HTMLButtonElement>(`button[${COPY_PLACEHOLDER_ATTR}]`)
    );

    const cleanups: Array<() => void> = [];

    for (const placeholder of placeholders) {
      const encoded = placeholder.getAttribute(COPY_CODE_ATTR) ?? '';
      const code = decodeAttr(encoded);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = placeholder.className;
      button.setAttribute('aria-label', 'Copy code');
      button.innerHTML =
        `<span class="markdown-copy-icon-copy"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></span>` +
        `<span class="markdown-copy-label">Copy</span>`;

      let resetTimer: number | undefined;
      const flashCopied = () => {
        button.querySelector('.markdown-copy-icon-copy')!.innerHTML =
          `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        const label = button.querySelector('.markdown-copy-label');
        if (label) label.textContent = 'Copied!';
        if (resetTimer) window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(() => {
          button.querySelector('.markdown-copy-icon-copy')!.innerHTML =
            `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
          if (label) label.textContent = 'Copy';
        }, COPY_RESET_MS);
      };

      const onClick = () => {
        navigator.clipboard?.writeText(code).then(flashCopied).catch(() => {
          // Clipboard API failed (insecure context, etc.) — at least give
          // visual feedback so the user knows we tried.
          flashCopied();
        });
      };

      button.addEventListener('click', onClick);
      placeholder.replaceWith(button);

      cleanups.push(() => {
        button.removeEventListener('click', onClick);
        if (resetTimer) window.clearTimeout(resetTimer);
      });
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [blocks]);

  if (!content) return null;

  return (
    <div className="markdown-content" ref={containerRef}>
      {blocks.map(block => (
        <div
          key={block.key}
          className="markdown-token"
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      ))}
    </div>
  );
}