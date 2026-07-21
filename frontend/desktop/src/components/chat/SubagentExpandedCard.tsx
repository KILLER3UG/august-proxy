/**
 * SubagentExpandedCard — inline Cursor-style expanded subagent panel.
 * Lives in the chat flow (not a centered modal). Maximize opens the
 * full detail modal; close returns to the checklist.
 */

import { useEffect, useMemo, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import { cn, fmtElapsed } from '@/lib/utils';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';
import { SubagentTimeline } from '@/components/chat/SubagentTimeline';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import type { SubagentPromptEntry } from '@/components/chat/subagent-tools';
import { SubagentDetailModal } from '@/components/overlays/SubagentDetailModal';
import { dispatchFocusComposer } from '@/api/ui-events';
import { setFocusedSubagent } from '@/components/chat/focused-subagent';

interface SubagentExpandedCardProps {
  state: SubagentBlockState;
  subBlocks?: Map<string, SubagentBlockState>;
  subPrompts?: Map<string, SubagentPromptEntry>;
  modelLabel?: string;
  onClose: () => void;
  onOpenAgent?: (jobId: string) => void;
}

function resolvePromptText(
  state: SubagentBlockState,
  subPrompts?: Map<string, SubagentPromptEntry>,
): string {
  if (subPrompts) {
    for (const entry of subPrompts.values()) {
      if (entry.jobId && entry.jobId === state.jobId) {
        return (
          entry.userMessage?.trim() ||
          entry.content?.trim() ||
          state.task?.trim() ||
          ''
        );
      }
      if (entry.subagentId && entry.subagentId === state.agentId) {
        const text =
          entry.userMessage?.trim() || entry.content?.trim() || '';
        if (text) return text;
      }
    }
  }
  return state.task?.trim() || '';
}

export function SubagentExpandedCard({
  state,
  subBlocks,
  subPrompts,
  modelLabel,
  onClose,
  onOpenAgent,
}: SubagentExpandedCardProps) {
  const [popOut, setPopOut] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const title = state.task?.trim() || getAgentRoleLabel(state.agentId);
  const promptText = useMemo(
    () => resolvePromptText(state, subPrompts),
    [state, subPrompts],
  );
  const isRunning = state.status === 'running';

  useEffect(() => {
    setFocusedSubagent({ jobId: state.jobId, title });
    dispatchFocusComposer();
    return () => setFocusedSubagent(null);
  }, [state.jobId, title]);

  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [isRunning]);

  const elapsedMs = Math.max(
    0,
    (state.finishedAt || now) - (state.startedAt || now),
  );
  const workedLabel = isRunning
    ? `Working · ${fmtElapsed(elapsedMs)}`
    : `Worked for ${fmtElapsed(elapsedMs)}`;

  return (
    <>
      <div
        className={cn(
          'mt-2 rounded-xl border border-border/50 bg-muted/20 overflow-hidden',
          'shadow-sm',
        )}
        data-slot="subagent-expanded-card"
        data-testid="subagent-expanded-card"
        data-subagent-status={state.status}
      >
        <header className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
          <h3 className="min-w-0 text-[14px] font-semibold tracking-tight text-foreground leading-snug">
            {title}
          </h3>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setPopOut(true)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition"
              title="Open in modal"
              aria-label="Open in modal"
            >
              <Maximize2 className="size-3.5" />
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

        <div className="px-4 pb-4 space-y-3">
          {promptText ? (
            <div
              className="rounded-lg border border-white/[0.05] bg-black/20 px-3 py-2.5 text-[13px] leading-relaxed text-foreground/85 max-h-36 overflow-y-auto"
              data-slot="subagent-prompt-box"
            >
              <pre className="m-0 whitespace-pre-wrap break-words font-sans">
                {promptText}
              </pre>
            </div>
          ) : null}

          <div
            className="text-[12px] text-muted-foreground/70"
            data-slot="subagent-worked-for"
          >
            {workedLabel}
          </div>

          <SubagentTimeline
            state={state}
            subBlocks={subBlocks}
            subPrompts={subPrompts}
            modelLabel={modelLabel}
            onOpenAgent={onOpenAgent}
            hideTaskPrompt
          />
        </div>
      </div>

      {popOut ? (
        <SubagentDetailModal
          state={state}
          subBlocks={subBlocks}
          subPrompts={subPrompts}
          modelLabel={modelLabel}
          onClose={() => setPopOut(false)}
          onOpenAgent={onOpenAgent}
        />
      ) : null}
    </>
  );
}
