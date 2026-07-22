/* ── Thread message pane ───────────────────────────────────────────────── */
/* Scrollable message list, working indicator, scroll affordances, and the */
/* sticky composer / plan banner strip under the transcript.               */

import type { ReactNode, RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { messagePop, userMessagePop } from '@/lib/motion';
import { ScrollToTopButton } from '@/components/chat/ScrollToTopButton';
import { WorkingIndicator } from '@/components/chat/WorkingIndicator';
import { MessageBubble } from './MessageBubble';
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
  onClarifyAnswer,
  footerSlot,
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
  onClarifyAnswer: (msgId: string, answer: string) => void;
  /** Composer or plan banner under the list. */
  footerSlot: ReactNode;
}) {
  const shouldAnimateEnter = useMessageEnterAnimation(messages, sessionId);

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto chat-scroll"
      >
        {/* overflow-anchor:none on content + sentinel below keeps stick-to-bottom
            smooth while the model reply grows (avoids per-token JS scroll snaps). */}
        <div className="chat-scroll-content">
        <VirtualizedMessageList
          messages={messages}
          scrollParentRef={scrollRef}
          renderMessage={(m, realIndex) => {
            const isReverting =
              revertingIndex !== null && realIndex > revertingIndex;
            // Only animate user bubbles — assistant placeholders must appear
            // immediately so the AUG working indicator stays visible.
            const animateIn = m.role === 'user' && shouldAnimateEnter(m.id);
            const pop = m.role === 'user' ? userMessagePop : messagePop;
            return (
              <motion.div
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
                  onClarifyAnswer={(ans) => onClarifyAnswer(m.id, ans)}
                  toolProgress={toolProgress}
                  subagentPrompts={subagentPrompts}
                  subagentBlocks={subagentBlocks}
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
      <div className="shrink-0 z-10 w-full bg-background py-3">
        {footerSlot}
      </div>
    </div>
  );
}
