/* ── ContextUsageReadout — the composer's live context-window occupancy ─── */
/* The reference puts ONE number at the far right of the row under the
 * composer card: a context percentage (`3%`). This is that number.
 *
 * WHERE THE NUMBER COMES FROM. The backend measures the turn's context
 * occupancy server-side and ships it on the per-turn `contextPressure` event,
 * which `store/contextLive.ts` keeps per session: `contextUsedPct` is the
 * measured token count of the session's conversation messages divided by the
 * model's context window, tokenized with the provider's own tokenizer when
 * the model has one. The client never estimates it.
 *
 * TWO RULES, and both are about honesty rather than looks.
 *
 *   1. NO measurement, NO number. Before a session's first turn there is
 *      nothing to report, and `0%` would be a confident claim about a value
 *      nobody measured — the repo's rule that an unknown field is OMITTED,
 *      not zeroed. The element renders nothing at all.
 *   2. The number belongs to a SESSION. The store is keyed per session, so
 *      switching chats swaps the key: the previous session's percentage
 *      cannot stay on screen.
 *
 * THE DETAIL PANEL. Hovering (or focusing) the number opens the detail the
 * percentage cannot carry: the token counts, the prompt-cache split (which
 * arrives with the turn's event instead of waiting for the session-usage
 * poll) and the measured size of the skills/memory blocks the backend
 * injected this turn. Every figure in it is MEASURED — this file contains no
 * client-side estimate, which is why the per-category estimator that used to
 * live at `sections/chat/context-breakdown.ts` was deleted rather than
 * revived. It split a total the backend measures exactly into rows the
 * backend never measures, and the reference shows no per-category breakdown
 * to justify guessing one. */

import { useEffect, useRef, useState } from 'react';
import { selectContextLive, useContextLiveStore } from '@/store/contextLive';
import { selectPromptCacheLive, usePromptCacheLiveStore } from '@/store/promptCacheLive';
import { selectContextSections, useContextSectionsStore } from '@/store/contextSectionsLive';

/** The reference prints an integer (`3%`). A measurement under 1% would round
 *  to `0%`, which reads like "the window is empty" — so it keeps one decimal
 *  until it reaches 1%. A measured 0% still prints `0%`: that one IS a fact. */
function formatContextPercent(pct: number): string {
  if (!Number.isFinite(pct)) return '';
  if (pct > 0 && pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground/70">{label}</dt>
      <dd className="tabular-nums text-foreground/90">{value}</dd>
    </div>
  );
}

const DETAILS_ID = 'composer-context-details';

export function ContextUsageReadout({ sessionId }: { sessionId: string | null }) {
  const live = useContextLiveStore((s) => selectContextLive(s, sessionId));
  const cache = usePromptCacheLiveStore((s) => selectPromptCacheLive(s, sessionId));
  const sections = useContextSectionsStore((s) => selectContextSections(s, sessionId));
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const show = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  };
  /** A short grace period, so the pointer crossing the gap between the number
   *  and the panel does not dismiss it. */
  const hide = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, 150);
  };

  // No measurement → no number, and no element to hover. The absence is the
  // honest rendering: `0%` would claim a window nobody measured.
  if (!live || live.usedPct == null) return null;

  const pctText = formatContextPercent(live.usedPct);
  const cacheHitRate =
    cache?.hitRate ??
    (cache && cache.hitTokens + cache.missTokens > 0
      ? cache.hitTokens / (cache.hitTokens + cache.missTokens)
      : undefined);
  const skillsMemoryBytes = (sections?.skillsBytes ?? 0) + (sections?.memoryBytes ?? 0);
  const skillRows = Object.entries(sections?.skillsByName ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  return (
    <span
      className="relative inline-flex items-center"
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={open ? DETAILS_ID : undefined}
      data-testid="composer-context-readout"
    >
      <span
        className="cursor-default text-xs tabular-nums text-muted-foreground"
        data-testid="composer-context-pct"
      >
        {pctText}
      </span>
      {open ? (
        <div
          id={DETAILS_ID}
          role="tooltip"
          data-testid="composer-context-details"
          className="absolute bottom-full right-0 z-50 mb-1.5 w-56 rounded-lg border border-border/60 bg-popover p-2 text-2xs shadow-xl"
        >
          <div className="mb-1 font-medium text-foreground">Context window</div>
          <dl className="space-y-0.5">
            <DetailRow
              label="Used"
              value={`${live.totalTokens.toLocaleString()} / ${live.maxContext.toLocaleString()}`}
            />
            {live.remainingTokens != null ? (
              <DetailRow label="Left" value={live.remainingTokens.toLocaleString()} />
            ) : null}
            {cacheHitRate != null ? (
              <DetailRow label="Prompt cache" value={`${Math.round(cacheHitRate * 100)}% hit`} />
            ) : null}
            {sections ? (
              <DetailRow label="Skills + memory" value={formatBytes(skillsMemoryBytes)} />
            ) : null}
          </dl>
          {skillRows.length > 0 ? (
            <div className="mt-1.5 border-t border-border/40 pt-1.5 text-muted-foreground/70">
              {skillRows.map(([name, bytes]) => `${name} · ${formatBytes(bytes)}`).join('   ')}
            </div>
          ) : null}
          {/* What the numerator actually covers. The backend measures the
              session's MESSAGES; the system prompt and the tool-definition
              schemas ride in the same window and are not part of that
              measurement, so the percentage is a floor on the true fill. */}
          <div className="mt-1.5 border-t border-border/40 pt-1.5 text-muted-foreground/60">
            Message tokens only — the system prompt and tool definitions share the window and
            are not counted here.
          </div>
        </div>
      ) : null}
    </span>
  );
}
