import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/StatusPill';
import { Play, Trash2, ShieldAlert, Clock, Inbox } from 'lucide-react';
import { toast } from 'sonner';
import { getAutomations, runAutomation, deleteAutomation, type AutomationJob } from '@/api/api-client';
import { PageLoader } from '@/components/PageLoader';

export function Automations() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['automations'],
    queryFn: () => getAutomations(),
    refetchInterval: 8_000,
  });

  const jobs = data?.jobs ?? [];

  const run = useMutation({
    mutationFn: (job: AutomationJob) => runAutomation(job.id, job.approvalRequired === false) as Promise<{ status?: string }>,
    onSuccess: (res: { status?: string }) => {
      void qc.invalidateQueries({ queryKey: ['automations'] });
      if (res?.status === 'approval_required') {
        toast.info('Automation requires approval', { description: 'Approve it to run the next time.' });
      } else {
        toast.success('Automation triggered');
      }
    },
    onError: (e: unknown) => toast.error('Could not run automation', { description: String((e as Error).message) }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteAutomation(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['automations'] });
      toast.success('Automation deleted');
    },
  });

  function handleDelete(job: AutomationJob) {
    if (!confirm(`Delete automation "${job.name || job.id}"? This cannot be undone.`)) return;
    remove.mutate(job.id);
  }

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Automations"
        subtitle={
          isLoading
            ? 'Loading jobs…'
            : `${jobs.length} job${jobs.length === 1 ? '' : 's'} · ${jobs.filter((j) => j.enabled).length} enabled`
        }
      />

      {isLoading ? (
        <PageLoader label="Loading automations…" className="py-4" />
      ) : jobs.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-10 grid place-items-center text-center text-muted-foreground">
            <Inbox className="size-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm">No automation jobs configured.</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              Jobs are defined in backend automation config. They appear here once created.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <AutomationCard
              key={job.id}
              job={job}
              onRun={() => run.mutate(job)}
              onDelete={() => handleDelete(job)}
              busy={run.isPending || remove.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AutomationCard({
  job,
  onRun,
  onDelete,
  busy,
}: {
  job: AutomationJob;
  onRun: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <Card className={job.enabled ? '' : 'opacity-70'}>
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold">{job.name || job.id}</span>
              <Badge variant="secondary" className="text-[9px]">{job.type || 'automation'}</Badge>
              {job.approvalRequired !== false && (
                <Badge variant="outline" className="text-[9px] border-warning/50 text-warning">
                  <ShieldAlert className="size-2.5 mr-0.5" /> approval
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground font-mono flex-wrap">
              <StatusPill tone={job.enabled ? 'good' : 'muted'} label={job.enabled ? 'enabled' : 'disabled'} />
              {job.schedule && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-2.5" /> {job.schedule}
                </span>
              )}
              {job.agent && <span>agent: {job.agent}</span>}
              {job.lastRunAt && <span>last run: {shortDate(job.lastRunAt)}</span>}
              {job.nextRunAt && <span className="text-warning">next: {shortDate(job.nextRunAt)}</span>}
            </div>

            {(job.task || job.command) && (
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-muted-foreground/70 mt-1.5 bg-muted/40 rounded px-2 py-1">
                {job.task || job.command}
              </pre>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Button size="sm" variant="outline" onClick={onRun} disabled={busy} title="Run now">
              <Play className="size-3" /> Run
            </Button>
            <Button size="icon-sm" variant="outline" onClick={onDelete} disabled={busy} title="Delete">
              <Trash2 className="size-3 text-destructive" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function shortDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = d.getTime() - now;
    const abs = Math.abs(diff);
    const mins = Math.round(abs / 60000);
    if (mins < 60) return diff >= 0 ? `in ${mins}m` : `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return diff >= 0 ? `in ${hrs}h` : `${hrs}h ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}
