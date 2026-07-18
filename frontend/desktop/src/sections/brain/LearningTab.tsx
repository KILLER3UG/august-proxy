/* v3 — Learning tab: heuristics, auto-memories, facts, sleep cycle, mutations */
import { Sparkles, Brain, Clock, Zap, ListChecks, Trash2, Check, X, Play } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { PageLoader } from '@/components/PageLoader';
import { useLearningData } from '@/hooks/useLearningData';
import { api } from '@/api/client';

export function LearningTab() {
  const { data, error, isFetching, dataUpdatedAt } = useLearningData();
  const qc = useQueryClient();

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['brain-learning'] });
  };

  const deleteHeuristic = useMutation({
    mutationFn: (id: number) => api.delete(`/api/brain/heuristics/${id}`),
    onSuccess: () => {
      toast.success('Heuristic deleted');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Delete failed'),
  });

  const approveSkill = useMutation({
    mutationFn: (name: string) => api.post(`/api/brain/skills/${encodeURIComponent(name)}/approve`, {}),
    onSuccess: () => {
      toast.success('Skill approved');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Approve failed'),
  });

  const rejectSkill = useMutation({
    mutationFn: (name: string) => api.post(`/api/brain/skills/${encodeURIComponent(name)}/reject`, {}),
    onSuccess: () => {
      toast.success('Skill rejected');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Reject failed'),
  });

  const runConsolidation = useMutation({
    mutationFn: () => api.post('/api/brain/run-consolidation', {}),
    onSuccess: () => {
      toast.success('Consolidation finished');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Consolidation failed'),
  });

  const toggleDeltaConsent = useMutation({
    mutationFn: (granted: boolean) =>
      api.put<{ consentGranted: boolean }>('/api/brain/delta-consent', { granted }),
    onSuccess: (res) => {
      toast.success(res.consentGranted ? 'Delta engine consent granted' : 'Delta engine consent revoked');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Consent update failed'),
  });

  if (error) {
    return <div className="p-4 text-danger">Error loading brain data: {error.message}</div>;
  }
  if (!data) {
    return <PageLoader label="Loading learning data…" variant="card" className="py-4" />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="flex items-center gap-1.5 text-xs md:col-span-2">
        <span
          className={`size-2 rounded-full ${isFetching ? 'bg-success animate-pulse' : 'bg-muted-foreground'}`}
          aria-hidden
        />
        <span className="text-muted-foreground">
          {isFetching ? 'Refreshing…' : dataUpdatedAt ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : 'Auto-refreshes every 30s'}
        </span>
      </div>

      {/* Learned heuristics */}
      <Card className="p-4 space-y-3 md:col-span-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="size-4 text-primary" />
            <h3 className="font-medium text-sm">Learned heuristics</h3>
          </div>
          <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
            {data.heuristicCount}
          </span>
        </div>
        {data.heuristics.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No learned heuristics yet — the brain starts learning once you use it.
          </p>
        ) : (
          <ul className="space-y-2 max-h-72 overflow-y-auto">
            {data.heuristics.map((h) => (
              <li
                key={h.id}
                className="text-xs flex items-start gap-2 p-2 rounded hover:bg-muted/30"
              >
                <span
                  className={`mt-1 size-1.5 rounded-full shrink-0 ${
                    h.source === 'manual'
                      ? 'bg-primary'
                      : h.source === 'local-diff'
                      ? 'bg-success'
                      : 'bg-muted-foreground'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <p>{h.rule}</p>
                  <span className="text-[10px] text-muted-foreground">
                    <span>{h.source}</span>
                    {' · '}
                    <span>{h.category}</span>
                  </span>
                </div>
                <button
                  type="button"
                  title="Delete heuristic"
                  className="text-muted-foreground hover:text-danger p-1"
                  data-testid={`delete-heuristic-${h.id}`}
                  onClick={() => {
                    if (confirm('Delete this heuristic?')) deleteHeuristic.mutate(h.id);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Auto-memories */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ListChecks className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Recent auto-memories</h3>
        </div>
        {data.autoMemories.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No persistent memories yet. As you share preferences and facts, August remembers so you never have to repeat yourself.
          </p>
        ) : (
          <ul className="space-y-2 max-h-60 overflow-y-auto">
            {data.autoMemories.map((m) => (
              <li key={m.id} className="text-xs p-2 rounded hover:bg-muted/30">
                <p className="font-medium">{m.key}</p>
                <p className="text-muted-foreground line-clamp-2">{m.content}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Sleep cycle */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="size-4 text-primary" />
            <h3 className="font-medium text-sm">Sleep cycle</h3>
          </div>
          <button
            type="button"
            className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50"
            disabled={runConsolidation.isPending}
            data-testid="learning-run-consolidation"
            onClick={() => runConsolidation.mutate()}
          >
            <Play className="size-3 inline mr-1" />
            Run now
          </button>
        </div>
        <dl className="text-xs grid grid-cols-2 gap-1">
          <dt className="text-muted-foreground">Last run</dt>
          <dd>{data.sleepCycle.lastRunAt ?? 'never'}</dd>
          <dt className="text-muted-foreground">Merged</dt>
          <dd>{data.sleepCycle.lastMerged}</dd>
          <dt className="text-muted-foreground">Promoted</dt>
          <dd>{data.sleepCycle.lastPromoted}</dd>
          <dt className="text-muted-foreground">Deleted</dt>
          <dd>{data.sleepCycle.lastDeleted}</dd>
        </dl>
      </Card>

      {/* Pending skills */}
      <Card className="p-4 space-y-3 md:col-span-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Pending skills</h3>
        </div>
        {data.pendingSkills.length === 0 ? (
          <p className="text-xs text-muted-foreground">No skills awaiting approval.</p>
        ) : (
          <ul className="space-y-2">
            {data.pendingSkills.map((s) => (
              <li key={s.id} className="text-xs flex items-start gap-2 p-2 rounded border border-border">
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{s.name}</p>
                  <p className="text-muted-foreground">{s.description}</p>
                </div>
                <button
                  type="button"
                  className="p-1 text-success"
                  title="Approve"
                  data-testid={`approve-skill-${s.name}`}
                  onClick={() => approveSkill.mutate(s.name)}
                >
                  <Check className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="p-1 text-danger"
                  title="Reject"
                  data-testid={`reject-skill-${s.name}`}
                  onClick={() => rejectSkill.mutate(s.name)}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Delta engine */}
      <Card className="p-4 space-y-2 md:col-span-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Zap className="size-4 text-primary shrink-0" />
            <div>
              <h3 className="font-medium text-sm">Delta engine</h3>
              <p className="text-[10px] text-muted-foreground">
                Learn preferences from your edits. Queue: {data.deltaEngine.queueSize} · Last flush:{' '}
                {data.deltaEngine.lastFlushAt ?? 'never'}
              </p>
            </div>
          </div>
          <button
            type="button"
            className={`text-xs px-2 py-1 rounded shrink-0 ${
              data.deltaEngine.consentGranted
                ? 'bg-success/20 text-success'
                : 'bg-muted text-muted-foreground'
            }`}
            disabled={toggleDeltaConsent.isPending}
            data-testid="learning-delta-consent"
            onClick={() =>
              toggleDeltaConsent.mutate(!data.deltaEngine.consentGranted)
            }
          >
            {data.deltaEngine.consentGranted ? 'consent on' : 'consent off'}
          </button>
        </div>
      </Card>
    </div>
  );
}
