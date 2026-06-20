/* ── RightDrawerPlanSection ─ Workbench plan ─────────────────────── */
/*                                                                          */
/* Plan actions (Reject / Revise / Accept / Accept and allow edits) live in  */
/* the PlanProposalBanner at the bottom of the chat thread. The drawer card  */
/* here is read-only: it just renders the plan.                             */

import type { ReactNode } from 'react';
import { FileText, FolderOpen, CheckCircle2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import type { WorkbenchSession } from '@/types/workbench';

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
      <div className="space-y-3 drawer-section-text">
        <div className="text-xs text-muted-foreground">No plan yet</div>
        <div className="rounded-lg border border-border/50 bg-card/60 p-4 text-center text-muted-foreground">
          The Workbench plan will appear here after the model creates one.
        </div>
      </div>
    );
  }

  return (
    <div className="h-full space-y-3 drawer-section-text">
      {plan.summary && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 plan-section-text">
          <Markdown content={plan.summary} />
        </div>
      )}

      <PlanList title="Steps" icon={<FileText className="size-3" />} items={plan.steps} />
      <PlanList title="Files" icon={<FolderOpen className="size-3" />} items={plan.files} />
      <PlanList
        title="Risks"
        icon={<AlertTriangle className="size-3" />}
        items={plan.risks}
        tone="warning"
      />
      <PlanList title="Verification" icon={<CheckCircle2 className="size-3" />} items={plan.verification} />
    </div>
  );
}

function PlanList({
  title,
  icon,
  items,
  tone,
}: {
  title: string;
  icon: ReactNode;
  items?: string[];
  tone?: 'default' | 'warning';
}) {
  if (!items?.length) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-semibold">
        {icon}
        {title}
      </div>
      <div className="space-y-1.5">
        {items.map((item, index) => (
          <div
            key={`${title}-${index}`}
            className={cn(
              'rounded-lg border px-2.5 py-2 plan-section-text',
              tone === 'warning'
                ? 'border-amber-500/25 bg-amber-500/5'
                : 'border-border/60 bg-card/40'
            )}
          >
            <Markdown content={item} />
          </div>
        ))}
      </div>
    </div>
  );
}
