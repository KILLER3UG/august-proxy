/* ── PlanProposalBanner ─ chat-bottom plan proposal actions ───────── */
/*                                                                          */
/* Visual language mirrors the in-composer dropdowns (EffortDropdown,      */
/* WorkbenchModeSelector): rounded-xl panel, bg-card surface, border       */
/* border-border, p-1.5/2 padding, text-xs items with rounded-md hover.    */

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, Send, X, PencilLine } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkbenchSession } from '@/types/workbench';

export interface PlanProposalBannerProps {
  workbenchSession: WorkbenchSession | null;
  /** Display name of the model that proposed the plan (e.g. "Opus 4.7"). */
  modelName?: string;
  /** Open the plan section in the right drawer. */
  onOpenPlan: () => void;
  /**
   * "Accept" — approve the plan and acknowledge it to the model. The model
   * is told the plan is accepted but should NOT proceed with implementation
   * yet; it waits for the next instruction.
   */
  onAccept: () => void | Promise<void>;
  /**
   * "Accept and allow edits" — approve the plan AND instruct the model to
   * proceed with implementation at Full access.
   */
  onAcceptAndImplement: () => void | Promise<void>;
  /** Reject the plan (clears it). */
  onReject: () => void | Promise<void>;
  /** Send a revision request as a chat message so the model revises the plan. */
  onRevise: (feedback: string) => void | Promise<void>;
  /** Optional: whether a chat send is in flight (disables buttons). */
  sending?: boolean;
}

export function PlanProposalBanner({
  workbenchSession,
  modelName,
  onOpenPlan,
  onAccept,
  onAcceptAndImplement,
  onReject,
  onRevise,
  sending,
}: PlanProposalBannerProps) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const plan = workbenchSession?.plan;
  const approved = workbenchSession?.approved || !!workbenchSession?.approvedAt;

  useEffect(() => {
    if (revising) {
      // Focus the textarea after the animation opens.
      const id = setTimeout(() => textareaRef.current?.focus(), 80);
      return () => clearTimeout(id);
    }
  }, [revising]);

  if (!plan || approved) return null;

  const modelLabel = modelName?.trim() || 'The model';

  const submitRevision = async () => {
    const text = feedback.trim();
    if (!text || sending) return;
    await onRevise(text);
    setFeedback('');
    setRevising(false);
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-2">
      <div className="rounded-xl border border-border bg-card p-3 shadow-2xl">
        {/* Top row: title + open plan link — matches dropdown header style */}
        <div className="flex items-center justify-between gap-3 px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground/90">
            <span className="truncate">
              <span className="font-semibold">{modelLabel}</span> proposed a plan
            </span>
          </div>
          <button
            type="button"
            onClick={onOpenPlan}
            className="text-[11px] font-semibold text-primary hover:underline shrink-0"
          >
            Open plan
          </button>
        </div>

        {/* Revise textarea — collapsible with the same animation language as the
            dropdowns in ChatComposer. */}
        <AnimatePresence initial={false}>
          {revising && (
            <motion.div
              key="revise"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <textarea
                ref={textareaRef}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void submitRevision();
                  } else if (e.key === 'Escape') {
                    setRevising(false);
                    setFeedback('');
                  }
                }}
                placeholder="What would you like to change? (Enter to send, Shift+Enter for newline, Esc to cancel)"
                rows={3}
                className={cn(
                  'w-full resize-none rounded-md border border-border bg-muted',
                  'px-2.5 py-2 mt-1 text-xs text-foreground placeholder:text-muted-foreground/60',
                  'outline-none focus:border-primary/60 transition',
                )}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Action row — same `rounded-md text-xs` button styling as the
            dropdown menu items so the banner feels like part of the same
            control family. */}
        <div className="mt-2 flex items-center gap-1">
          <BannerButton onClick={onReject} disabled={sending}>
            <X className="size-3" />
            Reject
          </BannerButton>

          <BannerButton
            active={revising}
            onClick={() => {
              if (revising) {
                setRevising(false);
                setFeedback('');
              } else {
                setRevising(true);
              }
            }}
            disabled={sending}
          >
            {revising ? <Check className="size-3" /> : <PencilLine className="size-3" />}
            {revising ? 'Cancel' : 'Revise…'}
          </BannerButton>

          {revising ? (
            <BannerButton
              primary
              onClick={submitRevision}
              disabled={sending || !feedback.trim()}
              className="ml-auto"
            >
              <Send className="size-3" />
              Send
              <kbd className="ml-1 rounded bg-primary-foreground/10 px-1 text-[9.5px] font-mono">↵</kbd>
            </BannerButton>
          ) : (
            <>
              <BannerButton onClick={onAccept} disabled={sending}>
                Accept
              </BannerButton>
              <BannerButton primary onClick={onAcceptAndImplement} disabled={sending} className="ml-auto">
                Accept and allow edits
                <kbd className="ml-1 rounded bg-primary-foreground/10 px-1 text-[9.5px] font-mono">Ctrl ↵</kbd>
              </BannerButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── BannerButton ─ dropdown-styled action button ─────────────────── */

function BannerButton({
  children,
  onClick,
  disabled,
  active,
  primary,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  primary?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium',
        'px-2 py-1.5 transition-colors',
        primary
          ? 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50'
          : active
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        className,
      )}
    >
      {children}
    </button>
  );
}
