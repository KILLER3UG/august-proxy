/**
 * switchChatModel — shared stop → handoff → apply → (auto-continue) flow
 * used by both the chat-thread model-selected event handler and the composer
 * model menu. Previously two divergent copies (ChatThread.tsx vs
 * ComposerToolbar.tsx) drifted apart; this is the single source of truth.
 *
 * The auto-continue is deliberately NOT here: it needs the caller's
 * generateAIResponse closure and message truncation, so the caller runs it
 * after this resolves with `{ interrupted }`.
 */

import type { ChatMessage } from '@/types/chat';
import type { ModelItem } from './model-display';

export interface SwitchChatModelOptions {
  sessionId: string | null | undefined;
  prevModel: ModelItem | null | undefined;
  nextModel: ModelItem;
  streaming: boolean;
  /** Stop the running turn (queue preserved). */
  stopStream: () => Promise<unknown>;
  /** Latest messages at switch time. */
  getMessages: () => ChatMessage[];
  /** Append / mutate messages (used for the handoff notice card). */
  setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  /** Persist the selection (state, refs, localStorage, session model). */
  onModelApplied: (model: ModelItem) => void;
  /** Optional "preparing handoff…" indicator callback. */
  onHandoffPreparingChange?: (preparing: boolean) => void;
}

export interface SwitchChatModelResult {
  /** True when a running turn was interrupted (caller may auto-continue). */
  interrupted: boolean;
}

export async function switchChatModel(
  opts: SwitchChatModelOptions,
): Promise<SwitchChatModelResult> {
  const { sessionId, prevModel: prev, nextModel, streaming } = opts;
  const msgs = opts.getMessages();
  const modelChanged = !!(sessionId && prev && prev.id !== nextModel.id);

  // 1) Streaming: stop the turn (queue preserved) and capture a handoff
  //    brief before stream state is torn down.
  let interrupted = false;
  if (streaming && sessionId) {
    interrupted = true;
    const { buildHandoffSummary, markHandoffPending } = await import('./handoff-summary');
    const summary = buildHandoffSummary(msgs, prev?.name || prev?.id);
    await opts.stopStream();
    markHandoffPending(sessionId, summary, prev?.id);
  } else if (modelChanged && sessionId) {
    // Model change after a prior cancel — still attach a handoff if pending empty.
    const { peekHandoffPending, buildHandoffSummary, markHandoffPending } = await import('./handoff-summary');
    if (!peekHandoffPending(sessionId)) {
      const last = msgs[msgs.length - 1];
      const incomplete =
        last?.role === 'assistant' &&
        (!last.content?.trim() ||
          last.blocks?.some(
            (b) =>
              b.type === 'thinking' ||
              (b.type === 'toolCall' && b.tool?.status === 'running'),
          ));
      if (incomplete) {
        markHandoffPending(sessionId, buildHandoffSummary(msgs, prev?.name || prev?.id), prev?.id);
      }
    }
  }

  // 2) Server-computed handoff for ANY model change with prior messages —
  //    non-blocking, upgrades the pending summary and drops a notice card.
  if (modelChanged && msgs.length > 0 && sessionId) {
    const sid = sessionId;
    const fromLabel = prev?.name || prev?.id || '';
    opts.onHandoffPreparingChange?.(true);
    void (async () => {
      try {
        const { requestSessionHandoff } = await import('@/api/workbench');
        const record = await requestSessionHandoff(sid, prev?.id ?? '', nextModel.id);
        const { markHandoffPending, buildHandoffNoticeMessage } = await import('./handoff-summary');
        markHandoffPending(
          sid,
          `Previous model (${fromLabel}) context handoff:\n${record.summary}`,
          prev?.id,
        );
        opts.setMessages((list) => [...list, buildHandoffNoticeMessage(record, fromLabel)]);
      } catch (error) {
        console.warn('[switchChatModel] Server handoff summary failed, using local fallback:', error);
        const { peekHandoffPending, buildHandoffSummary, markHandoffPending } = await import('./handoff-summary');
        if (!peekHandoffPending(sid)) {
          markHandoffPending(sid, buildHandoffSummary(msgs, fromLabel), prev?.id);
        }
      } finally {
        opts.onHandoffPreparingChange?.(false);
      }
    })();
  }

  // 3) Apply the selection (next turn / auto-continue uses the new model).
  opts.onModelApplied(nextModel);
  return { interrupted };
}
