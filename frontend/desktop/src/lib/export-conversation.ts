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
  lines.push(`# ${title?.trim() || 'August conversation'}`);
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

    lines.push('## August');
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
