/* ── Thread message pane ───────────────────────────────────────────────── */
/* Scrollable message list, working indicator, scroll affordances, and the */
/* sticky composer / plan banner strip under the transcript.               */

import { useCallback, useState, type ReactNode, type RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { messagePop, userMessagePop } from '@/lib/motion';
import { ScrollToTopButton } from '@/components/chat/ScrollToTopButton';
import { WorkingIndicator } from '@/components/chat/WorkingIndicator';
import { MessageBubble } from './MessageBubble';
import { InThreadSearch } from './InThreadSearch';
import type { ModelItem } from './model-display';
import { ModelPickerCard } from './ModelPickerCard';
import { VirtualizedMessageList } from './VirtualizedMessageList';
import type { ChatMessage } from '@/types/chat';
import type { SubagentPromptMap } from './hooks/useSessionStream';
import type { SubagentBlockState } from './chat-stream-manager';
import { useMessageEnterAnimation } from './hooks/useMessageEnterAnimation';
import { ChatRunHeader } from '@/components/chat/ChatRunHeader';
import type { WorkbenchSession } from '@/types/workbench';

export function ChatThreadMessagePane({
  sessionId,
  messages,
  streaming,
  selectedModelId,
  toolProgress,
  subagentPrompts,
  subagentBlocks,
  revertingIndex,
  modelPickerActive,
  onDismissModelPicker,
  scrolledFromTop,
  scrolledFromBottom,
  showNewContentPill = false,
  scrollRef,
  onScrollToBottom,
  onRevert,
  onEdit,
  onRegenerate,
  onFork,
  onClarifyAnswer,
  footerSlot,
  models,
  onReanswerWithModel,
  onCompare,
  onBeforeJump,
  virtRef,
  workbenchSession,
  pct = 0,
}: {
  sessionId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  selectedModelId?: string;
  toolProgress?: Map<string, ReadonlyArray<{ path: string; status: 'reading' | 'read' }>>;
  subagentPrompts?: SubagentPromptMap;
  subagentBlocks?: Map<string, SubagentBlockState>;
  revertingIndex: number | null;
  modelPickerActive: boolean;
  onDismissModelPicker: () => void;
  scrolledFromTop: boolean;
  scrolledFromBottom: boolean;
  /** True when new tokens/cards arrived while the user was scrolled up. */
  showNewContentPill?: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScrollToBottom: () => void;
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
  /** Fired before an in-thread search jump (unpins stick-to-bottom). */
  onBeforeJump?: () => void;
  /** Virtualizer handle for jumping to virtualized rows. */
  virtRef?: React.MutableRefObject<{ scrollToIndex: (index: number, opts?: object) => void } | null>;
  workbenchSession?: WorkbenchSession | null;
  pct?: number;
}) {
  const shouldAnimateEnter = useMessageEnterAnimation(messages, sessionId);
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
      <ChatRunHeader
        workbenchSession={workbenchSession ?? null}
        pct={pct}
        streaming={streaming}
        subagentBlocks={subagentBlocks}
      />
      <InThreadSearch
        messageCount={messages.length}
        onSearch={handleSearch}
        onNavigate={handleNavigate}
        onClear={handleClearSearch}
      />
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
                  models={models}
                  onReanswerWithModel={
                    onReanswerWithModel
                      ? (model) => onReanswerWithModel(model, realIndex)
                      : undefined
                  }
                  onCompare={onCompare ? () => onCompare(realIndex) : undefined}
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
          so the jump-to-bottom control unmounted exactly when it became visible. */}
      <div className="chat-scroll-chrome pointer-events-none absolute bottom-4 right-3 z-30 flex flex-col gap-2 items-center">
        <ScrollToTopButton
          scrollParentRef={scrollRef}
          visible={scrolledFromTop}
        />
        <AnimatePresence>
          {scrolledFromBottom && (
            <motion.button
              type="button"
              initial={{ opacity: 0, y: 6, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.96 }}
              transition={{ duration: 0.18 }}
              onClick={onScrollToBottom}
              className={
                showNewContentPill
                  ? 'pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-background/90 backdrop-blur-sm border border-border shadow-sm px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background transition-colors cursor-pointer'
                  : 'pointer-events-auto w-9 h-9 flex items-center justify-center rounded-full bg-background/80 backdrop-blur-sm border border-border shadow-sm text-muted-foreground hover:text-foreground hover:bg-background/95 transition-colors cursor-pointer'
              }
              aria-label={showNewContentPill ? 'Jump to new content' : 'Scroll to bottom'}
            >
              <ChevronDown className={showNewContentPill ? 'size-3.5 shrink-0' : 'size-4'} />
              {showNewContentPill ? 'New content' : null}
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* AUG — anchored above the composer in a fixed-height slot with opacity transition to avoid layout reflow when streaming completes. */}
      <div
        className={cn(
          'mx-auto w-full max-w-3xl px-4 shrink-0 h-7 transition-opacity duration-200',
          streaming ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
        aria-hidden={!streaming}
      >
        <div className="pt-1" data-testid="aug-working-indicator">
          <WorkingIndicator />
        </div>
      </div>

      {/* Plan / approval banners replace the composer until the user decides. */}
      <div className="august-message-footer shrink-0 z-10 w-full bg-background py-3">
        {footerSlot}
      </div>
    </div>
  );
}
