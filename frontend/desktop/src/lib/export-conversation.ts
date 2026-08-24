/* ── Conversation export ───────────────────────────────────────────────── */
/* Renders a chat transcript to Markdown and downloads it as a .md file.    */

import type { ChatMessage } from '@/types/chat';

/** Final answer text of an assistant message (blocks win over raw content). */
function assistantText(message: ChatMessage): string {
  const fromBlocks = message.blocks
    ?.filter((b) => b.type === 'finalOutput' && b.content?.trim())
    .map((b) => b.content!.trim())
    .join('\n\n');
  return (fromBlocks || message.content || '').trim();
}

/** One-line tool summaries so exports keep context without raw output. */
function toolLines(message: ChatMessage): string[] {
  const tools = message.tools ?? [];
  return tools
    .map((t) => {
      const summary = t.summary?.trim().replace(/\s+/g, ' ').slice(0, 160);
      const status = t.status === 'error' ? ' (failed)' : '';
      return `- ${t.name}${status}${summary ? ` — ${summary}` : ''}`;
    })
    .filter(Boolean);
}

export function messagesToMarkdown(
  messages: ChatMessage[],
  title?: string | null,
): string {
  const lines: string[] = [];
  lines.push(`# ${title?.trim() || 'Conversation'}`);
  lines.push('');
  lines.push(`_Exported ${new Date().toLocaleString()}_`);
  lines.push('');

  for (const message of messages) {
    if (message.role === 'user') {
      lines.push('## User');
      lines.push('');
      lines.push((message.content || '').trim() || '_(attachment)_');
      lines.push('');
      continue;
    }
    if (message.role !== 'assistant') continue;

    const tools = toolLines(message);
    const text = assistantText(message);
    if (!text && tools.length === 0) continue;

    lines.push('## Assistant');
    lines.push('');
    if (tools.length > 0) {
      lines.push(...tools);
      lines.push('');
    }
    if (text) {
      lines.push(text);
      lines.push('');
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'conversation'
  );
}

/** Download the transcript as a Markdown file; returns the file name. */
export function downloadConversation(
  messages: ChatMessage[],
  title?: string | null,
): string {
  const markdown = messagesToMarkdown(messages, title);
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${slugify(title || '')}-${date}.md`;
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return filename;
}

/** Copy the transcript to the clipboard as Markdown (C3). */
export async function copyConversationToClipboard(
  messages: ChatMessage[],
  title?: string | null,
): Promise<void> {
  const markdown = messagesToMarkdown(messages, title);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(markdown);
    return;
  }
  // Fallback for environments without the async clipboard API.
  const textarea = document.createElement('textarea');
  textarea.value = markdown;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

/** Export the conversation as PDF via the browser's print dialog. */
export function exportConversationToPdf(
  messages: ChatMessage[],
  title?: string | null,
): void {
  const markdown = messagesToMarkdown(messages, title);
  const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title || 'Conversation')}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a; line-height: 1.6; }
  h1 { font-size: 24px; border-bottom: 2px solid #e5e5e5; padding-bottom: 8px; }
  h2 { font-size: 18px; margin-top: 24px; color: #444; }
  p { margin: 8px 0; }
  code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-size: 14px; }
  pre { background: #f5f5f5; padding: 16px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  hr { border: none; border-top: 1px solid #e5e5e5; margin: 24px 0; }
  em { color: #666; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
${(() => {
  let inCodeBlock = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (line.trim().startsWith('```')) {
        // Fenced code: toggle open/close (``` or ```lang both open).
        inCodeBlock = !inCodeBlock;
        return inCodeBlock ? '<pre><code>' : '</code></pre>';
      }
      if (inCodeBlock) return escapeHtml(line);
      if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith('- ')) return `<li>${escapeHtml(line.slice(2))}</li>`;
      if (line.startsWith('_') && line.endsWith('_')) return `<em>${escapeHtml(line.slice(1, -1))}</em>`;
      if (line.trim() === '') return '<br>';
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join('\n');
})()}
</body>
</html>`;

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.left = '-9999px';
  iframe.style.top = '-9999px';
  iframe.style.width = '800px';
  iframe.style.height = '600px';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  if (!doc) {
    document.body.removeChild(iframe);
    throw new Error('Could not create print frame');
  }
  doc.open();
  doc.write(htmlContent);
  doc.close();

  // Wait for content to render, then trigger print.
  setTimeout(() => {
    iframe.contentWindow?.print();
    setTimeout(() => document.body.removeChild(iframe), 1000);
  }, 500);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
