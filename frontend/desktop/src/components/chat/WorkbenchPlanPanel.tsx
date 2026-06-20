import { useState, type ReactNode } from 'react';
import { ArrowRight, Check, CheckCircle2, Circle, FileText, FolderOpen, ShieldAlert, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Markdown } from '@/sections/chat/ChatMarkdown';
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
      <CardContent className="space-y-3 plan-section-text">
        {plan.summary && (
          <div className="text-foreground/90">
            <Markdown content={plan.summary} />
          </div>
        )}

        <PlanList title="Steps" icon={<FileText className="size-3" />} items={plan.steps} />
        <PlanList title="Files" icon={<FolderOpen className="size-3" />} items={plan.files} />
        <PlanList title="Risks" icon={<ShieldAlert className="size-3" />} items={plan.risks} />
        <PlanList title="Verification" icon={<CheckCircle2 className="size-3" />} items={plan.verification} />

        <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-muted-foreground">
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
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-semibold">
        {icon}
        {title}
      </div>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li key={`${title}-${index}`} className={cn(
            'rounded-md border border-border/60 bg-card/70 px-2.5 py-2 plan-section-text',
            title === 'Risks' && 'border-amber-500/30 bg-amber-500/5'
          )}>
            <Markdown content={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WorkbenchStatusPill({ session: _session }: { session: WorkbenchSession | null }) {
  // The "Primary Builder · claude" status pill was removed from the chat
  // header. The component is preserved as a no-op so the existing call
  // site in ChatThread.tsx doesn't need to be touched.
  return null;
}

export function TodoSummary({ todos }: { todos?: WorkbenchTodo[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!todos?.length) return null;

  const total = todos.length;
  const done = todos.filter(t => t.status === 'completed').length;
  const visible = expanded ? todos : todos.slice(0, 3);
  const overflow = total - visible.length;

  return (
    <div className="mx-auto max-w-3xl rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
          Todos
        </span>
        <span className="font-mono tabular-nums text-xs text-muted-foreground/80">
          {done}/{total}
        </span>
      </div>
      <div className="space-y-0.5 px-3 pb-3">
        {visible.map(todo => (
          <div key={todo.id} className="flex items-center gap-2 text-sm">
            <span className="w-3 inline-flex justify-center shrink-0 text-muted-foreground/80">
              {todo.status === 'completed' ? (
                <Check className="size-3 text-emerald-500" />
              ) : todo.status === 'in_progress' ? (
                <ArrowRight className="size-3 text-amber-500" />
              ) : (
                <Circle className="size-3 text-muted-foreground/40" />
              )}
            </span>
            <span className={cn(
              'flex-1',
              todo.status === 'completed' && 'text-muted-foreground line-through',
              todo.status === 'in_progress' && 'text-foreground',
              todo.status === 'pending' && 'text-muted-foreground/70'
            )}>
              {todo.content}
            </span>
          </div>
        ))}
        {overflow > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-xs text-muted-foreground/60 italic hover:text-foreground pl-5 pt-0.5"
          >
            + {overflow} waiting…
          </button>
        )}
        {expanded && total > 3 && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-xs text-muted-foreground/60 italic hover:text-foreground pl-5"
          >
            show less
          </button>
        )}
      </div>
    </div>
  );
}
