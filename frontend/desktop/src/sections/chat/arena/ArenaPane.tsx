/* ── ArenaPane — one model's live lane in the split-pane comparison ──── */

import { useMemo, useState } from 'react';
import { Brain, Check, ChevronDown, ChevronRight, Loader2, RotateCcw, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from '../ChatMarkdown';
import { useSessionStream } from '../hooks/useSessionStream';
import { chatRuntime } from '../chat-runtime';
import { formatTokenCount } from '../message/token-display';
import type { ChatMessage, MessageBlock } from '@/types/chat';
import type { ArenaRunLane } from './arena-store';

function LaneBlocks({ message }: { message: ChatMessage }) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const blocks = message.blocks ?? [];

  const thinking = blocks.filter((b) => b.type === 'thinking' && b.content?.trim());
  const finalBlock = [...blocks].reverse().find(
    (b): b is MessageBlock & { content: string } =>
      b.type === 'finalOutput' && !!b.content?.trim(),
  );
  const errorBlock = blocks.find((b) => b.type === 'error');

  if (errorBlock) {
    return (
      <div
        role="alert"
        className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300"
        data-testid="arena-pane-error"
      >
        ⚠ {errorBlock.content || 'Generation failed.'}
      </div>
    );
  }

  const body = finalBlock ? finalBlock.content : message.content;

  return (
    <div className="space-y-2">
      {thinking.length > 0 ? (
        <div className="rounded border border-border bg-muted/30">
          <button
            type="button"
            onClick={() => setThinkingOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-muted-foreground hover:text-foreground"
            aria-expanded={thinkingOpen}
          >
            {thinkingOpen ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            Thinking ({thinking.length})
          </button>
          {thinkingOpen ? (
            <div className="px-3 pb-2 text-[11px] text-muted-foreground whitespace-pre-wrap max-h-48 overflow-y-auto">
              {thinking.map((b) => b.content).join('\n\n')}
            </div>
          ) : null}
        </div>
      ) : null}
      {body?.trim() ? (
        <Markdown content={body} variant="assistant" />
      ) : null}
      {!body?.trim() && thinking.length === 0 && !errorBlock ? (
        <p className="text-[11px] text-muted-foreground animate-pulse">Waiting for answer…</p>
      ) : null}
    </div>
  );
}

export function ArenaPane({
  lane,
  onPickWinner,
  onStop,
  onRestart,
}: {
  lane: ArenaRunLane;
  onPickWinner: (lane: ArenaRunLane) => void;
  /** Stop this lane's stream (A2). */
  onStop?: (lane: ArenaRunLane) => void;
  /** Re-ask the prompt on this lane (A2). */
  onRestart?: (lane: ArenaRunLane) => void;
}) {
  const streamState = useSessionStream(lane.uiSessionId);
  const streaming = chatRuntime.isSessionStreaming(lane.uiSessionId);
  const messages = streamState.messages ?? [];

  const lastAssistant = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'assistant'),
    [messages],
  );
  const usage = lastAssistant?.usage;
  const done = !streaming && !!lastAssistant && !lastAssistant.blocks?.some((b) => b.type === 'error');

  return (
    <div
      className="flex flex-col rounded-xl border border-border bg-card/60 min-h-64"
      data-testid={`arena-pane-${lane.modelId}`}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Brain className="size-3.5 text-primary shrink-0" />
        <span className="text-xs font-medium truncate">{lane.modelName}</span>
        <span className="text-[10px] text-muted-foreground truncate max-w-28">
          {lane.provider}
        </span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {streaming ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-sky-400">
              <Loader2 className="size-3 animate-spin" />
              streaming
            </span>
          ) : (
            <span
              className={cn(
                'text-[10px]',
                done ? 'text-success' : 'text-muted-foreground',
              )}
            >
              {done ? 'done' : 'idle'}
            </span>
          )}
          {usage && (usage.inputTokens > 0 || usage.outputTokens > 0) ? (
            <span
              className="text-[10px] text-muted-foreground"
              title={`Input ${usage.inputTokens.toLocaleString()} · Output ${usage.outputTokens.toLocaleString()} tokens`}
            >
              {formatTokenCount(usage.inputTokens + usage.outputTokens)} tok
            </span>
          ) : null}
          {streaming && onStop ? (
            <button
              type="button"
              onClick={() => onStop(lane)}
              className="p-1 rounded text-muted-foreground hover:text-danger"
              title="Stop this lane"
              data-testid={`arena-stop-${lane.modelId}`}
            >
              <Square className="size-3" />
            </button>
          ) : null}
          {!streaming && onRestart ? (
            <button
              type="button"
              onClick={() => onRestart(lane)}
              className="p-1 rounded text-muted-foreground hover:text-primary"
              title="Re-ask this prompt on this lane"
              data-testid={`arena-restart-${lane.modelId}`}
            >
              <RotateCcw className="size-3" />
            </button>
          ) : null}
        </span>
      </div>
      <div className="flex-1 px-3 py-2.5 overflow-y-auto min-h-0">
        {lastAssistant ? (
          <LaneBlocks message={lastAssistant} />
        ) : (
          <p className="text-[11px] text-muted-foreground animate-pulse">Starting lane…</p>
        )}
      </div>
      <div className="border-t border-border px-3 py-2 flex justify-end">
        <button
          type="button"
          disabled={streaming}
          className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-2.5 py-1.5 text-[11px] text-primary hover:bg-primary/25 disabled:opacity-40 transition"
          title={
            streaming
              ? 'Wait for the lane to finish'
              : 'Continue this chat with this answer'
          }
          data-testid={`arena-pick-${lane.modelId}`}
          onClick={() => onPickWinner(lane)}
        >
          <Check className="size-3" />
          Use this answer
        </button>
      </div>
    </div>
  );
}
