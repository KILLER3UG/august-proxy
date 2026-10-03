/* ── Thread message pane ───────────────────────────────────────────────── */
/* Scrollable message list, working indicator, scroll affordances, and the */
/* sticky composer / plan banner strip under the transcript.               */

import { useCallback, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listWorkbenchCheckpoints, type WorkbenchCheckpoint } from '@/api/workbench';
import { resolveWorkbenchSessionId } from './stream/session-id-map';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import { messagePop, userMessagePop } from '@/lib/motion';
import { ScrollToTopButton } from '@/components/chat/ScrollToTopButton';
import { WorkingIndicator } from '@/components/chat/WorkingIndicator';
import { MessageBubble } from './MessageBubble';
import { InThreadSearch } from './InThreadSearch';
import { ChangesPill } from '@/components/chat/git/ChangesPill';
import type { ModelItem } from './model-display';
import { ModelPickerCard } from './ModelPickerCard';
import { VirtualizedMessageList } from './VirtualizedMessageList';
import type { ChatMessage } from '@/types/chat';
import type { SubagentPromptMap } from './hooks/useSessionStream';
import type { SubagentBlockState } from './chat-stream-manager';
import { useMessageEnterAnimation } from './hooks/useMessageEnterAnimation';

export function ChatThreadMessagePane({
  sessionId,
  messages,
  streaming,
  selectedModelId,
  toolProgress,
  subagentPrompts,
  subagentBlocks,
  subagentRoster,
  revertingIndex,
  modelPickerActive,
  onDismissModelPicker,
  scrolledFromTop,
  scrollRef,
  onRevert,
  onEdit,
  onRegenerate,
  onFork,
  onClarifyAnswer,
  footerSlot,
  models,
  onReanswerWithModel,
  onCompare,
  onDismissError,
  onBeforeJump,
  virtRef,
}: {
  sessionId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  selectedModelId?: string;
  toolProgress?: Map<string, ReadonlyArray<{ path: string; status: 'reading' | 'read' }>>;
  subagentPrompts?: SubagentPromptMap;
  subagentBlocks?: Map<string, SubagentBlockState>;
  subagentRoster?: ReadonlyArray<{
    jobId: string;
    agentId: string;
    task: string;
    status: 'running' | 'pending' | 'completed' | 'failed' | 'cancelled' | 'partial' | 'done' | 'error';
    startedAt?: number;
    finishedAt?: number;
    workstream?: string;
  }>;
  revertingIndex: number | null;
  modelPickerActive: boolean;
  onDismissModelPicker: () => void;
  scrolledFromTop: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onRevert: (index: number) => void;
  onEdit: (index: number, text: string) => void;
  onRegenerate: (index: number) => void | Promise<void>;
  onFork: (index: number) => void;
  onClarifyAnswer: (msgId: string, answer: string) => void;
  /** Composer or plan banner under the list. */
  footerSlot: ReactNode;
  /** Visible model catalog for "answer this with another model" (A4). */
  models?: ModelItem[];
  onReanswerWithModel?: (model: ModelItem, index: number) => void;
  /** "Compare" — re-run the message's prompt on 2–3 models side by side. */
  onCompare?: (index: number) => void;
  /** Dismiss the provider-error bubble on a message (removes the block). */
  onDismissError?: (msgId: string) => void;
  /** Fired before an in-thread search jump (unpins stick-to-bottom). */
  onBeforeJump?: () => void;
  /** Virtualizer handle for jumping to virtualized rows. */
  virtRef?: React.MutableRefObject<{ scrollToIndex: (index: number, opts?: object) => void } | null>;
}) {
  const shouldAnimateEnter = useMessageEnterAnimation(messages, sessionId);

  // Save points grouped per assistant turn (SavePointChip). The backend
  // snapshots files before every mutating tool call; assigning each to the
  // turn it belongs to is a local pass over message timestamps.
  const wbSessionId = useMemo(
    () => (sessionId ? resolveWorkbenchSessionId(sessionId) : null),
    [sessionId],
  );
  const checkpointsQuery = useQuery({
    queryKey: ['workbench-checkpoints', wbSessionId],
    queryFn: () => listWorkbenchCheckpoints(wbSessionId!),
    enabled: Boolean(wbSessionId),
    staleTime: 30_000,
  });
  const savePointsByMsg = useMemo(() => {
    const map = new Map<string, WorkbenchCheckpoint[]>();
    const checkpoints = checkpointsQuery.data ?? [];
    if (checkpoints.length === 0 || messages.length === 0) return map;
    const times = messages.map((m) => {
      const t = Date.parse(m.timestamp);
      return Number.isFinite(t) ? t : -Infinity;
    });
    for (const cp of checkpoints) {
      const t = Date.parse(cp.createdAt ?? '');
      if (!Number.isFinite(t)) continue;
      // The last user message that started at or before the snapshot…
      let userIdx = -1;
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'user' && times[i] <= t && times[i] >= 0) userIdx = i;
      }
      if (userIdx < 0) continue;
      // …belongs to the first assistant reply after it.
      for (let j = userIdx + 1; j < messages.length; j++) {
        if (messages[j].role !== 'user') {
          const list = map.get(messages[j].id) ?? [];
          list.push(cp);
          map.set(messages[j].id, list);
          break;
        }
        break;
      }
    }
    return map;
  }, [messages, checkpointsQuery.data]);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchedIndices, setMatchedIndices] = useState<number[]>([]);

  const handleSearch = useCallback(
    (query: string): number => {
      setSearchQuery(query);
      if (!query.trim()) {
        setMatchedIndices([]);
        return 0;
      }
      const lower = query.toLowerCase();
      const indices = messages
        .map((m, i) => {
          // Search the visible content AND block payloads (assistant
          // answers usually live in blocks, not raw content).
          const blocksText = (m.blocks ?? [])
            .map((b) => b.content ?? '')
            .join(' ');
          return { text: `${m.content ?? ''}\n${blocksText}`.toLowerCase(), i };
        })
        .filter(({ text }) => text.includes(lower))
        .map(({ i }) => i);
      setMatchedIndices(indices);
      return indices.length;
    },
    [messages],
  );

  const handleNavigate = useCallback((matchIndex: number) => {
    if (matchIndex < 0 || matchIndex >= matchedIndices.length) return;
    const msgIndex = matchedIndices[matchIndex];
    // Unpin stick-to-bottom so the next append doesn't fight the jump.
    onBeforeJump?.();
    // Virtualized transcripts only render a window of rows — querySelector
    // misses out-of-window targets, so jump through the virtualizer.
    const virt = virtRef?.current;
    if (virt && typeof virt.scrollToIndex === 'function') {
      virt.scrollToIndex(msgIndex, { align: 'center' });
      return;
    }
    const el = document.querySelector(`[data-message-index="${msgIndex}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [matchedIndices, onBeforeJump, virtRef]);

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    setMatchedIndices([]);
  }, []);

  return (
    <div className="august-message-pane flex-1 flex flex-col min-h-0 relative">
      <InThreadSearch
        messageCount={messages.length}
        onSearch={handleSearch}
        onNavigate={handleNavigate}
        onClear={handleClearSearch}
      />
      {sessionId && (
        <ChangesPill sessionId={sessionId} roster={subagentRoster} />
      )}
      <div
        ref={scrollRef}
        className="august-chat-scroll flex-1 overflow-y-auto overflow-x-hidden chat-scroll"
      >
        {/* overflow-anchor:none on content + sentinel below keeps stick-to-bottom
            smooth while the model reply grows (avoids per-token JS scroll snaps). */}
        <div className="chat-scroll-content">
        <VirtualizedMessageList
          messages={messages}
          scrollParentRef={scrollRef}
          virtRef={virtRef}
          renderMessage={(m, realIndex) => {
            const isReverting =
              revertingIndex !== null && realIndex > revertingIndex;
            // Only animate user bubbles — assistant placeholders must appear
            // immediately so the AUG working indicator stays visible.
            const animateIn = m.role === 'user' && shouldAnimateEnter(m.id);
            const pop = m.role === 'user' ? userMessagePop : messagePop;
            return (
              <motion.div
                data-message-index={realIndex}
                initial={animateIn ? pop.initial : false}
                animate={
                  isReverting
                    ? { opacity: 0, y: -12, scale: 0.98 }
                    : pop.animate
                }
                transition={
                  isReverting
                    ? { duration: 0.22, ease: [0.16, 1, 0.3, 1] }
                    : pop.transition
                }
                style={{ transformOrigin: m.role === 'user' ? 'right bottom' : 'left bottom' }}
                className={cn(
                  isReverting && 'pointer-events-none',
                  searchQuery.trim() &&
                    matchedIndices.includes(realIndex) &&
                    'ring-1 ring-primary/50 rounded-lg',
                )}
              >
                <MessageBubble
                  message={m}
                  isLast={realIndex === messages.length - 1}
                  streaming={streaming}
                  sessionId={sessionId ?? undefined}
                  modelId={selectedModelId}
                  onRevert={() => onRevert(realIndex)}
                  onEdit={(text) => onEdit(realIndex, text)}
                  onRegenerate={() => {
                    void onRegenerate(realIndex);
                  }}
                  onFork={() => onFork(realIndex)}
                  onClarifyAnswer={(ans) => onClarifyAnswer(m.id, ans)}
                  toolProgress={toolProgress}
                  subagentPrompts={subagentPrompts}
                  subagentBlocks={subagentBlocks}
                  subagentRoster={subagentRoster}
                  savePoints={savePointsByMsg.get(m.id)}
                  models={models}
                  onReanswerWithModel={
                    onReanswerWithModel
                      ? (model) => onReanswerWithModel(model, realIndex)
                      : undefined
                  }
                  onCompare={onCompare ? () => onCompare(realIndex) : undefined}
                  onDismissError={
                    onDismissError ? () => onDismissError(m.id) : undefined
                  }
                />
              </motion.div>
            );
          }}
          footer={
            modelPickerActive ? (
              <ModelPickerCard
                sessionId={sessionId ?? ''}
                onDismiss={onDismissModelPicker}
                context={{ currentModelId: selectedModelId }}
              />
            ) : null
          }
        />
        </div>
        {/* Last in flow so the browser anchors here as the transcript grows. */}
        <div className="chat-scroll-anchor" aria-hidden />
      </div>

      {/* Viewport-fixed chrome — sticky inside the scroller sat at content end,
          so the jump-to-top control unmounted exactly when it became visible.
          The jump-to-bottom button now lives in the composer card (see
          ChatThreadComposer) so it can straddle the composer's top border. */}
      <div className="chat-scroll-chrome pointer-events-none absolute bottom-4 right-3 z-30 flex flex-col gap-2 items-center">
        <ScrollToTopButton
          scrollParentRef={scrollRef}
          visible={scrolledFromTop}
        />
      </div>

      {/* AUG — anchored above the composer; the slot grows with the live
          strip (phase chip + sentence stack) and fades when streaming ends. */}
      <div
        className={cn(
          'mx-auto w-full max-w-3xl px-4 shrink-0 transition-[height,opacity] duration-200',
          streaming ? 'h-auto opacity-100 pointer-events-auto' : 'h-0 overflow-hidden opacity-0 pointer-events-none',
        )}
        aria-hidden={!streaming}
      >
        <div className="pt-1" data-testid="aug-working-indicator">
          <WorkingIndicator sessionId={sessionId} />
        </div>
      </div>

      {/* Plan / approval banners replace the composer until the user decides. */}
      <div className="august-message-footer shrink-0 z-10 w-full bg-background py-1.5">
        {footerSlot}
      </div>
    </div>
  );
}
