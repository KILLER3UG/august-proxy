/* ── WorkingIndicator ─────────────────────────────────────────────────── */
/* Shown above the composer while a turn streams. Two parts:              */
/*   • the AUG wordmark (kept for identity),                              */
/*   • a progressive sentence stack pulled from the session's live        */
/*     activity store — every finished step ("Read x", "Ran tests",       */
/*     "Edited y") renders as its own line, newest at the bottom,         */
/*     older lines dimming away Claude-style. While the model is          */
/*     between steps the last line carries animated ellipsis dots.        */

import { useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useLiveActivityStore } from '@/store/liveActivity';
import { resolveUiSessionId } from '@/sections/chat/stream/session-id-map';

interface WorkingIndicatorProps {
  className?: string;
  /** Live session key — subscribes to that session's activity feed. */
  sessionId?: string | null;
}

/** Sentences visible at once (oldest fade out above). */
const MAX_LINES = 3;

function trimLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 96 ? `${t.slice(0, 94)}…` : t;
}

function AugWordmark() {
  const LETTERS = ['A', 'U', 'G', 'U', 'S', 'T'];
  return (
    <span className="flex items-center justify-center gap-[3px]">
      {LETTERS.map((letter, i) => (
        <span
          key={i}
          className="aug-letter text-[11px] font-semibold tracking-[0.18em] text-muted-foreground/80"
          style={{ animationDelay: `${i * 0.12}s` }}
        >
          {letter}
        </span>
      ))}
      <span className="aug-caret ml-0.5 text-[11px] font-semibold text-primary/70">|</span>
    </span>
  );
}

function Dots({ tone = 'text-muted-foreground/70' }: { tone?: string }) {
  return (
    <span className={`ml-0.5 inline-flex items-baseline ${tone}`} data-testid="typing-dots">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="text-[12px] leading-none"
          animate={{ opacity: [0.15, 0.9, 0.15] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.22, ease: 'easeInOut' }}
        >
          .
        </motion.span>
      ))}
    </span>
  );
}

export function WorkingIndicator({ className, sessionId }: WorkingIndicatorProps) {
  // The activity store is keyed by UI session id; the pane may hand us a
  // wb_* route id, so normalize before subscribing.
  const uiKey = sessionId ? resolveUiSessionId(sessionId) : null;
  // Raw slice subscription (stable reference) — deriving in a zustand
  // selector would allocate a fresh object per tick and loop re-renders.
  const entry = useLiveActivityStore((s) => (uiKey ? s.bySession[uiKey] : undefined));

  // Newest-last sentence list: one line per activity item, consecutive and
  // earlier duplicates collapse (a retried tool replaces its old line).
  const lines = useMemo(() => {
    const items = entry?.items ?? [];
    const out: string[] = [];
    for (const item of items) {
      const base = item.status === 'error' ? `${item.label} — failed` : item.label;
      const detail = (item.detail || '').split('\n')[0];
      const line = trimLine(detail && detail !== item.label ? `${base} · ${detail}` : base);
      if (!line) continue;
      const dupIdx = out.lastIndexOf(line);
      if (dupIdx >= 0) out.splice(dupIdx, 1);
      out.push(line);
    }
    return out.slice(-MAX_LINES);
  }, [entry]);

  const idle = lines.length === 0;
  const execution = entry?.execution;

  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-label="Assistant is working"
      data-aug-indicator
    >
      <div className="flex flex-col items-center gap-0.5 py-0.5">
        <AugWordmark />
        {execution ? (
          <div
            className="rounded-full border border-primary/25 bg-primary/10 px-2 py-px text-[10px] font-medium uppercase tracking-wide text-primary"
            data-testid="working-phase"
          >
            {execution.phase}
            {execution.step > 0 ? ` · step ${execution.step}` : ''}
          </div>
        ) : null}
        <div className="w-full max-w-xl" data-testid="working-lines">
          <AnimatePresence initial={false} mode="popLayout">
            {idle ? (
              <motion.div
                key="idle-line"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-baseline justify-center gap-1 text-[11.5px] italic leading-4 text-muted-foreground/70"
              >
                <span>Thinking</span>
                <Dots />
              </motion.div>
            ) : (
              lines.map((line, i) => {
                const isLast = i === lines.length - 1;
                return (
                  <motion.div
                    key={`${i}-${line}`}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{
                      opacity: isLast ? 0.95 : Math.max(0.28, 0.85 - (lines.length - 1 - i) * 0.3),
                      y: 0,
                    }}
                    exit={{ opacity: 0, y: -3 }}
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className="truncate text-center text-[11.5px] leading-4 text-muted-foreground"
                  >
                    <span>{line}</span>
                    {isLast && <Dots tone="text-primary/60" />}
                  </motion.div>
                );
              })
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
