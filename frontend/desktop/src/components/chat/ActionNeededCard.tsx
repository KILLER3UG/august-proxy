/* ── ActionNeededCard — Part 27 F6: computer/browser escalation ───────── */
/* When a browser run hits a login wall, the tool result carries an
   `actionNeeded` payload; this renders it as a first-class card in the
   transcript: instruction + screenshot + Take over (focus the Browser panel)
   + I'm done (queue a follow-up that names the original tool call so the
   agent retries it — the truthful "the tool call retries once" behavior
   given the current queue API surface). Reuses the existing screenshot
   route, drawer section, and composer queue — no new backend surface. */

import { useState } from 'react';
import { Monitor, MousePointerClick, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { addRightDrawerSection } from '@/components/shell/RightDrawerState';
import { queueWorkbenchMessage } from '@/api/workbench';
import {
  resolveUiSessionId,
  resolveWorkbenchSessionId,
} from '@/sections/chat/stream/session-id-map';

export interface ActionNeededPayload {
  instruction?: string;
  screenshot?: { path?: string } | null;
  /** Optional name of the tool call that hit the wall (e.g. "browser_open").
   *  When the card is rendered from a tool result, the parent injects this so
   *  "I'm done" can phrase the resume as "retry <tool name>". */
  toolName?: string;
  /** Optional original tool args (e.g. { url, ... }) so the resume can
   *  include the original target. */
  toolArgs?: Record<string, unknown>;
}

export function ActionNeededCard({
  payload,
  sessionId,
  toolName,
  toolArgs,
}: {
  payload: ActionNeededPayload;
  /** UI session id (matches the route param). The card resolves it to the
   *  workbench session id before queueing. */
  sessionId?: string;
  /** Direct tool name + args (preferred over payload.toolName when set,
   *  because the parent already has them on the tool entry). */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}) {
  const [dismissed, setDismissed] = useState(false);

  const shotPath = payload.screenshot?.path;
  const imgSrc = shotPath
    ? `/api/browser/screenshot?path=${encodeURIComponent(shotPath)}`
    : null;

  const takeOver = () => {
    // Single call: the section add is the actionable part; the shell reacts
    // to it. (Was duplicated previously — minor but pointless.)
    addRightDrawerSection('browser');
  };

  const imDone = async () => {
    setDismissed(true);
    // Resolve the UI session id to the workbench session id for queueing.
    // Without this the queue call is a no-op because the workbench uses
    // a different id space (wb_* vs /c/<id>).
    const ui = sessionId ? resolveUiSessionId(sessionId) || sessionId : '';
    const wb = (ui && resolveWorkbenchSessionId(ui)) || ui;
    if (!wb) {
      // Best-effort: the card still dismisses. Logged so the missing wiring
      // is visible during dev.
      console.warn(
        '[ActionNeededCard] no workbench session id for resume — sessionId=%s',
        sessionId,
      );
      return;
    }
    const resumeTool = toolName || payload.toolName;
    const argsJson = toolArgs
      ? Object.keys(toolArgs).length > 0
        ? ` (${JSON.stringify(toolArgs)})`
        : ''
      : '';
    const followUp = resumeTool
      ? `Sign-in complete — please retry \`${resumeTool}\`${argsJson} from where it left off.`
      : 'I have completed the sign-in — continue where you left off.';
    try {
      await queueWorkbenchMessage(wb, followUp, undefined, 'queue');
    } catch {
      /* best-effort; the card still dismisses */
    }
  };

  if (dismissed) return null;

  return (
    <div
      className={cn(
        'my-1.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3',
      )}
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
