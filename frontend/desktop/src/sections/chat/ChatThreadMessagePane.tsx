/* ── Thread message pane ───────────────────────────────────────────────── */
/* Scrollable message list, working indicator, scroll affordances, and the */
/* sticky composer / plan banner strip under the transcript.               */

import type { ReactNode, RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { ScrollToTopButton } from '@/components/chat/ScrollToTopButton';
import { WorkingIndicator } from '@/components/chat/WorkingIndicator';
import { MessageBubble } from './MessageBubble';
import { ModelPickerCard } from './ModelPickerCard';
import { VirtualizedMessageList } from './VirtualizedMessageList';
import type { ChatMessage } from '@/types/chat';
import type { SubagentPromptMap } from './hooks/useSessionStream';
import type { SubagentBlockState } from './chat-stream-manager';

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
  scrollRef: RefObject<HTMLDivElement | null>;
  onScrollToBottom: () => void;
  onRevert: (index: number) => void;
  onEdit: (index: number, text: string) => void;
  onRegenerate: (index: number) => void | Promise<void>;
  onClarifyAnswer: (msgId: string, answer: string) => void;
  /** Composer or plan banner under the list. */
  footerSlot: ReactNode;
}) {
  return (
    <motion.div
      key="thread-scroll-view"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="flex-1 flex flex-col min-h-0 relative"
    >
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto chat-scroll"
        style={{ overflowAnchor: 'none' }}
      >
        <VirtualizedMessageList
          messages={messages}
          scrollParentRef={scrollRef}
          renderMessage={(m, realIndex) => {
            const isReverting =
              revertingIndex !== null && realIndex > revertingIndex;
            return (
              <div
                className={cn(
                  'transition-all duration-300 transform',
                  isReverting
                    ? 'opacity-0 -translate-y-4 pointer-events-none'
                    : 'opacity-100 translate-y-0',
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
              </div>
            );
          }}
          footer={
            <>
              {streaming && (
                <WorkingIndicator key={`aug-${sessionId ?? 'none'}`} />
              )}
              {modelPickerActive && (
                <ModelPickerCard
                  sessionId={sessionId ?? ''}
                  onDismiss={onDismissModelPicker}
                  context={{ currentModelId: selectedModelId }}
                />
              )}
            </>
          }
        />

        <div className="sticky bottom-4 z-30 flex flex-col gap-2 items-end pointer-events-none">
          <ScrollToTopButton
            scrollParentRef={scrollRef}
            visible={scrolledFromTop}
          />
          <AnimatePresence>
            {scrolledFromBottom && (
              <motion.button
                type="button"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.2 }}
                onClick={onScrollToBottom}
                className="pointer-events-auto mr-3 w-9 h-9 flex items-center justify-center rounded-full bg-background/80 backdrop-blur-sm border border-border shadow-sm text-muted-foreground hover:text-foreground hover:bg-background/95 transition-colors cursor-pointer"
                aria-label="Scroll to bottom"
              >
                <ChevronDown className="size-4" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Plan banner replaces the composer while a plan awaits a decision. */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className="shrink-0 z-10 w-full bg-background py-3"
      >
        {footerSlot}
      </motion.div>
    </motion.div>
  );
}
