/* ── ClarifyTool ─ plan-banner-style question panel (larger) ───────── */
/* Visual language mirrors PlanProposalBanner: rounded-xl, bg-card,     */
/* border-border, dropdown-family action buttons — but scaled up so the */
/* question is the focus when the model asks the user for input.        */
/*                                                                       */
/* Supports two data shapes (additive, backward compatible):             */
/*   1. legacy single-question:  { question, choices? }                  */
/*   2. new multi-question:      { questions: [{question, choices?}],     */
/*                                currentIndex?, contextSummary? }        */
/*                                                                       */
/* Keyboard:                                                              */
/*   • 1-9    → select the choice at that index                          */
/*   • ← / →  → paginate between questions in a multi-question flow      */
/*   • Enter  → submit the freeform input (when focused)                 */
/*   • Esc    → close (sends a "User skipped" stub to the model)         */

import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, X, Send, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ClarifyQuestion {
  question: string;
  choices?: string[];
}

export interface ClarifyPayload {
  /** Legacy single-question mode. */
  question?: string;
  choices?: string[];
  /** Multi-question mode. Wins over the legacy fields when present. */
  questions?: ClarifyQuestion[];
  /** 0-indexed; managed by the popup. */
  currentIndex?: number;
  /** Header line above the question: "Synthesized user context to craft …". */
  contextSummary?: string;
  /** Already-answered (set on the message after submit). */
  answer?: string;
}

export interface ClarifyToolProps {
  /** Full clarify payload (preferred). */
  payload?: ClarifyPayload;
  /** Legacy convenience props. If `payload` is provided these are ignored. */
  question?: string;
  choices?: string[];
  /** Submit handler. Receives a single string:
   *   • the answer directly, for single-question flows
   *   • a JSON-stringified `{ [questionIndex]: answer }` record, for multi-question
   */
  onSubmit: (answer: string) => void;
  /** Esc / X close — submits a "User skipped" stub so the model knows to proceed. */
  onDismiss?: () => void;
  submitting?: boolean;
  /** Optional title override; defaults to context breadcrumb. */
  title?: string;
}

