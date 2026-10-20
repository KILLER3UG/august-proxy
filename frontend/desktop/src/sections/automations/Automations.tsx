import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StatusPill, type StatusPillVariant } from '@/components/workspace/StatusPill';
import {
  Play,
  Inbox,
  Plus,
  Copy,
  RefreshCw,
  MoreHorizontal,
  ChevronRight,
  ExternalLink,
  FolderOpen,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  getAutomations,
  upsertAutomation,
  patchAutomation,
  runAutomation,
  deleteAutomation,
  rotateAutomationToken,
  listBots,
  type AggregatedModel,
  type AutomationJob,
  type AutomationUpsertInput,
} from '@/api/api-client';
import { useModels } from '@/hooks/useModels';
import { PageLoader } from '@/components/PageLoader';
import { QueryErrorState } from '@/components/QueryErrorState';
import {
  WORKBENCH_GUARD_MODES,
  WORKBENCH_GUARD_MODE_ORDER,
  type WorkbenchGuardMode,
} from '@/components/chat/WorkbenchModeSelector';
import {
  WORKBENCH_SANDBOX_MODES,
  getWorkbenchSandboxMode,
  type WorkbenchSandboxMode,
} from '@/components/chat/SandboxModeSelector';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { useNavigate } from 'react-router-dom';
import { OsNotifyService } from '@/lib/os-notify';
import { openFolderViaTauri } from '@/api/folder';

/** The one field class every control in this form uses. It was written out
 *  fourteen times as a literal, which is how a form ends up half-restyled:
 *  a change to the border or the padding had to be made in fourteen places
 *  and one of them was always missed. */
const FIELD = 'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm';

const SCHEDULE_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Daily at 9:00', value: '0 9 * * *' },
  { label: 'Weekdays at 9:00', value: '0 9 * * 1-5' },
  { label: 'Weekly Monday 9:00', value: '0 9 * * 1' },
  { label: 'Every 5 minutes', value: 'every 5m' },
  { label: 'Every 15 minutes', value: 'every 15m' },
  { label: 'Every 30 minutes', value: 'every 30m' },
  { label: 'Every 2 hours', value: 'every 2h' },
  { label: 'Custom…', value: '' },
];

const JOB_TYPE_OPTIONS: Array<{
  value: 'workbench' | 'shell' | 'http';
  label: string;
  hint: string;
}> = [
  { value: 'workbench', label: 'Workbench', hint: 'Fresh chat session with a prompt' },
  { value: 'shell', label: 'Shell', hint: 'Run a local command' },
  { value: 'http', label: 'HTTP', hint: 'Call a webhook / URL' },
];

function scheduleLabel(schedule?: string | null): string {
  if (!schedule) return '';
  const preset = SCHEDULE_PRESETS.find((p) => p.value && p.value === schedule);
  return preset?.label || schedule;
}

/** Select value for one catalog entry — the same model id can exist under two
 *  providers, so the provider is part of the key (and of the saved job). */
const modelKeyOf = (m: { provider: string; id: string }) => `${m.provider}\n${m.id}`;

/** How this unattended run is gated and scoped. Defaults stay unlabelled, so a
 *  card only says something when its policy differs from the harness default. */
function policyLabel(job: AutomationJob): string {
  const parts: string[] = [];
  const guard = job.guardMode;
  if (guard && guard !== 'ask') {
    parts.push(WORKBENCH_GUARD_MODES[guard as WorkbenchGuardMode]?.label ?? guard);
  }
  if (job.sandboxMode) {
    parts.push(getWorkbenchSandboxMode(job.sandboxMode as WorkbenchSandboxMode).shortLabel);
  }
  return parts.join(' · ');
}

