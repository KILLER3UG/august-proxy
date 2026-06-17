/* ── RightDrawerPlanSection ─ Workbench plan ─────────────────────── */

import type { ReactNode } from 'react';
import { FileText, FolderOpen, ShieldAlert, CheckCircle2, Wrench, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { WorkbenchSession } from '@/types/workbench';

export function RightDrawerPlanSection({
  session,
  onApprove,
}: {
  session: WorkbenchSession | null;
  onApprove: () => Promise<void>;
}) {
  const plan = session?.plan;
  const approved = session?.approved || !!session?.approvedAt;

  if (!plan) {
    return (
      <div className="space-y-3 text-xs">
        <div className="text-[11px] text-muted-foreground">No plan yet</div>
        <div className="rounded-lg border border-border/50 bg-card/60 p-4 text-center text-muted-foreground">
          The Workbench plan will appear here after the model creates one.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] text-muted-foreground">
            {approved ? 'Approved plan' : 'Plan awaiting approval'}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
            <span><Wrench className="inline size-3 mr-1" />{session?.mutationCount ?? 0} mutations</span>
            <span>·</span>
            <span>{session?.agentId}</span>
            <span>·</span>
            <span>{session?.provider}</span>
          </div>
        </div>
        <Badge variant={approved ? 'success' : 'warning'} className="text-[9px]">
          {approved ? <><CheckCircle2 className="size-3" /> approved</> : <><ShieldAlert className="size-3" /> approval needed</>}
        </Badge>
      </div>

      <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 leading-relaxed text-foreground/90">
        {plan.summary}
      </div>

      <PlanList title="Steps" icon={<FileText className="size-3" />} items={plan.steps} />
      <PlanList title="Files" icon={<FolderOpen className="size-3" />} items={plan.files} />
      <PlanList
        title="Risks"
        icon={<AlertTriangle className="size-3" />}
        items={plan.risks}
        tone="warning"
      />
      <PlanList title="Verification" icon={<CheckCircle2 className="size-3" />} items={plan.verification} />

      {!approved && (
        <div className="flex justify-end border-t border-white/[0.06] pt-3">
          <Button size="sm" onClick={onApprove}>Approve plan</Button>
        </div>
      )}
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
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {icon}
        {title}
      </div>
      <div className="space-y-1.5">
        {items.map((item, index) => (
          <div
            key={`${title}-${index}`}
            className={cn(
              'rounded-lg border px-2.5 py-2 leading-relaxed',
              tone === 'warning'
                ? 'border-amber-500/25 bg-amber-500/5'
                : 'border-border/60 bg-card/40'
            )}
          >
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}