export function ClarifyTool({
  payload,
  question,
  choices,
  onSubmit,
  onDismiss,
  submitting = false,
  title,
}: ClarifyToolProps) {
  // Normalise to the multi-question shape (legacy single question becomes a 1-item list)
  const questions: ClarifyQuestion[] = payload?.questions && payload.questions.length > 0
    ? payload.questions
    : [{ question: payload?.question ?? question ?? '', choices: payload?.choices ?? choices }];
  const contextSummary = payload?.contextSummary;
  const totalQuestions = questions.length;
  const [currentIndex, setCurrentIndex] = useState(
    Math.max(0, Math.min(totalQuestions - 1, payload?.currentIndex ?? 0))
  );
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [draft, setDraft] = useState('');
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const current = questions[currentIndex];
  const isLast = currentIndex === totalQuestions - 1;

  useEffect(() => {
    // Focus freeform field when the card mounts / question changes
    const id = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(id);
  }, [currentIndex]);

  // Keyboard: Esc / ← / → / 1-9
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (submitting) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDismiss();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        return;
      }
      if (e.key === 'ArrowLeft' && currentIndex > 0) {
        e.preventDefault();
        setCurrentIndex((i) => i - 1);
        setSelectedChoice(null);
        setDraft('');
      } else if (e.key === 'ArrowRight' && currentIndex < totalQuestions - 1) {
        e.preventDefault();
        setCurrentIndex((i) => i + 1);
        setSelectedChoice(null);
        setDraft('');
      } else if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (current.choices && idx < Math.min(current.choices.length, 5)) {
          e.preventDefault();
          pickChoice(current.choices[idx]);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, totalQuestions, current?.choices, submitting]);

  const pickChoice = useCallback(
    (choice: string) => {
      if (submitting) return;
      setSelectedChoice(choice);
      const next = { ...answers, [currentIndex]: choice };
      setAnswers(next);
      if (isLast) {
        onSubmit(totalQuestions === 1 ? choice : JSON.stringify(next));
      } else {
        window.setTimeout(() => {
          setCurrentIndex((i) => Math.min(totalQuestions - 1, i + 1));
          setSelectedChoice(null);
          setDraft('');
        }, 200);
      }
    },
    [answers, currentIndex, isLast, onSubmit, submitting, totalQuestions]
  );

  const submitFreeform = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed || submitting) return;
    const next = { ...answers, [currentIndex]: trimmed };
    if (totalQuestions === 1) onSubmit(trimmed);
    else onSubmit(JSON.stringify(next));
  }, [answers, currentIndex, draft, onSubmit, submitting, totalQuestions]);

  const handleSubmit = useCallback((e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submitFreeform();
  }, [submitFreeform]);

  const handleDismiss = useCallback(() => {
    if (onDismiss) onDismiss();
    else {
      onSubmit('User skipped');
    }
  }, [onDismiss, onSubmit]);

  if (!current || !current.question) return null;

  const headerLabel =
    contextSummary?.trim() ||
    title?.trim() ||
    'A quick question before continuing';

  return (
    <div
      className="mx-auto my-3 w-full max-w-3xl px-2"
      role="dialog"
      aria-modal="false"
      aria-label="Clarification"
      data-slot="clarify-banner"
      data-testid="clarify-banner"
    >
      {/* Same surface language as PlanProposalBanner — scaled up for questions */}
      <div className="rounded-2xl border border-border bg-card p-5 shadow-2xl sm:p-6">
        {/* Top row: title + pagination + close — mirrors plan banner header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/80">
              Clarification needed
            </div>
            <div className="mt-1 truncate text-sm text-muted-foreground" title={headerLabel}>
              {headerLabel}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
            {totalQuestions > 1 && (
              <>
                <BannerButton
                  onClick={() => {
                    setCurrentIndex((i) => Math.max(0, i - 1));
                    setSelectedChoice(null);
                    setDraft('');
                  }}
                  disabled={currentIndex === 0 || submitting}
                  aria-label="Previous question"
                >
                  <ChevronLeft className="size-4" />
                </BannerButton>
                <span className="min-w-[3.5rem] text-center font-mono text-sm tabular-nums text-foreground/80">
                  {currentIndex + 1} / {totalQuestions}
                </span>
                <BannerButton
                  onClick={() => {
                    setCurrentIndex((i) => Math.min(totalQuestions - 1, i + 1));
                    setSelectedChoice(null);
                    setDraft('');
                  }}
                  disabled={isLast || submitting}
                  aria-label="Next question"
                >
                  <ChevronRight className="size-4" />
                </BannerButton>
              </>
            )}
            <BannerButton
              onClick={handleDismiss}
              disabled={submitting}
              aria-label="Close"
              className="ml-1"
            >
              <X className="size-4" />
            </BannerButton>
          </div>
        </div>

        {/* Question — larger than plan banner title so it owns the card */}
        <h2 className="mt-4 text-xl font-semibold leading-snug tracking-tight text-foreground sm:text-2xl">
          {current.question}
        </h2>

        {/* Numbered choice list — big hit targets */}
        {current.choices && current.choices.length > 0 && (
          <div className="mt-5 flex flex-col gap-2" data-clarify-choices>
            {current.choices.slice(0, 5).map((choice, i) => (
              <button
                type="button"
                key={`${currentIndex}-${i}-${choice}`}
                onClick={() => pickChoice(choice)}
                disabled={submitting}
                data-choice
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                  'border-border/70 bg-muted/20 hover:bg-muted/50 hover:border-border',
                  'text-[15px] leading-snug text-foreground/90',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selectedChoice === choice &&
                    'border-primary/50 bg-primary/10 text-foreground',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'grid size-8 shrink-0 place-items-center rounded-lg text-sm font-semibold tabular-nums',
                    selectedChoice === choice
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 wrap-anywhere">{choice}</span>
              </button>
            ))}
          </div>
        )}

        {/* Freeform answer — plan-banner revise textarea language, larger */}
        <form onSubmit={handleSubmit} className="mt-5">
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground/80">
            Something else
          </label>
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitFreeform();
              }
            }}
            placeholder="Type your answer… (Enter to send, Shift+Enter for newline)"
            disabled={submitting}
            rows={3}
            className={cn(
              'w-full resize-none rounded-xl border border-border bg-muted/40',
              'px-3.5 py-3 text-[15px] text-foreground placeholder:text-muted-foreground/55',
              'outline-none transition focus:border-primary/60',
              'disabled:opacity-50',
            )}
          />

          {/* Action row — same control family as PlanProposalBanner, larger padding */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <BannerButton onClick={handleDismiss} disabled={submitting}>
              <SkipForward className="size-3.5" />
              Skip
            </BannerButton>
            <BannerButton
              primary
              type="submit"
              disabled={submitting || !draft.trim()}
              className="ml-auto"
            >
              <Send className="size-3.5" />
              {submitting ? 'Sending…' : 'Send answer'}
              <kbd className="ml-1 rounded bg-primary-foreground/10 px-1 text-[10px] font-mono">
                ↵
              </kbd>
            </BannerButton>
          </div>
        </form>

        <div className="mt-3 select-none text-[11px] text-muted-foreground/55">
          {current.choices && current.choices.length > 0
            ? 'Tap a number key · Enter to send · Esc to skip'
            : 'Enter to send · Esc to skip'}
        </div>
      </div>
    </div>
  );
}

/* ── BannerButton — plan-banner action chrome, slightly larger ─────── */

function BannerButton({
  children,
  onClick,
  disabled,
  active,
  primary,
  className,
  type = 'button',
  'aria-label': ariaLabel,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  primary?: boolean;
  className?: string;
  type?: 'button' | 'submit';
  'aria-label'?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium',
        'px-3 py-2 transition-colors',
        primary
          ? 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50'
          : active
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * Thin wrapper for inline use (kept for backward compatibility).
 * ClarifyTool is already an in-flow banner (not a fixed modal).
 */
export function ClarifyToolInline(props: ClarifyToolProps) {
  return (
    <div className="my-2">
      <ClarifyTool {...props} />
    </div>
  );
}
