/* ── RightDrawerPlanSection ─ Workbench plan ─────────────────────── */
/*                                                                          */
/* Plan actions (Reject / Revise / Accept / Accept and allow edits) live in  */
/* the PlanProposalBanner at the bottom of the chat thread. The drawer card  */
/* here is read-only: it renders the plan exactly as the model wrote it.     */
/* The plan is the model's own markdown (written to .aug/plans/plan.md and   */
/* handed over via submit_plan) — no app-imposed structure, rendered with    */
/* the same Markdown component + variant as assistant chat messages.         */

import { Markdown } from '@/sections/chat/ChatMarkdown';
import type { WorkbenchSession } from '@/types/workbench';
import { planBodyText } from '@/lib/workbench-plan';

export function RightDrawerPlanSection({
  session,
}: {
  session: WorkbenchSession | null;
  // Kept optional for callers that still pass them — they're ignored here.
  onApprove?: () => Promise<void>;
  onReject?: () => Promise<void>;
  onRevise?: (feedback: string) => Promise<void> | void;
}) {
  const plan = session?.plan;

  if (!plan) {
    return (
      <div className="chat-message-text text-foreground/90 p-3 space-y-3 max-w-none">
        <div className="text-xs text-muted-foreground">No plan yet</div>
        <div className="rounded-lg border border-border/50 bg-card/60 p-4 text-center text-muted-foreground">
          The Workbench plan will appear here after the model creates one.
        </div>
      </div>
    );
  }

  const body = plan.markdown ?? planBodyText(plan) ?? '';

  return (
    <div className="h-full p-3 chat-message-text text-foreground/90 space-y-3 max-w-none">
      <Markdown content={body} variant="assistant" />
      {plan.planPath && (
        <div className="text-[10px] font-mono text-muted-foreground/50">{plan.planPath}</div>
      )}
    </div>
  );
}
