/**
 * Virtualize long chat threads with @tanstack/react-virtual.
 * Short threads (below threshold) render a plain map to avoid virtualizer overhead.
 * Uses an external scroll parent (ChatThread's scrollRef) so sticky chrome works.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage } from '@/types/chat';
import type { ReactNode, RefObject } from 'react';

const VIRTUALIZE_AFTER = 40;
const ESTIMATE_ROW_PX = 140;

export interface VirtualizedMessageListProps {
  messages: ChatMessage[];
  scrollParentRef: RefObject<HTMLDivElement | null>;
  renderMessage: (message: ChatMessage, index: number) => ReactNode;
  footer?: ReactNode;
}

export function VirtualizedMessageList({
  messages,
  scrollParentRef,
  renderMessage,
  footer,
}: VirtualizedMessageListProps) {
  const useVirt = messages.length >= VIRTUALIZE_AFTER;

  const virt = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ESTIMATE_ROW_PX,
    overscan: 8,
    enabled: useVirt,
  });

  if (!useVirt) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 space-y-5 relative">
        {messages.map((m, i) => (
          <div key={m.id}>{renderMessage(m, i)}</div>
        ))}
        {footer}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 relative" style={{ height: `${virt.getTotalSize() + 80}px` }}>
      {virt.getVirtualItems().map((row) => {
        const m = messages[row.index];
        return (
          <div
            key={m.id}
            data-index={row.index}
            ref={virt.measureElement}
            className="absolute left-0 right-0 px-4"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            {renderMessage(m, row.index)}
          </div>
        );
      })}
      {footer ? (
        <div
          className="absolute left-0 right-0 px-4"
          style={{ transform: `translateY(${virt.getTotalSize()}px)` }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}
