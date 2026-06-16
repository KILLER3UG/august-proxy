import { useMemo } from 'react';
import { marked } from 'marked';

marked.use({
  gfm: true,
  breaks: true
});

export function Markdown({ content }: { content: string }) {
  if (!content) return null;
  const blocks = useMemo(() => {
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

  return (
    <div className="markdown-content">
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