export function Automations() {
  const { state: confirmState, confirm: confirmStyled, handleConfirm, handleCancel } =
    useConfirmDialog();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [tokenFlash, setTokenFlash] = useState<Record<string, string>>({});
  const prevStatusRef = useRef<Map<string, string>>(new Map());

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['automations'],
    queryFn: () => getAutomations(),
    /* The list used to be re-fetched every 5 s, forever, which re-rendered
     * every job card twice a second's worth of nothing. It now follows the
     * same shape the Runs page uses: fast while a job is actually running,
     * and slow when nothing is enabled — a list of paused/disabled/finished
     * jobs cannot change on its own, so there is nothing to poll for. The
     * 5 s cadence is kept whenever a job could still fire, because the
     * completion toast depends on the UI observing the running → settled
     * transition. */
    refetchInterval: (query) => {
      const jobs = query.state.data?.jobs ?? [];
      if (jobs.some((j) => j.status === 'running')) return 3_000;
      if (jobs.length > 0 && jobs.every((j) => !j.enabled || j.paused || j.limitReached)) {
        return 30_000;
      }
      return 5_000;
    },
  });

  // A failed list query is not an empty list: the "No automations yet" card
  // (and its create CTA) used to be exactly what a 500 rendered. Only an
  // answered, genuinely empty list earns the empty state.
  const listFailed = isError && !data;

  // Stable identity: `data?.jobs ?? []` produced a fresh array on every render
  // while the list query was still loading, which re-ran the settle-toast
  // effect (and the enabled count) each time for no reason.
  const jobs = useMemo(() => data?.jobs ?? [], [data]);

  // Toast + optional OS notify when a running job settles.
  useEffect(() => {
    const prev = prevStatusRef.current;
    for (const job of jobs) {
      const id = job.id;
      const status = job.status || 'idle';
      const was = prev.get(id);
      if (was === 'running' && status !== 'running') {
        const name = job.name || id;
        const failed = status === 'error' || status === 'failed';
        const detail = failed
          ? job.lastOutput?.slice(0, 120) || 'Automation failed'
          : job.lastOutput?.slice(0, 120) || 'Automation finished';
        if (failed) {
          toast.error(`Automation failed: ${name}`, { description: detail });
        } else {
          toast.success(`Automation done: ${name}`, { description: detail });
        }
        void OsNotifyService.notifyJobComplete(name, detail);
      }
      prev.set(id, status);
    }
  }, [jobs]);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['automations'] });

  // Editing reuses the create form and the same upsert route; the job's id in
  // the body is what makes it an update. Until now the form was create-only,
  // so changing a prompt meant deleting the automation and rebuilding it —
  // which also threw away its run history and trigger token.
  const [editing, setEditing] = useState<AutomationJob | null>(null);
  const closeForm = () => {
    setShowCreate(false);
    setEditing(null);
  };

  const create = useMutation({
    mutationFn: upsertAutomation,
    onSuccess: (job) => {
      invalidate();
      closeForm();
      if (job.triggerToken) {
        setTokenFlash((m) => ({ ...m, [job.id]: job.triggerToken! }));
      }
      toast.success('Automation saved');
    },
    onError: (e: unknown) =>
      toast.error('Could not save automation', { description: String((e as Error).message) }),
  });

  const run = useMutation({
    mutationFn: ({ job, approved }: { job: AutomationJob; approved: boolean }) =>
      runAutomation(job.id, approved) as Promise<{ status?: string }>,
    onSuccess: (res: { status?: string }, { job }) => {
      invalidate();
      if (res?.status === 'approval_required') {
        // The gate exists because the job can touch the machine, so the answer
        // is an explicit decision — not a dead-end toast that leaves "Run"
        // looking broken.
        void confirmStyled({
          title: 'Run this automation anyway?',
          message: `"${job.name || job.id}" is marked as requiring approval before it runs.`,
          confirmLabel: 'Run once',
          variant: 'destructive',
        }).then((ok) => {
          if (ok) run.mutate({ job, approved: true });
        });
        return;
      }
      toast.success('Automation triggered');
    },
    onError: (e: unknown) =>
      toast.error('Could not run automation', { description: String((e as Error).message) }),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { paused?: boolean; enabled?: boolean } }) =>
      patchAutomation(id, body),
    onSuccess: () => {
      invalidate();
      toast.success('Automation updated');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteAutomation(id),
    onSuccess: () => {
      invalidate();
      toast.success('Automation deleted');
    },
  });

  const rotate = useMutation({
    mutationFn: (id: string) => rotateAutomationToken(id),
    onSuccess: (job) => {
      invalidate();
      if (job.triggerToken) {
        setTokenFlash((m) => ({ ...m, [job.id]: job.triggerToken! }));
      }
      toast.success('Webhook token rotated');
    },
  });

  const enabledCount = useMemo(
    () => jobs.filter((j) => j.enabled && !j.paused).length,
    [jobs],
  );

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Automations"
        subtitle={
          isLoading
            ? 'Loading jobs…'
            : listFailed
              ? "Couldn't load jobs"
              : `${jobs.length} job${jobs.length === 1 ? '' : 's'} · ${enabledCount} active`
        }
        actions={
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setShowCreate((v) => !v);
            }}
          >
            <Plus className="size-3" /> New
          </Button>
        }
      />

      {(showCreate || editing) && (
        // Seeded fields are useState initializers, so switching between two
        // jobs (or create → edit) needs a fresh mount, not just new props.
        <AutomationForm
          key={editing?.id ?? 'new'}
          busy={create.isPending}
          initial={editing ?? undefined}
          onCancel={closeForm}
          onSave={(body) => create.mutate(body)}
        />
      )}

      {isLoading ? (
        <PageLoader label="Loading automations…" className="py-4" />
      ) : listFailed ? (
        <QueryErrorState
          error={error}
          onRetry={() => void refetch()}
          retrying={isRefetching}
          title="Couldn't load automations"
          note="Your jobs may still exist — the list request failed, so nothing is shown here. Retry before creating a new one."
        />
      ) : jobs.length === 0 && !showCreate ? (
        <Card className="border-dashed">
          <CardContent className="p-10 grid place-items-center text-center text-muted-foreground">
            <Inbox className="size-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm">No automations yet.</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              Schedule a workbench prompt, shell command, or HTTP call. Each workbench run starts a
              fresh chat session in the sidebar.
            </p>
            <Button size="sm" className="mt-3" onClick={() => setShowCreate(true)}>
              <Plus className="size-3" /> Create automation
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <AutomationCard
              key={job.id}
              job={job}
              token={tokenFlash[job.id]}
              onRun={() => run.mutate({ job, approved: job.approvalRequired !== true })}
              onEdit={() => {
                setShowCreate(false);
                setEditing(job);
              }}
              onDelete={() => {
                void confirmStyled({
                  title: 'Delete automation?',
                  message: `Delete automation "${job.name || job.id}"?`,
                  confirmLabel: 'Delete',
                  variant: 'destructive',
                }).then((ok) => {
                  if (ok) remove.mutate(job.id);
                });
              }}
              onPause={() =>
                patch.mutate({
                  id: job.id,
                  body: job.limitReached
                    ? { enabled: true, paused: false }
                    : { paused: !job.paused },
                })
              }
              onRotate={() => rotate.mutate(job.id)}
              busy={run.isPending || remove.isPending || patch.isPending || rotate.isPending}
            />
          ))}
        </div>
      )}
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

