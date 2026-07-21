/**
 * SubagentDetailModal — Cursor-style expanded subagent card (modal).
 *
 * Header → prompt box → "Worked for …" → findings → follow-up bar with
 * a real model dropdown (chevron), matching the main composer picker.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';
import { Check, ChevronDown, Maximize2, Minimize2, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn, fmtElapsed } from '@/lib/utils';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';
import { Backdrop } from '@/components/overlays/Backdrop';
import { SubagentTimeline } from '@/components/chat/SubagentTimeline';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import type { SubagentPromptEntry } from '@/components/chat/subagent-tools';
import { queueWorkbenchMessage } from '@/api/workbench';
import {
  dispatchFocusComposer,
  dispatchInsertComposerText,
} from '@/api/ui-events';
import {
  resolveUiSessionId,
  resolveWorkbenchSessionId,
} from '@/sections/chat/stream/session-id-map';
import { useChatModels } from '@/sections/chat/hooks/useChatModels';
import {
  getModelDisplayName,
  type ModelItem,
} from '@/sections/chat/model-display';
import { menuItemHover, menuPanel } from '@/lib/motion';
import { AnimatePresence, motion } from 'framer-motion';

interface SubagentDetailModalProps {
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

function shortModelLabel(model: ModelItem | null, fallback?: string): string {
  if (model) {
    const name = getModelDisplayName(model.id) || model.name || model.id;
    return name.length > 28 ? `${name.slice(0, 26)}…` : name;
  }
  if (fallback) {
    return fallback.length > 28 ? `${fallback.slice(0, 26)}…` : fallback;
  }
  return 'Model';
}

/** Compact model dropdown for the subagent follow-up bar. */
function FollowUpModelPicker({
  selected,
  models,
  onSelect,
}: {
  selected: ModelItem | null;
  models: ModelItem[];
  onSelect: (m: ModelItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      bottom: Math.max(8, window.innerHeight - r.top + 6),
      right: Math.max(8, window.innerWidth - r.right),
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setPos(place());
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, place]);

  const label = shortModelLabel(selected);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 max-w-[180px] items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground transition"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="subagent-followup-model"
        title={selected?.id || label}
      >
        <span className="truncate">{label}</span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 opacity-60 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open && pos && (
              <motion.div
                ref={panelRef}
                {...menuPanel}
                className="fixed z-[70] w-[260px] max-h-[280px] overflow-y-auto rounded-xl border border-border/60 bg-popover shadow-2xl origin-bottom"
                style={{ bottom: pos.bottom, right: pos.right }}
                role="listbox"
                aria-label="Follow-up model"
              >
                <div className="py-1">
                  {models.length === 0 ? (
                    <div className="px-3 py-2 text-[12px] text-muted-foreground">
                      No models available
                    </div>
                  ) : (
                    models.slice(0, 40).map((m) => {
                      const active = selected?.id === m.id;
                      const name = getModelDisplayName(m.id) || m.name || m.id;
                      return (
                        <button
                          key={`${m.provider}:${m.id}`}
                          type="button"
                          role="option"
                          aria-selected={active}
                          {...menuItemHover}
                          onClick={() => {
                            onSelect(m);
                            setOpen(false);
                          }}
                          className={cn(
                            'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] transition',
                            active
                              ? 'bg-muted/40 text-foreground'
                              : 'text-foreground/85 hover:bg-muted/30',
                          )}
                        >
                          <span className="min-w-0 truncate">{name}</span>
                          {active ? (
                            <Check className="size-3.5 shrink-0" />
                          ) : (
                            <span className="size-3.5 shrink-0" />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
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
  const [followUp, setFollowUp] = useState('');
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const params = useParams<{ sessionId?: string }>();
  const { selectedModel, visibleModels, selectModel } = useChatModels(
    params.sessionId || null,
    null,
  );
  const title = state.task?.trim() || getAgentRoleLabel(state.agentId);
  const promptText = useMemo(
    () => resolvePromptText(state, subPrompts),
    [state, subPrompts],
  );
  const isRunning = state.status === 'running';

  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [isRunning]);

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

  const elapsedMs = Math.max(
    0,
    (state.finishedAt || now) - (state.startedAt || now),
  );
  const workedLabel = isRunning
    ? `Working · ${fmtElapsed(elapsedMs)}`
    : `Worked for ${fmtElapsed(elapsedMs)}`;

  const sendFollowUp = async () => {
    const text = followUp.trim();
    if (!text || sending) return;
    setSending(true);
    const modelTag = selectedModel
      ? getModelDisplayName(selectedModel.id) || selectedModel.name
      : modelLabel || '';
    const framed =
      `Follow-up for subagent "${title}"` +
      (state.jobId ? ` (${state.jobId})` : '') +
      (modelTag ? ` [model: ${modelTag}]` : '') +
      `:\n\n${text}`;
    try {
      const uiSession = resolveUiSessionId(params.sessionId || '');
      const wbId =
        resolveWorkbenchSessionId(uiSession || params.sessionId || '') ||
        params.sessionId ||
        '';
      if (wbId) {
        await queueWorkbenchMessage(wbId, framed, undefined, 'queue');
        toast.success('Follow-up queued');
        setFollowUp('');
        onClose();
      } else {
        dispatchInsertComposerText(framed);
        dispatchFocusComposer();
        toast.message('Follow-up inserted in composer');
        setFollowUp('');
        onClose();
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not send follow-up',
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <Backdrop onClose={onClose} className="z-[60]">
      <div
        className={cn(
          'relative flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-2xl',
          maximized
            ? 'h-[min(92vh,920px)] w-[min(96vw,980px)]'
            : 'max-h-[min(84vh,760px)] w-[min(94vw,720px)]',
        )}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="subagent-detail-modal"
        data-subagent-status={state.status}
      >
        <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 shrink-0">
          <h2 className="min-w-0 text-[15px] font-semibold tracking-tight text-foreground leading-snug">
            {title}
          </h2>
          <div className="flex shrink-0 items-center gap-0.5">
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

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 space-y-3">
          {promptText ? (
            <div
              className="rounded-xl border border-white/[0.06] bg-black/25 px-3.5 py-3 text-[13px] leading-relaxed text-foreground/85 max-h-40 overflow-y-auto"
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
            modelLabel={
              selectedModel
                ? getModelDisplayName(selectedModel.id) || selectedModel.name
                : modelLabel
            }
            onOpenAgent={onOpenAgent}
            hideTaskPrompt
          />
        </div>

        <footer className="shrink-0 border-t border-border/50 px-4 py-3">
          <div className="flex items-end gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2">
            <textarea
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendFollowUp();
                }
              }}
              rows={1}
              placeholder="+ Send follow-up with subagent"
              className="min-h-[28px] max-h-24 flex-1 resize-none bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/55 outline-none py-1"
              data-testid="subagent-followup-input"
              aria-label="Send follow-up with subagent"
            />
            <div className="flex shrink-0 items-center gap-1 pb-0.5">
              <FollowUpModelPicker
                selected={selectedModel}
                models={visibleModels.length > 0 ? visibleModels : []}
                onSelect={(m) => selectModel(m)}
              />
              <button
                type="button"
                onClick={() => void sendFollowUp()}
                disabled={!followUp.trim() || sending}
                className={cn(
                  'inline-flex size-7 items-center justify-center rounded-md transition',
                  followUp.trim()
                    ? 'bg-foreground text-background hover:opacity-90'
                    : 'text-muted-foreground/40',
                )}
                title="Send follow-up"
                aria-label="Send follow-up"
                data-testid="subagent-followup-send"
              >
                <Send className="size-3.5" />
              </button>
            </div>
          </div>
        </footer>
      </div>
    </Backdrop>
  );
}
