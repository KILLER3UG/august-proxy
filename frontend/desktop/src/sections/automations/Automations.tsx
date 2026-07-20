import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/StatusPill';
import {
  Play,
  Trash2,
  Pause,
  PlayCircle,
  Clock,
  Inbox,
  Plus,
  Copy,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getAutomations,
  upsertAutomation,
  patchAutomation,
  runAutomation,
  deleteAutomation,
  rotateAutomationToken,
  type AutomationJob,
  type AutomationUpsertInput,
} from '@/api/api-client';
import { PageLoader } from '@/components/PageLoader';
import { useNavigate } from 'react-router-dom';
import { OsNotifyService } from '@/lib/os-notify';

const SCHEDULE_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Daily at 9:00', value: '0 9 * * *' },
  { label: 'Weekdays at 9:00', value: '0 9 * * 0-4' },
  { label: 'Weekly Monday 9:00', value: '0 9 * * 0' },
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

export function Automations() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [tokenFlash, setTokenFlash] = useState<Record<string, string>>({});
  const prevStatusRef = useRef<Map<string, string>>(new Map());

  const { data, isLoading } = useQuery({
    queryKey: ['automations'],
    queryFn: () => getAutomations(),
    refetchInterval: 5_000,
  });

  const jobs = data?.jobs ?? [];

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

  const create = useMutation({
    mutationFn: upsertAutomation,
    onSuccess: (job) => {
      invalidate();
      setShowCreate(false);
      if (job.triggerToken) {
        setTokenFlash((m) => ({ ...m, [job.id]: job.triggerToken! }));
      }
      toast.success('Automation saved');
    },
    onError: (e: unknown) =>
      toast.error('Could not save automation', { description: String((e as Error).message) }),
  });

  const run = useMutation({
    mutationFn: (job: AutomationJob) =>
      runAutomation(job.id, job.approvalRequired === false) as Promise<{ status?: string }>,
    onSuccess: (res: { status?: string }) => {
      invalidate();
      if (res?.status === 'approval_required') {
        toast.info('Automation requires approval');
      } else {
        toast.success('Automation triggered');
      }
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
            : `${jobs.length} job${jobs.length === 1 ? '' : 's'} · ${enabledCount} active`
        }
        actions={
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            <Plus className="size-3.5" /> New
          </Button>
        }
      />

      {showCreate && (
        <CreateAutomationForm
          busy={create.isPending}
          onCancel={() => setShowCreate(false)}
          onSave={(body) => create.mutate(body)}
        />
      )}

      {isLoading ? (
        <PageLoader label="Loading automations…" className="py-4" />
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
              <Plus className="size-3.5" /> Create automation
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
              onRun={() => run.mutate(job)}
              onDelete={() => {
                if (!confirm(`Delete automation "${job.name || job.id}"?`)) return;
                remove.mutate(job.id);
              }}
              onPause={() => patch.mutate({ id: job.id, body: { paused: !job.paused } })}
              onRotate={() => rotate.mutate(job.id)}
              busy={run.isPending || remove.isPending || patch.isPending || rotate.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateAutomationForm({
  busy,
  onCancel,
  onSave,
}: {
  busy: boolean;
  onCancel: () => void;
  onSave: (body: AutomationUpsertInput) => void;
}) {
  const [name, setName] = useState('');
  const [jobType, setJobType] = useState<'workbench' | 'shell' | 'http'>('workbench');
  const [prompt, setPrompt] = useState('');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('GET');
  const [httpBody, setHttpBody] = useState('');
  const [preset, setPreset] = useState(SCHEDULE_PRESETS[0].value);
  const [customSchedule, setCustomSchedule] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');

  const schedule = preset || customSchedule.trim();
  const canSave =
    !!schedule &&
    ((jobType === 'workbench' && !!prompt.trim()) ||
      (jobType === 'shell' && !!command.trim()) ||
      (jobType === 'http' && !!url.trim()));

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="text-sm font-medium">New automation</div>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Name</span>
          <input
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Morning standup brief"
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
                  <div className="text-[11px] text-muted-foreground mt-0.5">{opt.hint}</div>
                </button>
              );
            })}
          </div>
        </div>

        {jobType === 'workbench' && (
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Prompt</span>
            <textarea
              className="w-full min-h-[88px] rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should the agent do each run?"
            />
          </label>
        )}

        {jobType === 'shell' && (
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Command</span>
            <textarea
              className="w-full min-h-[72px] rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-mono"
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
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
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
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-mono"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hook"
              />
            </label>
            {(method === 'POST' || method === 'PUT' || method === 'PATCH') && (
              <label className="block space-y-1 sm:col-span-2">
                <span className="text-xs text-muted-foreground">Body (optional)</span>
                <textarea
                  className="w-full min-h-[64px] rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-mono"
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
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
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
              <span className="text-xs text-muted-foreground">Cron or every Nh</span>
              <input
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-mono"
                value={customSchedule}
                onChange={(e) => setCustomSchedule(e.target.value)}
                placeholder="0 9 * * * or every 2h"
              />
            </label>
          )}
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-xs text-muted-foreground">
              {jobType === 'shell' ? 'Working directory (optional)' : 'Workspace path (optional)'}
            </span>
            <input
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-mono"
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              placeholder="C:\\Dev\\my-project"
            />
          </label>
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
                name: name.trim() || 'Automation',
                schedule,
                jobType,
                prompt: jobType === 'workbench' ? prompt.trim() : undefined,
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
  onDelete,
  onPause,
  onRotate,
  busy,
}: {
  job: AutomationJob;
  token?: string;
  onRun: () => void;
  onDelete: () => void;
  onPause: () => void;
  onRotate: () => void;
  busy: boolean;
}) {
  const navigate = useNavigate();
  const [openRuns, setOpenRuns] = useState(false);
  const jobType = job.jobType || job.type || 'workbench';
  const runs = job.runs ?? [];
  const detail =
    jobType === 'http'
      ? [job.method || 'GET', job.url].filter(Boolean).join(' ')
      : job.prompt || job.task || job.command;

  const openSession = (sessionId: string) => {
    void navigate(`/c/${sessionId}`);
  };

  return (
    <Card className={job.enabled && !job.paused ? '' : 'opacity-70'}>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold">{job.name || job.id}</span>
              <Badge variant="secondary" className="text-[9px]">
                {jobType}
              </Badge>
              {job.paused && (
                <Badge variant="outline" className="text-[9px]">
                  paused
                </Badge>
              )}
              {job.status === 'running' && (
                <Badge variant="outline" className="text-[9px] border-info/50 text-info">
                  running
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground font-mono flex-wrap">
              <StatusPill
                tone={job.enabled && !job.paused ? 'good' : 'muted'}
                label={job.paused ? 'paused' : job.enabled ? 'enabled' : 'disabled'}
              />
              {job.schedule && (
                <span className="inline-flex items-center gap-1" title={job.schedule}>
                  <Clock className="size-2.5" /> {scheduleLabel(job.schedule)}
                  {job.timezone ? ` · ${job.timezone}` : ''}
                </span>
              )}
              {job.lastRunAt && <span>last: {shortDate(job.lastRunAt)}</span>}
              {job.nextRunAt && !job.paused && (
                <span className="text-warning">next: {shortDate(job.nextRunAt)}</span>
              )}
            </div>

            {detail && (
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-muted-foreground/70 mt-1.5 bg-muted/40 rounded px-2 py-1 max-h-20 overflow-auto">
                {detail}
              </pre>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Button size="sm" variant="outline" onClick={onPause} disabled={busy} title={job.paused ? 'Resume' : 'Pause'}>
              {job.paused ? <PlayCircle className="size-3" /> : <Pause className="size-3" />}
            </Button>
            <Button size="sm" variant="outline" onClick={onRun} disabled={busy} title="Run now">
              <Play className="size-3" /> Run
            </Button>
            <Button size="icon-sm" variant="outline" onClick={onDelete} disabled={busy} title="Delete">
              <Trash2 className="size-3 text-destructive" />
            </Button>
          </div>
        </div>

        {token && (
          <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-[11px] space-y-1">
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
            <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={onRotate} disabled={busy}>
              <RefreshCw className="size-3" /> Rotate webhook token
            </Button>
            {job.sessionId && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[11px]"
                onClick={() => openSession(job.sessionId!)}
              >
                <ExternalLink className="size-3" /> Open last session
              </Button>
            )}
          </div>
        )}

        <button
          type="button"
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setOpenRuns((v) => !v)}
        >
          {openRuns ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          Recent runs ({runs.length})
        </button>
        {openRuns && (
          <div className="space-y-1 pl-1">
            {runs.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">No runs yet.</div>
            ) : (
              [...runs].reverse().map((r) => (
                <div
                  key={r.id}
                  className="rounded border border-border/50 px-2 py-1.5 text-[11px] text-muted-foreground"
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
        )}
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
