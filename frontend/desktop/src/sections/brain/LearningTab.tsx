/* v3 — Learning tab: heuristics, auto-memories, facts, sleep cycle, mutations */
import { useState } from 'react';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { Sparkles, Brain, Clock, Zap, ListChecks, Trash2, Check, X, Play, Pin, User, ChevronDown, ChevronRight, Eye } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { DiffView } from '@/components/chat/DiffView';
import { PageLoader } from '@/components/PageLoader';
import { useDeleteMemory, useLearningData } from '@/hooks/useLearningData';
import { api } from '@/api/client';

interface SkillDraft {
  name: string;
  body: string;
  existingBody?: string | null;
}

interface ConsolidationPlan {
  merge?: Array<{ keepId?: number; removeIds?: number[]; mergedRule?: string }>;
  promote?: Array<{ pattern?: string; factKey?: string; factValue?: string }>;
  delete?: number[];
}

interface ConsolidationPreview {
  plan: ConsolidationPlan | null;
  merged: number;
  promoted: number;
  deleted: number;
  errors?: string[];
}

function formatProfile(profile: unknown): string {
  if (typeof profile === 'string') return profile;
  // Stored profiles are strings or JSON objects; anything else renders empty.
  if (!profile || typeof profile !== 'object') return '';
  const p = profile as Record<string, unknown>;
  if (typeof p.summary === 'string' && p.summary) return p.summary;
  if (Array.isArray(p.facts)) {
    const lines: string[] = [];
    for (const f of p.facts as Array<Record<string, unknown>>) {
      const fact = f?.fact;
      if (typeof fact === 'string' || typeof fact === 'number') {
        lines.push(`- ${String(fact)}`);
      }
    }
    if (lines.length > 0) return lines.join('\n');
  }
  try {
    return JSON.stringify(profile, null, 2) ?? '';
  } catch {
    return '';
  }
}

function formatMemoryContent(memory: {
  content: unknown;
  summary?: string;
  description?: string;
  label?: string;
  title?: string;
}): string {
  for (const value of [memory.summary, memory.description, memory.label, memory.title]) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  if (typeof memory.content === 'string') return memory.content;
  if (memory.content == null) return '';
  try {
    return JSON.stringify(memory.content, null, 2) ?? '';
  } catch {
    return String(memory.content);
  }
}

