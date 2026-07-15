/* ── ChatSendService ─────────────────────────────────────────────────── */
/* Builds outbound chat text, parses slash commands, and steer/queue ids.  */

import type { FileAttachment } from '@/types/chat';
import { ChatAttachmentService } from './ChatAttachmentService';

export interface ParsedSlashCommand {
  /** Lowercased command name without the leading slash. */
  cmd: string;
  /** Remainder after the command token (may be empty). */
  arg: string;
  /** Full original text that matched. */
  raw: string;
}

/**
 * Pure helpers for the composer → workbench send path: prompt assembly,
 * slash-command detection, session title heuristics, and queue routing ids.
 */
export class ChatSendService {
  /** Merge composer text with attachment sections for the model prompt. */
  static composeUserText(text: string, attachments: FileAttachment[]): string {
    return ChatAttachmentService.composeUserText(text, attachments);
  }

  /**
   * Detect a leading `/command args` form used by the voice-command registry
   * and backend slash handlers. Returns null when the text is ordinary prose.
   */
  static parseSlashCommand(text: string): ParsedSlashCommand | null {
    const slashMatch = text.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
    if (!slashMatch) return null;
    return {
      cmd: slashMatch[1].toLowerCase(),
      arg: String(slashMatch[2] || '').trim(),
      raw: text,
    };
  }

  /**
   * True when the sidebar title is still a placeholder and the first real
   * user message should derive a session title.
   */
  static sessionNeedsAutoTitle(title: string | undefined | null): boolean {
    if (!title) return true;
    const trimmed = title.trim();
    return (
      /^(new chat|new session|untitled)$/i.test(trimmed) ||
      /^chat\s+\d{4}-\d{2}-\d{2}/i.test(trimmed)
    );
  }

  /** Slash commands themselves should not become the session title. */
  static isCommandText(text: string): boolean {
    return /^\s*\/[a-zA-Z][\w-]*\b/.test(text);
  }

  /**
   * Workbench queue/steer APIs are keyed by the workbench session id when
   * known; fall back to the UI session id so early turns still enqueue.
   */
  static resolveWorkbenchQueueId(
    workbenchSessionId: string | undefined | null,
    activeWorkbenchSessionId: string | undefined | null,
    sessionId: string,
  ): string {
    return workbenchSessionId || activeWorkbenchSessionId || sessionId;
  }
}
