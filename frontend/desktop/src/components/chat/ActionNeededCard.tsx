/* ── ActionNeededCard — Part 27 F6: computer/browser escalation ───────── */
/* When a browser run hits a login wall, the tool result carries an
   `actionNeeded` payload; this renders it as a first-class card in the
   transcript: instruction + screenshot + Take over (focus the Browser panel)
   + I'm done (queue a continue follow-up). Reuses the existing screenshot
   route, drawer section, and composer queue — no new backend surface. */

import { useState } from 'react';
import { Monitor, MousePointerClick, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { addRightDrawerSection, useRightDrawer } from '@/components/shell/RightDrawerState';
import { queueWorkbenchMessage } from '@/api/workbench';
import { resolveWorkbenchSessionId } from '@/sections/chat/stream/session-id-map';

export interface ActionNeededPayload {
  instruction?: string;
  screenshot?: { path?: string } | null;
}

export function ActionNeededCard({
  payload,
  sessionId,
}: {
  payload: ActionNeededPayload;
  sessionId?: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const { open } = useRightDrawer();

  const shotPath = payload.screenshot?.path;
  const imgSrc = shotPath
    ? `/api/browser/screenshot?path=${encodeURIComponent(shotPath)}`
    : null;

  const takeOver = () => {
    addRightDrawerSection('browser');
    if (!open) {
      // The drawer open flag is owned by the shell; opening the section is the
      // actionable part — the shell reveals it on the next section add.
      addRightDrawerSection('browser');
    }
  };

  const imDone = async () => {
    setDismissed(true);
    const wb = sessionId ? resolveWorkbenchSessionId(sessionId) || sessionId : '';
    if (wb) {
      try {
        await queueWorkbenchMessage(wb, 'I have completed the sign-in — continue where you left off.', undefined, 'queue');
      } catch {
        /* best-effort; the card still dismisses */
      }
    }
  };

  if (dismissed) return null;

  return (
    <div
      className="my-1.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3"
      data-testid="action-needed-card"
    >
      <div className="mb-1 flex items-center gap-2">
        <Monitor className="size-3.5 text-amber-400/90" />
        <span className="text-[13px] font-semibold text-foreground">Computer</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
          Action needed
        </span>
      </div>
      <p className="mb-2 text-[13px] leading-relaxed text-foreground/90">
        {payload.instruction || 'The agent needs you to sign in to continue.'}
      </p>
      {imgSrc && (
        <img
          src={imgSrc}
          alt="Where the agent got stuck"
          className="mb-2 max-h-64 w-full rounded-lg border border-white/10 object-cover"
          loading="lazy"
        />
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={takeOver}
          className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90"
          data-testid="action-needed-take-over"
        >
          <MousePointerClick className="size-3.5" /> Take over
        </button>
        <button
          type="button"
          onClick={() => void imDone()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-1.5 text-[12.5px] text-foreground transition hover:bg-muted/40"
          data-testid="action-needed-im-done"
        >
          <Check className="size-3.5" /> I&apos;m done
        </button>
      </div>
    </div>
  );
}

/** Parse a browser tool result for an actionNeeded payload (F6). Returns null
 *  when the result isn't a login-wall escalation, so callers render nothing. */
export function parseActionNeeded(resultText: string | undefined): ActionNeededPayload | null {
  if (!resultText || !resultText.includes('actionNeeded')) return null;
  try {
    const parsed = JSON.parse(resultText) as { actionNeeded?: ActionNeededPayload };
    return parsed.actionNeeded ?? null;
  } catch {
    return null;
  }
}