function AutomationForm({
  busy,
  initial,
  onCancel,
  onSave,
}: {
  busy: boolean;
  /** When set, the form edits that job instead of creating one. */
  initial?: AutomationJob;
  onCancel: () => void;
  onSave: (body: AutomationUpsertInput) => void;
}) {
  const editingId = initial?.id ?? '';
  const [name, setName] = useState(initial?.name ?? '');
  const [jobType, setJobType] = useState<'workbench' | 'shell' | 'http'>(
    initial?.jobType === 'shell' || initial?.jobType === 'http' ? initial.jobType : 'workbench',
  );
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [method, setMethod] = useState(initial?.method || 'GET');
  const [httpBody, setHttpBody] = useState(initial?.body ?? '');
  // A stored schedule that isn't one of the presets (a hand-written cron) has
  // to land in the custom field, or editing a job would silently rewrite its
  // schedule to the default preset. An empty schedule (create mode) is the
  // default preset, not "custom".
  const seededSchedule = initial?.schedule ?? '';
  const seededIsCustom =
    !!seededSchedule && !SCHEDULE_PRESETS.some((p) => p.value === seededSchedule);
  const [preset, setPreset] = useState(
    seededIsCustom ? '' : seededSchedule || SCHEDULE_PRESETS[0].value,
  );
  const [customSchedule, setCustomSchedule] = useState(
    seededIsCustom ? seededSchedule : '',
  );
  // The server's own vocabulary: 0 terminal runs means no cap. Sent as a
  // number so the field always says what the job does.
  const [maxRuns, setMaxRuns] = useState(String(initial?.maxRuns ?? 0));
  // What an unattended run is allowed to do. Seeded from the job and always
  // sent, so 'Server default' is a real choice rather than an ambiguity
  // between "default" and "leave what is stored".
  const [guardMode, setGuardMode] = useState<WorkbenchGuardMode>(
    initial?.guardMode === 'plan' ||
    initial?.guardMode === 'full' ||
    initial?.guardMode === 'edit' ||
    initial?.guardMode === 'ask'
      ? initial.guardMode
      : 'ask',
  );
  const [sandboxMode, setSandboxMode] = useState<WorkbenchSandboxMode | ''>(
    initial?.sandboxMode === 'read-only' ||
    initial?.sandboxMode === 'workspace-write' ||
    initial?.sandboxMode === 'danger-full-access'
      ? initial.sandboxMode
      : '',
  );
  const [workspacePath, setWorkspacePath] = useState(
    initial?.workspacePath || initial?.cwd || '',
  );
  // Which model and agent a workbench automation runs as. The card displays
  // both, so the form has to edit them too — until now a pinned model could
  // only be set from a Bot's routines pane.
  const { models } = useModels();
  const { data: botsData } = useQuery({ queryKey: ['bots'], queryFn: () => listBots() });
  const seededModelKey = initial?.model
    ? `${initial.modelProvider ?? initial.provider ?? ''}\n${initial.model}`
    : '';
  const [modelKey, setModelKey] = useState(seededModelKey);
  const [agentId, setAgentId] = useState(initial?.agentId ?? '');
  const modelsByProvider = useMemo(() => {
    const byProvider = new Map<string, AggregatedModel[]>();
    for (const m of models) {
      const list = byProvider.get(m.provider);
      if (list) list.push(m);
      else byProvider.set(m.provider, [m]);
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models]);
  // A stored model whose provider has since been removed must still appear,
  // or the form reads "Auto" and saving drops the pin.
  const orphanModel =
    !!seededModelKey && !models.some((m) => modelKeyOf(m) === seededModelKey)
      ? { value: seededModelKey, label: `${initial?.model} (not in catalog)` }
      : null;
  const orphanAgent =
    !!initial?.agentId && !(botsData?.bots ?? []).some((b) => b.id === initial.agentId)
      ? { value: initial.agentId, label: `${initial.agentId} (not in roster)` }
      : null;
  const [pickingWorkspace, setPickingWorkspace] = useState(false);

  const chooseWorkspace = async () => {
    setPickingWorkspace(true);
    try {
      const result = await openFolderViaTauri();
      if (!result.cancelled && result.path) {
        setWorkspacePath(result.path);
      }
    } catch (error) {
      toast.error('Could not open folder picker', {
        description: error instanceof Error ? error.message : 'Please enter the path manually.',
      });
    } finally {
      setPickingWorkspace(false);
    }
  };

  const schedule = preset || customSchedule.trim();
  // Hidden fields for shell/http jobs must not travel with the job: switching
  // type means the old pick no longer applies.
  const selectedModel = useMemo(() => {
    if (jobType !== 'workbench' || !modelKey) return { id: '', provider: '' };
    const split = modelKey.indexOf('\n');
    return { provider: modelKey.slice(0, split), id: modelKey.slice(split + 1) };
  }, [jobType, modelKey]);
  const canSave =
    !!schedule &&
    ((jobType === 'workbench' && !!prompt.trim()) ||
      (jobType === 'shell' && !!command.trim()) ||
      (jobType === 'http' && !!url.trim()));

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="text-sm font-medium">
          {editingId ? 'Edit automation' : 'New automation'}
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Name</span>
          <input
            className={cn(FIELD)}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Morning standup brief"
            // The form renders above the list, so focusing it also scrolls an
            // "Edit" click on a far-down card into view.
            autoFocus
          />
        </label>

        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">Type</span>
          <div className="grid gap-2 sm:grid-cols-3">
            {JOB_TYPE_OPTIONS.map((opt) => {
              const active = jobType === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setJobType(opt.value)}
                  className={
                    active
                      ? 'rounded-md border border-primary/50 bg-primary/10 px-2.5 py-2 text-left'
                      : 'rounded-md border border-border bg-background px-2.5 py-2 text-left hover:bg-muted/40'
                  }
                >
                  <div className="text-sm font-medium">{opt.label}</div>
                  <div className="text-2xs text-muted-foreground mt-0.5">{opt.hint}</div>
                </button>
              );
            })}
          </div>
        </div>

        {jobType === 'workbench' && (
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Prompt</span>
            <textarea
              className={cn(FIELD, 'min-h-[88px]')}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should the agent do each run?"
            />
          </label>
        )}

        {jobType === 'workbench' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Model (optional)</span>
              <select
                className={cn(FIELD)}
                value={modelKey}
                onChange={(e) => setModelKey(e.target.value)}
              >
                <option value="">Automatic — router picks</option>
                {orphanModel && (
                  <option value={orphanModel.value}>{orphanModel.label}</option>
                )}
                {modelsByProvider.map(([provider, list]) => (
                  <optgroup key={provider || 'default'} label={provider || 'Default'}>
                    {list.map((m) => (
                      <option key={modelKeyOf(m)} value={modelKeyOf(m)}>
                        {m.name || m.id}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Agent (optional)</span>
              <select
                className={cn(FIELD)}
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                <option value="">Default agent</option>
                {orphanAgent && <option value={orphanAgent.value}>{orphanAgent.label}</option>}
                {(botsData?.bots ?? [])
                  .filter((b) => !b.uiMeta?.hidden)
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name || b.id}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}

        {jobType === 'workbench' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Approvals</span>
              <select
                className={cn(FIELD)}
                value={guardMode}
                onChange={(e) => setGuardMode(e.target.value as WorkbenchGuardMode)}
                aria-label="Approval mode for this run"
              >
                {WORKBENCH_GUARD_MODE_ORDER.map((mode) => (
                  <option key={mode} value={mode}>
                    {WORKBENCH_GUARD_MODES[mode].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Tool reach</span>
              <select
                className={cn(FIELD)}
                value={sandboxMode}
                onChange={(e) => setSandboxMode(e.target.value as WorkbenchSandboxMode | '')}
                aria-label="Tool reach for this run"
              >
                <option value="">Server default (project)</option>
                {Object.values(WORKBENCH_SANDBOX_MODES).map((m) => (
                  <option key={m.id} value={m.id} title={m.description}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-2xs text-muted-foreground sm:col-span-2">
              This job runs with nobody watching: a mode that asks will park the run rather than
              finish it, and “Whole machine” lets the scheduled command touch anything the app can.
            </p>
          </div>
        )}

        {jobType === 'shell' && (
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Command</span>
            <textarea
              className={cn(FIELD, 'min-h-[72px] font-mono')}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npm test"
            />
          </label>
        )}

        {jobType === 'http' && (
          <div className="grid gap-3 sm:grid-cols-[100px_1fr]">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Method</span>
              <select
                className={cn(FIELD)}
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              >
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">URL</span>
              <input
                className={cn(FIELD, 'font-mono')}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hook"
              />
            </label>
            {(method === 'POST' || method === 'PUT' || method === 'PATCH') && (
              <label className="block space-y-1 sm:col-span-2">
                <span className="text-xs text-muted-foreground">Body (optional)</span>
                <textarea
                  className={cn(FIELD, 'min-h-[64px] font-mono')}
                  value={httpBody}
                  onChange={(e) => setHttpBody(e.target.value)}
                  placeholder='{"ok":true}'
                />
              </label>
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Schedule</span>
            <select
              className={cn(FIELD)}
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
            >
              {SCHEDULE_PRESETS.map((p) => (
                <option key={p.label} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {!preset && (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Cron or every Nm / Nh</span>
              <input
                className={cn(FIELD, 'font-mono')}
                value={customSchedule}
                onChange={(e) => setCustomSchedule(e.target.value)}
                placeholder="0 9 * * * or every 2h"
              />
            </label>
          )}
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Stop after N runs (0 = never)</span>
            <input
              type="number"
              min={0}
              className={cn(FIELD)}
              value={maxRuns}
              onChange={(e) => setMaxRuns(e.target.value)}
              placeholder="0 = keep running"
            />
          </label>
          <div className="block space-y-1 sm:col-span-2">
            <span className="text-xs text-muted-foreground">
              {jobType === 'shell' ? 'Working directory (optional)' : 'Workspace path (optional)'}
            </span>
            <div className="flex items-center gap-2">
              <input
                className={cn(FIELD, 'w-auto min-w-0 flex-1 font-mono')}
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                placeholder="C:\\Dev\\my-project"
                aria-label="Workspace path"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void chooseWorkspace()}
                disabled={busy || pickingWorkspace}
                title="Choose workspace folder"
                aria-label="Choose workspace folder"
                className="shrink-0"
              >
                <FolderOpen className="size-3" />
                <span className="hidden sm:inline">Browse</span>
              </Button>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || !canSave}
            onClick={() =>
              onSave({
                ...(editingId ? { id: editingId } : {}),
                name: name.trim() || 'Automation',
                schedule,
                // 0 is the server's "no cap", so send the number rather than
                // omitting it — an omitted field is left as stored.
                maxRuns: Math.max(0, Math.floor(Number(maxRuns) || 0)),
                jobType,
                prompt: jobType === 'workbench' ? prompt.trim() : undefined,
                // '' clears the pin; undefined leaves a field the type hides
                // untouched, because the upsert only writes what the body sends.
                model: jobType === 'workbench' ? selectedModel.id : undefined,
                modelProvider: jobType === 'workbench' ? selectedModel.provider : undefined,
                agentId: jobType === 'workbench' ? agentId : undefined,
                guardMode: jobType === 'workbench' ? guardMode : undefined,
                sandboxMode: jobType === 'workbench' ? sandboxMode : undefined,
                command: jobType === 'shell' ? command.trim() : undefined,
                url: jobType === 'http' ? url.trim() : undefined,
                method: jobType === 'http' ? method : undefined,
                body: jobType === 'http' ? httpBody.trim() || undefined : undefined,
                workspacePath: workspacePath.trim() || undefined,
                cwd: workspacePath.trim() || undefined,
              })
            }
          >
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AutomationCard({
  job,
  token,
  onRun,
  onEdit,
  onDelete,
  onPause,
  onRotate,
  busy,
}: {
  job: AutomationJob;
  token?: string;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPause: () => void;
  onRotate: () => void;
  busy: boolean;
}) {
  const navigate = useNavigate();
  const jobType = job.jobType || job.type || 'workbench';
  const runs = job.runs ?? [];
  const detail =
    jobType === 'http'
      ? [job.method || 'GET', job.url].filter(Boolean).join(' ')
      : job.prompt || job.task || job.command;

  const openSession = (sessionId: string) => {
    void navigate(`/c/${sessionId}`);
  };

  /* ONE status pill for the job. It used to be four badges (type, paused,
   * limit reached, needs approval) plus a pill plus a "running" badge — six
   * pieces of chrome, of which one was a type name and three were states the
   * meta line can carry. The most urgent state wins the pill; the rest of
   * the facts are one quiet line. */
  const status: { variant: StatusPillVariant; label: string } = (() => {
    if (job.status === 'running') return { variant: 'ok', label: 'running' };
    if (job.failureStop) return { variant: 'danger', label: 'stopped' };
    if (job.limitReached) return { variant: 'warn', label: 'limit reached' };
    if (job.paused) return { variant: 'muted', label: 'paused' };
    if (job.enabled) return { variant: 'ok', label: 'enabled' };
    return { variant: 'muted', label: 'disabled' };
  })();

  /* The quiet meta line. Every fact the card used to show is still here —
   * the four little icons that introduced them were decoration, and the
   * type name is a fact, not a badge. */
  const meta: string[] = [jobType];
  if (job.schedule) {
    meta.push(scheduleLabel(job.schedule) + (job.timezone ? ` (${job.timezone})` : ''));
  }
  if (job.model) {
    const provider = job.provider || job.modelProvider;
    meta.push(provider ? `${job.model} (${provider})` : job.model);
  }
  if (job.agentId || job.agent) meta.push(String(job.agentId || job.agent));
  if (job.approvalRequired) meta.push('needs approval');
  if (policyLabel(job)) meta.push(policyLabel(job));
  if (job.lastRunAt) meta.push(`last: ${shortDate(job.lastRunAt)}`);
  if (job.nextRunAt && !job.paused) meta.push(`next: ${shortDate(job.nextRunAt)}`);

  return (
    <Card className={job.enabled && !job.paused ? '' : 'opacity-70'}>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold">{job.name || job.id}</span>
              <StatusPill variant={status.variant} label={status.label} />
            </div>

            <p className="mt-1 text-2xs text-muted-foreground">{meta.join(' · ')}</p>
            {job.failureStop && job.failureStopReason && (
              /* The scheduler stopped a job that kept failing; without the
               * reason this is a job that silently stopped running. */
              <p
                className="mt-0.5 text-2xs text-warning"
                data-testid="automation-failure-stop"
                title={job.failureStopReason}
              >
                {job.failureStopReason}
              </p>
            )}

            {detail && (
              <pre className="mt-1.5 max-h-20 overflow-auto whitespace-pre-wrap break-all text-2xs font-mono text-muted-foreground/70">
                {detail}
              </pre>
            )}
          </div>

          {/* Run is the one primary action and stays visible; everything else
              moved into one menu. The card used to carry four buttons. */}
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" onClick={onRun} disabled={busy} title="Run now">
              <Play className="size-3" /> Run
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="outline"
                  disabled={busy}
                  title="More actions"
                  aria-label="More actions"
                >
                  <MoreHorizontal className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onPause} className="text-xs">
                  {job.limitReached ? 'Re-arm automation' : job.paused ? 'Resume' : 'Pause'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onEdit} className="text-xs">
                  Edit…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onDelete} className="text-xs text-destructive">
                  Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {token && (
          <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-2xs space-y-1">
            <div className="font-medium text-foreground/80">Webhook token (copy now — not shown on refresh)</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate font-mono">{token}</code>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(token);
                  toast.success('Token copied');
                }}
              >
                <Copy className="size-3" />
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={onRotate} title="Rotate token">
                <RefreshCw className="size-3" />
              </Button>
            </div>
            <div className="text-muted-foreground font-mono truncate">
              POST /api/automations/{job.id}/trigger
            </div>
          </div>
        )}

        {!token && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" className="h-7 text-2xs" onClick={onRotate} disabled={busy}>
              <RefreshCw className="size-3" /> Rotate webhook token
            </Button>
            {job.sessionId && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-2xs"
                onClick={() => openSession(job.sessionId!)}
              >
                <ExternalLink className="size-3" /> Open last session
              </Button>
            )}
          </div>
        )}

        {/* The runs disclosure is the standard collapsible group now: a
            native <details>, so it needs no state and is keyboard-usable. */}
        <details className="group/runs">
          <summary
            className="flex cursor-pointer list-none items-center gap-1 text-2xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
            data-testid="automation-runs-toggle"
          >
            <ChevronRight className="size-3 transition-transform group-open/runs:rotate-90" />
            Recent runs ({runs.length})
          </summary>
          <div className="space-y-1 pl-1 pt-1">
            {runs.length === 0 ? (
              <div className="text-2xs text-muted-foreground">No runs yet.</div>
            ) : (
              [...runs].reverse().map((r) => (
                <div
                  key={r.id}
                  className="rounded border border-border/50 px-2 py-1.5 text-2xs text-muted-foreground"
                >
                  <div className="flex flex-wrap gap-2 font-mono">
                    <span>{r.status}</span>
                    <span>{r.trigger}</span>
                    {r.startedAt && <span>{shortDate(r.startedAt)}</span>}
                    {r.sessionId && (
                      <button
                        type="button"
                        className="text-info underline-offset-2 hover:underline"
                        onClick={() => openSession(r.sessionId!)}
                      >
                        session
                      </button>
                    )}
                  </div>
                  {r.outputSnippet && (
                    <pre className="mt-1 whitespace-pre-wrap break-all opacity-80 max-h-16 overflow-auto">
                      {r.outputSnippet}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function shortDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
