/**
 * Build a compact handoff brief when the user cancels a turn and switches models.
 * The next model sees prior user goals + what the previous model was doing.
 */

import type { ChatMessage, MessageBlock } from '@/types/chat';

function blockSnippet(block: MessageBlock, max = 240): string | null {
  if (block.type === 'thinking' && block.content?.trim()) {
    const t = block.content.trim().replace(/\s+/g, ' ');
    return `Thinking: ${t.length > max ? `${t.slice(0, max)}…` : t}`;
  }
  if (block.type === 'finalOutput' && block.content?.trim()) {
    const t = block.content.trim().replace(/\s+/g, ' ');
    return `Partial reply: ${t.length > max ? `${t.slice(0, max)}…` : t}`;
  }
  if ((block.type === 'toolCall' || block.type === 'command') && block.tool) {
    const name = block.tool.name?.replace(/^@/, '') || 'tool';
    const path =
      block.tool.summary?.trim() ||
      block.tool.context?.slice(0, 80) ||
      '';
    const status = block.tool.status || 'running';
    return path
      ? `Tool ${name} (${status}): ${path}`
      : `Tool ${name} (${status})`;
  }
  return null;
}

/** Pending handoff keyed by UI session id. */
const pendingBySession = new Map<
  string,
  { summary: string; fromModel?: string; at: number }
>();

export function markHandoffPending(
  sessionId: string,
  summary: string,
  fromModel?: string,
): void {
  if (!sessionId || !summary.trim()) return;
  pendingBySession.set(sessionId, {
    summary: summary.trim(),
    fromModel,
    at: Date.now(),
  });
}

/** Take (and clear) a pending handoff for the next chat POST. */
export function takeHandoffSummary(sessionId: string): string | null {
  const entry = pendingBySession.get(sessionId);
  if (!entry) return null;
  pendingBySession.delete(sessionId);
  // Ignore stale handoffs older than 30 minutes.
  if (Date.now() - entry.at > 30 * 60 * 1000) return null;
  const header = entry.fromModel
    ? `Previous model (${entry.fromModel}) was interrupted. Handoff brief:`
    : 'Previous model was interrupted. Handoff brief:';
  return `${header}\n${entry.summary}`;
}

export function peekHandoffPending(sessionId: string): boolean {
  return pendingBySession.has(sessionId);
}

export function clearHandoffPending(sessionId: string): void {
  pendingBySession.delete(sessionId);
}

/**
 * Summarize recent user turns + the last (possibly incomplete) assistant work.
 */
export function buildHandoffSummary(
  messages: ChatMessage[],
  previousModel?: string | null,
): string {
  const lines: string[] = [];
  if (previousModel) {
    lines.push(`Interrupted model: ${previousModel}`);
  }

  const recent = messages.slice(-12);
  for (const msg of recent) {
    if (msg.role === 'user') {
      const text = (msg.content || '').trim().replace(/\s+/g, ' ');
      if (!text) continue;
      lines.push(
        `User: ${text.length > 320 ? `${text.slice(0, 320)}…` : text}`,
      );
      continue;
    }
    if (msg.role !== 'assistant') continue;

    const parts: string[] = [];
    for (const block of msg.blocks || []) {
      const snip = blockSnippet(block);
      if (snip) parts.push(snip);
    }
    const content = (msg.content || '').trim().replace(/\s+/g, ' ');
    if (parts.length === 0 && content) {
      parts.push(
        content.length > 320 ? `${content.slice(0, 320)}…` : content,
      );
    }
    if (parts.length === 0) continue;
    lines.push(`Assistant work:\n- ${parts.slice(0, 8).join('\n- ')}`);
  }

  if (lines.length === 0) {
    return 'The user stopped the previous response mid-generation. Continue from the conversation above.';
  }
  lines.push(
    'Continue from this state with the newly selected model. Do not restart from scratch unless the user asks.',
  );
  return lines.join('\n');
}
