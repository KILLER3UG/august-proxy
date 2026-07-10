/* ── ClarifyTool ─ floating question/answer popup ────────────────── */
/* Lifted from an inline panel into a centered floating card matching   */
/* the ZCode reference:                                                   */
/*   • fixed-position overlay with dark backdrop                        */
/*   • top: synthesized-context breadcrumb + pagination arrows + X      */
/*   • question in larger text                                          */
/*   • numbered choice badges (1, 2, 3, 4) in 22×22 rounded-md          */
/*   • "Something else" input + Skip button (bottom row)                 */
/*   • footer hint: "A. tap a number · Enter to send · Esc to close"    */
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
import { ChevronLeft, ChevronRight, X, Paperclip, SkipForward } from 'lucide-react';
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
  /** Optional title override; defaults to "What would you like to do next?" */
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
  const inputRef = useRef<HTMLInputElement | null>(null);

  const current = questions[currentIndex];
  const isLast = currentIndex === totalQuestions - 1;

  // Keyboard: Esc / ← / → / 1-9
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (submitting) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDismiss();
        return;
      }
      // Don't hijack typing in the input
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Enter' && (e.target as HTMLElement) === inputRef.current) {
          e.preventDefault();
          submitFreeform();
        }
        return;
      }
      if (e.key === 'ArrowLeft' && currentIndex > 0) {
        e.preventDefault();
        setCurrentIndex(i => i - 1);
        setSelectedChoice(null);
        setDraft('');
      } else if (e.key === 'ArrowRight' && currentIndex < totalQuestions - 1) {
        e.preventDefault();
        setCurrentIndex(i => i + 1);
        setSelectedChoice(null);
        setDraft('');
      } else if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (current.choices && idx < current.choices.length) {
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
        // Submit a structured record for multi-question (so the model can
        // see the answers indexed), or the plain string for single-question.
        onSubmit(totalQuestions === 1 ? choice : JSON.stringify(next));
      } else {
        // Advance to the next question after a brief delay so the user
        // can see the selection highlight first.
        window.setTimeout(() => {
          setCurrentIndex(i => Math.min(totalQuestions - 1, i + 1));
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
      // Default behaviour: tell the model to proceed
      onSubmit('User skipped');
    }
  }, [onDismiss, onSubmit]);

  if (!current || !current.question) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-label="Clarification"
    >
      <div
        className="w-full max-w-md rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200"
        style={{ backgroundColor: '#1c1c1c', border: '0.5px solid rgba(255,255,255,0.07)' }}
      >
        {/* Top row: context breadcrumb + pagination + X close */}
        <div className="flex items-center justify-between px-4 pt-3 pb-1 text-[11.5px]">
          <button
            type="button"
            onClick={() => {/* TODO: open the full context summary */}}
            className="text-muted-foreground hover:text-foreground truncate text-left flex-1 min-w-0"
          >
            {contextSummary ?? title ?? 'Synthesized user context to craft a personalized response'} <span aria-hidden>›</span>
          </button>
          <div className="flex items-center gap-1.5 ml-2 shrink-0 text-muted-foreground">
            {totalQuestions > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => { setCurrentIndex(i => Math.max(0, i - 1)); setSelectedChoice(null); setDraft(''); }}
                  disabled={currentIndex === 0}
                  className="p-0.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label="Previous question"
                >
                  <ChevronLeft size={14} />
                </button>
                <span className="font-mono tabular-nums text-[11px]">
                  {currentIndex + 1} of {totalQuestions}
                </span>
                <button
                  type="button"
                  onClick={() => { setCurrentIndex(i => Math.min(totalQuestions - 1, i + 1)); setSelectedChoice(null); setDraft(''); }}
                  disabled={isLast}
                  className="p-0.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label="Next question"
                >
                  <ChevronRight size={14} />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={handleDismiss}
              className="p-0.5 rounded hover:bg-white/10 ml-1"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Question */}
        <div className="px-4 pt-2 pb-3">
          <h2 className="text-[15px] font-medium leading-snug text-foreground">
            {current.question}
          </h2>
        </div>

        {/* Numbered choice list */}
        {current.choices && current.choices.length > 0 && (
          <div className="px-3 pb-1">
            {current.choices.map((choice, i) => (
              <button
                type="button"
                key={`${currentIndex}-${i}-${choice}`}
                onClick={() => pickChoice(choice)}
                disabled={submitting}
                className={cn(
                  'w-full flex items-center gap-3 px-1 py-2 text-left text-[13.5px] text-foreground/90',
                  'hover:bg-white/[0.04] rounded-md transition-colors',
                  'border-b border-white/[0.04] last:border-b-0',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  selectedChoice === choice && 'bg-white/[0.06]'
                )}
                data-clarify-choice
              >
                <span
                  aria-hidden
                  className="grid size-[22px] shrink-0 place-items-center rounded-md text-[11px] font-medium tabular-nums"
                  style={{ backgroundColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.55)' }}
                >
                  {i + 1}
                </span>
                <span className="flex-1 wrap-anywhere">{choice}</span>
              </button>
            ))}
          </div>
        )}

        {/* Bottom: "Something else" input + Skip */}
        <form onSubmit={handleSubmit} className="flex items-center gap-2 px-3 py-3 border-t border-white/[0.06]">
          <Paperclip aria-hidden size={12} className="text-muted-foreground/60 shrink-0" />
          <span className="text-[12px] text-muted-foreground/80 shrink-0">Something else</span>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type your answer…"
            disabled={submitting}
            className="flex-1 min-w-0 bg-transparent text-[12.5px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleDismiss}
            disabled={submitting}
            className="text-[12px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded disabled:opacity-50"
          >
            <SkipForward aria-hidden size={12} className="inline mr-0.5" />
            Skip
          </button>
        </form>

        {/* Footer hint */}
        <div className="px-4 pb-3 text-[10px] text-muted-foreground/50 select-none">
          tap a number · Enter to send · Esc to close
        </div>
      </div>
    </div>
  );
}

/**
 * Thin wrapper for inline use (kept for backward compatibility).
 * Mounts the popup but skips the dark backdrop so it looks embedded.
 */
export function ClarifyToolInline(props: ClarifyToolProps) {
  // Strip the fixed-position overlay; render the card only.
  return (
    <div className="my-2">
      <ClarifyTool {...props} />
    </div>
  );
}
