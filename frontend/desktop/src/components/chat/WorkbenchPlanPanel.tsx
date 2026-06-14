import type { ReactNode } from 'react';
import { Bot, CheckCircle2, FileText, FolderOpen, ShieldAlert, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { WorkbenchPlan, WorkbenchSession, WorkbenchTodo } from '@/types/workbench';

export function WorkbenchPlanPanel({
  session,
  onApprove,
}: {
  session: WorkbenchSession | null;
  onApprove: () => Promise<void>;
}) {
  if (!session?.plan) return null;

  const plan = session.plan;
  const approved = session.approved || !!session.approvedAt;

  return (
    <Card className="mx-auto max-w-3xl border-amber-500/40 bg-amber-500/5">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-semibold">Workbench plan</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {approved ? 'Approved — mutating tools are enabled for this plan.' : 'Review the plan before August changes files or runs commands.'}
            </p>
          </div>
          <Badge variant={approved ? 'success' : 'warning'}>
            {approved ? <><CheckCircle2 className="size-3" /> approved</> : <><ShieldAlert className="size-3" /> approval needed</>}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <p className="text-foreground/90">{plan.summary}</p>

        <PlanList title="Steps" icon={<FileText className="size-3" />} items={plan.steps} />
        <PlanList title="Files" icon={<FolderOpen className="size-3" />} items={plan.files} />
        <PlanList title="Risks" icon={<ShieldAlert className="size-3" />} items={plan.risks} />
        <PlanList title="Verification" icon={<CheckCircle2 className="size-3" />} items={plan.verification} />

        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-muted-foreground">
          <span><Wrench className="inline size-3 mr-1" />{session.mutationCount} mutations</span>
          <span>·</span>
          <span>{session.agentId}</span>
          <span>·</span>
          <span>{session.provider}</span>
        </div>

        {!approved && (
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={onApprove}>
              Approve plan
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PlanList({ title, icon, items }: { title: string; icon: ReactNode; items?: string[] }) {
  if (!items?.length) return null;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
        {icon}
        {title}
      </div>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li key={`${title}-${index}`} className={cn(
            'rounded-md border border-border/60 bg-card/70 px-2.5 py-2 leading-relaxed',
            title === 'Risks' && 'border-amber-500/30 bg-amber-500/5'
          )}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WorkbenchStatusPill({ session }: { session: WorkbenchSession | null }) {
  if (!session) return null;

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono">
      <Bot className="size-3" />
      <span>{session.agentRole || session.agentId}</span>
      <span className="text-muted-foreground/40">·</span>
      <span>{session.provider}</span>
      {session.approved && (
        <>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-emerald-500">approved</span>
        </>
      )}
    </div>
  );
}

export function TodoSummary({ todos }: { todos?: WorkbenchTodo[] }) {
  if (!todos?.length) return null;

  return (
    <div className="mx-auto max-w-3xl rounded-lg border border-border bg-card">
      <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
        Todos
      </div>
      <div className="space-y-0.5 px-3 pb-3">
        {todos.map(todo => (
          <div key={todo.id} className="flex items-start gap-2 text-xs">
            <span className={cn(
              'mt-0.5 size-2 rounded-full shrink-0',
              todo.status === 'completed' ? 'bg-emerald-500' : todo.status === 'in_progress' ? 'bg-amber-500' : 'bg-muted-foreground/30'
            )} />
            <span className={cn(
              todo.status === 'completed' && 'text-muted-foreground line-through'
            )}>{todo.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
