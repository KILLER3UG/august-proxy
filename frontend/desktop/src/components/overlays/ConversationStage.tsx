/* ── ConversationStage — the animated chat used by launch + update ───── */
/* Plays a ConversationScript beat-by-beat with a smooth rise-in, a live */
/* status row that reflects the real backend phase, a typing indicator, */
/* and a Skip control. It calls `onDone` once the script has finished — */
/* for launch that is gated on the backend actually being ready, so the */
/* app reveals the moment the real load completes (never a fake wait).  */

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Beat, ConversationScript } from '@/lib/conversations';

const FIRST_MS = 260;
const STEP_MS = 560;
const FAST_MS = 240; // after ready, close out briskly
const HOLD_MS = 720; // linger on the final line before revealing

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 pl-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-1.5 rounded-full bg-muted-foreground/60"
          animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
          transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
        />
      ))}
    </span>
  );
}

function LiveRow({ ready, label, detail }: { ready: boolean; label?: string; detail?: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 text-xs">
      {ready ? (
        <Check className="size-3.5 shrink-0 text-success" aria-hidden />
      ) : (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
      )}
      <span className={cn('font-medium', ready ? 'text-foreground' : 'text-foreground/80')}>
        {ready ? 'Ready' : label || 'Starting'}
      </span>
      {!ready && detail ? (
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">{detail}</span>
      ) : null}
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="mt-2 flex flex-col gap-1.5">
      {items.map((it, i) => (
        <motion.li
          key={i}
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.12 + i * 0.12, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="flex items-start gap-2 text-[12.5px] leading-snug text-foreground/90"
        >
          <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded bg-primary/15 text-[9px] font-bold text-primary">
            ✦
          </span>
          <span className="min-w-0">{it}</span>
        </motion.li>
      ))}
    </ul>
  );
}

function Bubble({
  beat,
  reduced,
  ready,
  liveLabel,
  liveDetail,
}: {
  beat: Beat;
  index?: number;
  reduced: boolean;
  ready: boolean;
  liveLabel?: string;
  liveDetail?: string;
}) {
  const rise = {
    initial: reduced ? { opacity: 1 } : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: reduced ? 0 : 0.42, ease: [0.16, 1, 0.3, 1] as const },
  };

  if (beat.role === 'user') {
    return (
      <motion.div {...rise} className="flex justify-end" data-testid="conv-user">
        <div className="max-w-[80%] rounded-2xl bg-user-bubble px-3.5 py-2 text-[13.5px] leading-snug text-foreground">
          {beat.text}
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div {...rise} className="flex items-start gap-2.5" data-testid="conv-assistant">
      <span
        aria-hidden
        className="mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-[7px] border border-border bg-elevated text-[10px] font-bold text-primary"
      >
        A
      </span>
      <div className="min-w-0 flex-1 pt-0.5 text-[13.5px] leading-relaxed text-foreground/90">
        {beat.text}
        {beat.bullets ? <BulletList items={beat.bullets} /> : null}
        {beat.live ? <LiveRow ready={ready} label={liveLabel} detail={liveDetail} /> : null}
      </div>
    </motion.div>
  );
}

export function ConversationStage({
  script,
  ready,
  liveLabel,
  liveDetail,
  onDone,
  pillText,
  pillState,
  composerHint,
  revealOnReady = false,
}: {
  script: ConversationScript;
  /** Backend actually ready (launch) — gates the closing beat + reveal. */
  ready: boolean;
  liveLabel?: string;
  liveDetail?: string;
  onDone: () => void;
  pillText: string;
  pillState: 'busy' | 'ok';
  composerHint: string;
  /** Launch mode: the moment `ready` flips true, converge the whole thread and
   *  reveal fast — so a warm start snaps open instead of playing the full
   *  dialogue. Off for the update celebration, which should always play out. */
  revealOnReady?: boolean;
}) {
  const reduced = useMemo(prefersReducedMotion, []);
  const beats = script.beats;
  const [shown, setShown] = useState(0);
  const [done, setDone] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (done) return;
    // Launch mode: once the backend is truly ready, stop dawdling — reveal the
    // whole thread and finish shortly after, so the app shows the instant the
    // real load completes (a warm start barely shows the dialogue at all).
    if (revealOnReady && ready) {
      if (shown < beats.length) {
        setShown(beats.length);
        return;
      }
      const t = window.setTimeout(() => {
        setDone(true);
        onDoneRef.current();
      }, reduced ? 200 : 460);
      return () => window.clearTimeout(t);
    }
    if (shown >= beats.length) {
      const t = window.setTimeout(() => {
        setDone(true);
        onDoneRef.current();
      }, reduced ? 300 : HOLD_MS);
      return () => window.clearTimeout(t);
    }
    const next = beats[shown];
    // Hold a gated beat until the real backend is ready.
    if (next.role === 'assistant' && next.gate === 'ready' && !ready) return;
    const delay = reduced ? 0 : shown === 0 ? FIRST_MS : ready ? FAST_MS : STEP_MS;
    const t = window.setTimeout(() => setShown((s) => s + 1), delay);
    return () => window.clearTimeout(t);
  }, [shown, ready, beats, done, reduced, revealOnReady]);

  const waiting =
    !done &&
    shown < beats.length &&
    beats[shown]?.role === 'assistant' &&
    (beats[shown] as { gate?: string }).gate === 'ready' &&
    !ready;

  const skip = () => {
    setDone(true);
    onDoneRef.current();
  };

  return (
    <div
      className="w-[min(92vw,460px)] overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      role="status"
      aria-live="polite"
      data-testid="conversation-stage"
    >
      {/* Titlebar */}
      <div className="flex items-center gap-2 border-b border-border/60 bg-card/40 px-4 py-2.5">
        <span
          aria-hidden
          className="grid size-5 place-items-center rounded-md border border-border bg-elevated text-[11px] font-bold text-primary"
        >
          A
        </span>
        <span className="text-[13px] font-semibold text-foreground">August</span>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[10.5px] text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', pillState === 'ok' ? 'bg-success' : 'bg-primary')} />
          {pillText}
        </span>
      </div>

      {/* Thread */}
      <div className="flex min-h-[300px] flex-col gap-3.5 px-4 py-4">
        {beats.slice(0, shown).map((b, i) => (
          <Bubble
            key={i}
            beat={b}
            index={i}
            reduced={reduced}
            ready={ready}
            liveLabel={liveLabel}
            liveDetail={liveDetail}
          />
        ))}
        <AnimatePresence>
          {waiting && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2.5 pl-[34px]"
            >
              <TypingDots />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Composer + skip */}
      <div className="flex items-center gap-2 px-3 pb-3">
        <div className="flex-1 rounded-xl border border-border bg-card/50 px-3 py-2 text-[12.5px] text-muted-foreground/70">
          {composerHint}
        </div>
        <button
          type="button"
          onClick={skip}
          className="shrink-0 rounded-lg px-2.5 py-2 text-[12px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
          data-testid="conversation-skip"
        >
          Skip →
        </button>
      </div>
    </div>
  );
}
