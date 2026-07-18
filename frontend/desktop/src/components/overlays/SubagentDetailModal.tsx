/**
 * SubagentDetailModal — view-only detail for a launched subagent.
 * Live thinking/tools while running; final response when settled.
 */

import { useEffect, useState } from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';
import { Backdrop } from '@/components/overlays/Backdrop';
import { SubagentTimeline } from '@/components/chat/SubagentTimeline';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import type { SubagentPromptEntry } from '@/components/chat/subagent-tools';

interface SubagentDetailModalProps {
  state: SubagentBlockState;
  subBlocks?: Map<string, SubagentBlockState>;
  subPrompts?: Map<string, SubagentPromptEntry>;
  modelLabel?: string;
  onClose: () => void;
  onOpenAgent?: (jobId: string) => void;
}

export function SubagentDetailModal({
  state,
  subBlocks,
  subPrompts,
  modelLabel,
  onClose,
  onOpenAgent,
}: SubagentDetailModalProps) {
  const [maximized, setMaximized] = useState(false);
  const title = state.task?.trim() || getAgentRoleLabel(state.agentId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <Backdrop onClose={onClose} className="z-[60]">
      <div
        className={cn(
          'relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl',
          maximized
            ? 'h-[min(92vh,900px)] w-[min(96vw,960px)]'
            : 'max-h-[min(80vh,720px)] w-[min(92vw,640px)]',
        )}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="subagent-detail-modal"
        data-subagent-status={state.status}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-4 shrink-0">
          <h2 className="min-w-0 text-[15px] font-medium tracking-tight text-foreground leading-snug">
            {title}
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setMaximized((v) => !v)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition"
              title={maximized ? 'Restore' : 'Maximize'}
              aria-label={maximized ? 'Restore' : 'Maximize'}
            >
              {maximized ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition"
              title="Close"
              aria-label="Close"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <SubagentTimeline
            state={state}
            subBlocks={subBlocks}
            subPrompts={subPrompts}
            modelLabel={modelLabel}
            onOpenAgent={onOpenAgent}
          />
        </div>
      </div>
    </Backdrop>
  );
}
