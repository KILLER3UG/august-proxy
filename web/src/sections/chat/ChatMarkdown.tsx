import { marked } from 'marked';

marked.use({
  gfm: true,
  breaks: true
});

export function Markdown({ content }: { content: string }) {
  if (!content) return null;
  const html = marked.parse(content) as string;

  return (
    <div
      className="markdown-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
