/* ── RightDrawerPlanSection ─ Workbench plan ─────────────────────── */
/*                                                                          */
/* Plan actions (Reject / Revise / Accept / Accept and allow edits) live in  */
/* the PlanProposalBanner at the bottom of the chat thread. The drawer card  */
/* here is read-only: it just renders the plan.                             */

import { Markdown } from '@/sections/chat/ChatMarkdown';
import type { WorkbenchSession } from '@/types/workbench';
import { planBodyText } from '@/lib/workbench-plan';
import { FileText, FolderOpen, ShieldAlert, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

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

  if (plan.markdown) {
    return (
      <div className="h-full p-3 chat-message-text text-foreground/90 space-y-3 max-w-none">
        <Markdown content={plan.markdown} />
      </div>
    );
  }

  const body = planBodyText(plan);

  return (
    <div className="h-full p-3 space-y-4 chat-message-text text-foreground/90 max-w-none">
      {body && (
        <div className="text-foreground/90">
          <Markdown content={body} />
        </div>
      )}

      <PlanList title="Steps" icon={<FileText className="size-3.5" />} items={plan.steps} />
      <PlanList title="Files" icon={<FolderOpen className="size-3.5" />} items={plan.files} />
      <PlanList title="Risks" icon={<ShieldAlert className="size-3.5" />} items={plan.risks} />
      <PlanList title="Verification" icon={<CheckCircle2 className="size-3.5" />} items={plan.verification} />
    </div>
  );
}

function PlanList({ title, icon, items }: { title: string; icon: React.ReactNode; items?: string[] }) {
  if (!items?.length) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-semibold">
        {icon}
        {title}
      </div>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li key={`${title}-${index}`} className={cn(
            'rounded-md border border-border/60 bg-card/70 px-2.5 py-2 chat-message-text text-foreground/90 space-y-3 max-w-none',
            title === 'Risks' && 'border-warning/30 bg-warning/5'
          )}>
            <Markdown content={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}