export function LearningTab() {
  const { state: confirmState, confirm: confirmStyled, handleConfirm, handleCancel } =
    useConfirmDialog();
  const { data, error, isFetching, dataUpdatedAt } = useLearningData();
  const qc = useQueryClient();
  const deleteMemory = useDeleteMemory();
  const [drafts, setDrafts] = useState<Record<string, SkillDraft | 'loading'>>({});

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['brain-learning'] });
  };

  const toggleDraft = (name: string) => {
    if (drafts[name]) {
      const next = { ...drafts };
      delete next[name];
      setDrafts(next);
      return;
    }
    setDrafts((prev) => ({ ...prev, [name]: 'loading' }));
    void api
      .get<SkillDraft>(`/api/brain/skills/${encodeURIComponent(name)}/draft`)
      .then((d) => setDrafts((prev) => ({ ...prev, [name]: d })))
      .catch(() => {
        toast.error('Failed to load draft');
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
      });
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
    mutationFn: (name: string) =>
      api.post<{ approved?: boolean }>(`/api/brain/skills/${encodeURIComponent(name)}/approve`, {}),
    onSuccess: (res) => {
      if (res?.approved === false) {
        // The backend declined (e.g. no pending staging file) — do not claim success.
        toast.message('Skill not approved', {
          description: 'No pending skill was found to approve.',
        });
      } else {
        toast.success('Skill approved');
      }
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Approve failed'),
  });

  const rejectSkill = useMutation({
    mutationFn: (name: string) =>
      api.post<{ rejected?: boolean }>(`/api/brain/skills/${encodeURIComponent(name)}/reject`, {}),
    onSuccess: (res) => {
      if (res?.rejected === false) {
        // The backend declined (e.g. no pending staging file) — do not claim success.
        toast.message('Skill not rejected', {
          description: 'No pending skill was found to reject.',
        });
      } else {
        toast.success('Skill rejected');
      }
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

  // Sleep-cycle preview (B2): compute the plan without applying, show the
  // user exactly what would merge/promote/delete, then apply on confirm.
  const [preview, setPreview] = useState<ConsolidationPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const fetchPreview = () => {
    setPreviewLoading(true);
    void api
      .post<ConsolidationPreview>('/api/brain/run-consolidation', { preview: true })
      .then((res) => setPreview(res))
      .catch((e: Error) => toast.error(e.message || 'Preview failed'))
      .finally(() => setPreviewLoading(false));
  };

  const applyPreview = useMutation({
    mutationFn: (plan: ConsolidationPlan) =>
      api.post('/api/brain/apply-consolidation', { plan }),
    onSuccess: () => {
      toast.success('Sleep cycle applied');
      setPreview(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Apply failed'),
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
      <div className="flex items-center justify-between gap-3 text-xs md:col-span-2">
        <span
          className={`size-2 rounded-full ${isFetching ? 'bg-success animate-pulse' : 'bg-muted-foreground'}`}
          aria-hidden
        />
        <div className="flex flex-1 items-center gap-1.5">
          <span className="text-muted-foreground">
            {isFetching ? 'Refreshing…' : dataUpdatedAt ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : 'Auto-refreshes every 30s'}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground/70">Learning overview</span>
      </div>

      {/* At-a-glance counts */}
      <div className="grid grid-cols-2 gap-3 md:col-span-2 md:grid-cols-4">
        {[
          { label: 'Heuristics', value: data.heuristicCount, icon: Brain, tone: 'text-primary' },
          { label: 'Memories', value: data.autoMemories.length, icon: ListChecks, tone: 'text-sky-400' },
          { label: 'Pending skills', value: data.pendingSkills.length, icon: Sparkles, tone: 'text-warning' },
          { label: 'Projects', value: data.activeProjects.length, icon: Zap, tone: 'text-success' },
        ].map(({ label, value, icon: Icon, tone }) => (
          <Card key={label} className="flex items-center gap-3 p-3">
            <Icon className={`size-4 shrink-0 ${tone}`} />
            <div className="min-w-0">
              <p className="text-lg font-semibold leading-none">{value}</p>
              <p className="mt-1 truncate text-[10px] text-muted-foreground">{label}</p>
            </div>
          </Card>
        ))}
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
                    {typeof h.confidence === 'number' ? (
                      <>
                        {' · '}
                        <span data-testid={`heuristic-confidence-${h.id}`}>
                          {Math.round(h.confidence * 100)}%
                        </span>
                      </>
                    ) : null}
                  </span>
                </div>
                <button
                  type="button"
                  title="Delete heuristic"
                  className="text-muted-foreground hover:text-danger p-1"
                  data-testid={`delete-heuristic-${h.id}`}
                  onClick={() => {
                    void confirmStyled({
                      title: 'Delete heuristic?',
                      message: 'Delete this heuristic?',
                      confirmLabel: 'Delete',
                      variant: 'destructive',
                    }).then((ok) => {
                      if (ok) deleteHeuristic.mutate(h.id);
                    });
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Cross-session glance */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Active context</h3>
        </div>
        {data.currentContext ? (
          <p className="text-xs text-muted-foreground">{data.currentContext}</p>
        ) : (
          <p className="text-xs text-muted-foreground">No current context yet — it fills in as you chat.</p>
        )}
        {data.activeProjects.length === 0 ? (
          <p className="text-xs text-muted-foreground">No active projects remembered.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {data.activeProjects.map((p, i) => (
              <li
                key={`${p.path || p.name || i}`}
                className="text-[11px] px-2 py-1 rounded-md bg-muted/50 text-muted-foreground font-mono"
                title={p.path || undefined}
              >
                {p.name || p.path}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* User profile summary */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <User className="size-4 text-primary" />
          <h3 className="font-medium text-sm">User profile summary</h3>
        </div>
        {data.userProfile ? (
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-sans max-h-48 overflow-y-auto">
            {formatProfile(data.userProfile)}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">
            No profile yet — it builds from stable facts as you chat.
          </p>
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
              <li key={m.id} className="text-xs p-2 rounded hover:bg-muted/30 flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="font-medium flex items-center gap-1">
                    {m.key}
                    {m.pinned ? (
                      <Pin className="size-3 text-primary shrink-0" aria-label="pinned" />
                    ) : null}
                    {m.sourceSessionId ? (
                      <span
                        className="text-[10px] font-mono text-muted-foreground bg-muted px-1 py-0.5 rounded"
                        title={`Learned in session ${m.sourceSessionId}`}
                      >
                        from {m.sourceSessionId.slice(0, 12)}…
                      </span>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground line-clamp-2 whitespace-pre-wrap">
                    {formatMemoryContent(m)}
                  </p>
                </div>
                <button
                  type="button"
                  title="Delete memory"
                  className="text-muted-foreground hover:text-danger p-1 shrink-0"
                  data-testid={`delete-memory-${m.id}`}
                  onClick={() => {
                    void confirmStyled({
                      title: 'Delete this memory?',
                      message: `Delete this memory?\n\n${m.key}`,
                      confirmLabel: 'Delete',
                      variant: 'destructive',
                    }).then((ok) => {
                      if (ok) deleteMemory.mutate(m.id);
                    });
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
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
          <div className="flex gap-2">
            <button
              type="button"
              className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground disabled:opacity-50"
              disabled={previewLoading}
              data-testid="learning-preview-consolidation"
              onClick={fetchPreview}
            >
              <Eye className="size-3 inline mr-1" />
              {previewLoading ? 'Computing…' : 'Preview'}
            </button>
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
      <Card className={`p-4 space-y-3 md:col-span-2 ${data.pendingSkills.length > 0 ? 'border-primary/40 bg-primary/[0.03]' : ''}`}>
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Pending skills</h3>
          {data.pendingSkills.length > 0 ? (
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">
              {data.pendingSkills.length} awaiting review
            </span>
          ) : null}
        </div>
        {data.pendingSkills.length === 0 ? (
          <p className="text-xs text-muted-foreground">No skills awaiting approval.</p>
        ) : (
          <ul className="space-y-2">
            {data.pendingSkills.map((s) => (
              <li key={s.id} className="text-xs p-2 rounded border border-border">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium flex items-center gap-1.5">
                      {s.name}
                      {s.createdAt && Date.now() - new Date(s.createdAt).getTime() < 24 * 3600 * 1000 ? (
                        <span className="rounded-full bg-primary/15 px-1.5 py-px text-[9px] text-primary animate-pulse" title="Proposed in the last 24h">
                          new
                        </span>
                      ) : null}
                    </p>
                    <p className="text-muted-foreground">{s.description}</p>
                    {s.createdAt ? (
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                        proposed {new Date(s.createdAt).toLocaleString()}
                        {typeof s.useCount === 'number' && s.useCount > 0 ? ` · used ${s.useCount}×` : ''}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="p-1 text-muted-foreground hover:text-foreground"
                    title="Preview diff"
                    data-testid={`preview-skill-${s.name}`}
                    onClick={() => toggleDraft(s.name)}
                  >
                    {drafts[s.name] ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                  </button>
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
                </div>
                {drafts[s.name] ? (
                  <div className="mt-2">
                    {drafts[s.name] === 'loading' ? (
                      <p className="text-muted-foreground">Loading draft…</p>
                    ) : (
                      <DiffView
                        oldContent={(drafts[s.name] as SkillDraft).existingBody ?? ''}
                        newContent={(drafts[s.name] as SkillDraft).body}
                        maxLines={60}
                      />
                    )}
                  </div>
                ) : null}
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

      {/* Sleep-cycle preview modal (B2) */}
      {preview ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Sleep cycle preview"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPreview(null);
          }}
          data-testid="consolidation-preview-modal"
        >
          <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-xl border border-border bg-popover p-4 shadow-xl space-y-3">
            <div className="flex items-center gap-2">
              <Clock className="size-4 text-primary" />
              <h3 className="font-medium text-sm">Sleep cycle preview</h3>
              <span className="text-[10px] text-muted-foreground/70 ml-auto">
                Nothing applied yet
              </span>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="p-1 text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                <X className="size-3.5" />
              </button>
            </div>

            {!preview.plan || (preview.merged === 0 && preview.promoted === 0 && preview.deleted === 0) ? (
              <p className="text-xs text-muted-foreground">
                Nothing to consolidate right now — the sleep cycle found no
                merges, promotions, or stale rules.
              </p>
            ) : (
              <div className="space-y-3 text-xs">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-500">
                    {preview.merged} merge{preview.merged === 1 ? '' : 's'}
                  </span>
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-500">
                    {preview.promoted} promotion{preview.promoted === 1 ? '' : 's'}
                  </span>
                  <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-rose-500">
                    {preview.deleted} deletion{preview.deleted === 1 ? '' : 's'}
                  </span>
                </div>

                {preview.plan.merge?.length ? (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                      Merge duplicates
                    </p>
                    {preview.plan.merge.map((m, i) => (
                      <p key={i} className="text-muted-foreground">
                        #{m.keepId} keeps — removes {m.removeIds?.join(', ')}
                        {m.mergedRule ? (
                          <>
                            {' '}
                            <span className="text-foreground/80">→ “{m.mergedRule.slice(0, 80)}”</span>
                          </>
                        ) : null}
                      </p>
                    ))}
                  </div>
                ) : null}

                {preview.plan.promote?.length ? (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                      Promote patterns to facts
                    </p>
                    {preview.plan.promote.map((p, i) => (
                      <p key={i} className="text-muted-foreground">
                        <span className="font-mono text-[10px]">{p.factKey}</span> ←{' '}
                        {String(p.factValue).slice(0, 100)}
                      </p>
                    ))}
                  </div>
                ) : null}

                {preview.plan.delete?.length ? (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                      Delete stale rules
                    </p>
                    <p className="text-muted-foreground">#{preview.plan.delete.join(', #')}</p>
                  </div>
                ) : null}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="text-xs px-3 py-1.5 rounded bg-muted text-muted-foreground"
              >
                Discard
              </button>
              <button
                type="button"
                disabled={
                  !preview.plan ||
                  applyPreview.isPending ||
                  (preview.merged === 0 && preview.promoted === 0 && preview.deleted === 0)
                }
                className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-50"
                data-testid="consolidation-apply"
                onClick={() => applyPreview.mutate(preview.plan!)}
              >
                <Check className="size-3 inline mr-1" />
                Apply {preview.merged + preview.promoted + preview.deleted} change
                {preview.merged + preview.promoted + preview.deleted === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        cancelLabel={confirmState.cancelLabel}
        variant={confirmState.variant}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  );
}
