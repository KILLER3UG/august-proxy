/* ── RoutinesPane — Bot Mode Phase B: a Bot's routines docked beside its chat.
 *
 * A routine is an automation job named `[bot:<name>] <title>` with
 * deliver='bot-chat': its result lands in this Bot's canonical chat. This
 * pane gives the structured surface the plan specced — schedule picker
 * (frequency → detail), run-now, last-run status, enable/pause — while the
 * jobs also stay visible in the Automations section (single source of truth).
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Play, Plus, TriangleAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  deleteAutomation,
  getAutomations,
  getAutomationIncidents,
  patchAutomation,
  runAutomation,
  upsertAutomation,
  type AutomationJob,
} from '@/api/api-client';

export interface RoutinesPaneProps {
  /** The Bot's agentId — routines are the jobs whose agentId matches. */
  agentId: string;
  /** Bot handle (name) — used for the `[bot:<name>]` job namespace. */
  botName: string;
}

const FREQS = ['hourly', 'daily', 'weekly', 'interval'] as const;
type Freq = (typeof FREQS)[number];

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Build the schedule string the backend's natural forms accept. */
function scheduleFromPick(freq: Freq, detail: { time: string; day: string; everyN: string; unit: string }): string {
  if (freq === 'daily') return `daily ${detail.time}`;
  if (freq === 'weekly') return `weekly ${detail.day} ${detail.time}`;
  if (freq === 'hourly') {
    // Part 26 7.3: the picker value is a MINUTE (:00/:15/:30/:45) — the old
    // template bound it into the HOUR field, so "hourly at :30" produced the
    // invalid cron `0 30 * * *` (creation 400) and ":00" produced daily-
    // at-midnight. Hourly form is `<minute> * * * *`.
    return `${parseInt(detail.time || '0', 10) || 0} * * * *`;
  }
  return `every ${detail.everyN || '1'}${detail.unit || 'h'}`;
}

function routineName(botName: string, title: string) {
  return `[bot:${botName}] ${title}`;
}

function prettySchedule(j: AutomationJob): string {
  return j.schedule || '—';
}

function lastRunLabel(j: AutomationJob): string {
  const status = j.status || '';
  const at = j.lastRunAt;
  if (!status && !at) return 'never run';
  const stamp = at ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const s = status || (j.paused ? 'paused' : 'idle');
  return stamp ? `${s} · ${stamp}` : s;
}

export function RoutinesPane({ agentId, botName }: RoutinesPaneProps) {
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [freq, setFreq] = useState<Freq>('daily');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [detail, setDetail] = useState({ time: '09:00', day: 'mon', everyN: '1', unit: 'h' });

  const jobsQ = useQuery({ queryKey: ['automations'], queryFn: getAutomations, refetchInterval: 30_000 });
  const routines = useMemo(
    () => (jobsQ.data?.jobs ?? []).filter((j) => j.agentId === agentId),
    [jobsQ.data, agentId],
  );
  const routineIds = useMemo(() => new Set(routines.map((j) => j.id)), [routines]);

  // M-11: open incidents for this Bot's routines — an amber badge per row
  // (count) so repeated failures are visible without opening the ledger.
  const incidentsQ = useQuery({
    queryKey: ['automation-incidents'],
    queryFn: getAutomationIncidents,
    refetchInterval: 60_000,
  });
  const incidentCountByJob = useMemo(() => {
    const out = new Map<string, number>();
    for (const i of incidentsQ.data?.incidents ?? []) {
      if (routineIds.has(i.jobId)) out.set(i.jobId, (out.get(i.jobId) ?? 0) + (i.count || 1));
    }
    return out;
  }, [incidentsQ.data, routineIds]);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['automations'] });

  const create = useMutation({
    mutationFn: () => {
      // Upsert by the namespaced name — same semantics as the create_routine
      // tool: creating "Morning brief" twice updates that routine, never
      // forks (the store keys by id, so an existing name must reuse its id).
      const name = routineName(botName, title.trim() || 'Routine');
      const existing = (jobsQ.data?.jobs ?? []).find((j) => j.name === name);
      return upsertAutomation({
        id: existing?.id,
        name,
        schedule: scheduleFromPick(freq, detail),
        jobType: 'workbench',
        prompt: prompt.trim() || 'Run your routine.',
        agentId,
        deliver: 'bot-chat',
        respond: true,
      });
    },
    onSuccess: () => {
      toast.success('Routine created — results land in this Bot Chat');
      setShowNew(false);
      setTitle('');
      setPrompt('');
      invalidate();
    },
    onError: (e) => toast.error('Could not create routine', { description: String(e) }),
  });

  const runNow = useMutation({
    mutationFn: (id: string) => runAutomation(id),
    onSuccess: () => {
      toast.success('Routine run started — watch the chat');
      invalidate();
    },
    onError: () => toast.error('Could not run routine'),
  });

  const togglePause = useMutation({
    mutationFn: (j: AutomationJob) => patchAutomation(j.id, { paused: !j.paused }),
    onSuccess: invalidate,
    onError: () => toast.error('Could not update routine'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteAutomation(id),
    onSuccess: () => {
      toast.success('Routine deleted');
      invalidate();
    },
    onError: () => toast.error('Could not delete routine'),
  });

  return (
    <div className="flex flex-col gap-1.5 text-xs" data-testid="routines-pane">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-1 text-sidebar-foreground/50">
          <CalendarClock className="size-3" />
          <span className="text-[11px]">Routines</span>
          {routines.length > 0 && (
            <span className="text-[10px] text-sidebar-foreground/30 tabular-nums">{routines.length}</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowNew((v) => !v)}
          className="p-0.5 rounded text-sidebar-foreground/30 hover:text-sidebar-foreground/60 hover:bg-white/[0.03]"
          title="New routine"
          aria-label="New routine"
        >
          <Plus className="size-3" />
        </button>
      </div>

      {showNew && (
        <div className="px-1.5 pb-1.5 flex flex-col gap-1.5 rounded-md border border-sidebar-border/40 bg-white/[0.02] p-2">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Routine title (e.g. Morning brief)"
            className="rounded-md bg-white/[0.04] border border-sidebar-border/50 px-2 py-1 text-xs outline-none focus:border-sidebar-ring/70"
            data-testid="routine-title"
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the Bot do? (the prompt it runs)"
            rows={2}
            className="rounded-md bg-white/[0.04] border border-sidebar-border/50 px-2 py-1 text-xs outline-none focus:border-sidebar-ring/70 resize-none"
            data-testid="routine-prompt"
          />
          <div className="flex items-center gap-1" data-testid="routine-freq">
            {FREQS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFreq(f)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10.5px] capitalize border transition',
                  freq === f
                    ? 'border-primary/50 bg-primary/15 text-primary'
                    : 'border-transparent text-sidebar-foreground/50 hover:bg-white/5',
                )}
              >
                {f}
              </button>
            ))}
          </div>
          {freq === 'daily' && (
            <input
              type="time"
              value={detail.time}
              onChange={(e) => setDetail((d) => ({ ...d, time: e.target.value }))}
              className="rounded-md bg-white/[0.04] border border-sidebar-border/50 px-2 py-1 text-xs w-28"
              data-testid="routine-time"
            />
          )}
          {freq === 'weekly' && (
            <div className="flex items-center gap-1">
              <select
                value={detail.day}
                onChange={(e) => setDetail((d) => ({ ...d, day: e.target.value }))}
                className="rounded-md bg-white/[0.04] border border-sidebar-border/50 px-1.5 py-1 text-xs"
                data-testid="routine-day"
              >
                {WEEKDAYS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <input
                type="time"
                value={detail.time}
                onChange={(e) => setDetail((d) => ({ ...d, time: e.target.value }))}
                className="rounded-md bg-white/[0.04] border border-sidebar-border/50 px-2 py-1 text-xs w-28"
              />
            </div>
          )}
          {freq === 'hourly' && (
            <select
              value={detail.time}
              onChange={(e) => setDetail((d) => ({ ...d, time: e.target.value }))}
              className="rounded-md bg-white/[0.04] border border-sidebar-border/50 px-1.5 py-1 text-xs w-28"
              data-testid="routine-minute"
            >
              {['00', '15', '30', '45'].map((m) => (
                <option key={m} value={m}>
                  :{m}
                </option>
              ))}
            </select>
          )}
          {freq === 'interval' && (
            <div className="flex items-center gap-1">
              <input
                value={detail.everyN}
                onChange={(e) => setDetail((d) => ({ ...d, everyN: e.target.value }))}
                className="w-12 rounded-md bg-white/[0.04] border border-sidebar-border/50 px-1.5 py-1 text-xs"
                data-testid="routine-every-n"
              />
              <select
                value={detail.unit}
                onChange={(e) => setDetail((d) => ({ ...d, unit: e.target.value }))}
                className="rounded-md bg-white/[0.04] border border-sidebar-border/50 px-1.5 py-1 text-xs"
              >
                {['m', 'h', 'd'].map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            type="button"
            disabled={!title.trim() || create.isPending}
            onClick={() => create.mutate()}
            className="rounded-md bg-primary/15 border border-primary/30 px-2 py-1 text-xs text-primary hover:bg-primary/25 disabled:opacity-40 transition"
            data-testid="routine-create"
          >
            {create.isPending ? 'Creating…' : 'Create routine'}
          </button>
        </div>
      )}

      <div className="space-y-0.5">
        {routines.map((j) => (
          <div
            key={j.id}
            className="group flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-white/[0.03]"
            data-testid="routine-row"
          >
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                j.paused ? 'bg-sidebar-foreground/20' : 'bg-emerald-400/70',
              )}
              title={j.paused ? 'paused' : 'enabled'}
            />
            <div className="min-w-0 flex-1 flex flex-col">
              <span className="truncate text-[12px] text-sidebar-foreground/80" title={j.prompt}>
                {(j.name || '').replace(/^\[bot:[^\]]+\]\s*/, '')}
              </span>
              <span className="truncate text-[10px] text-sidebar-foreground/35">
                {prettySchedule(j)} · {lastRunLabel(j)}
              </span>
            </div>
            {incidentCountByJob.has(j.id) && (
              <span
                className="flex shrink-0 items-center gap-0.5 rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-500/90"
                title={`Open incident${(incidentCountByJob.get(j.id) ?? 0) > 1 ? 's' : ''} — repeated failures`}
                data-testid={`routine-incident-${j.id}`}
              >
                <TriangleAlert className="size-2.5" />
                {incidentCountByJob.get(j.id)}
              </span>
            )}
            <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition">
              <button
                type="button"
                onClick={() => runNow.mutate(j.id)}
                className="p-0.5 rounded text-sidebar-foreground/40 hover:text-sidebar-foreground/90"
                title="Run now"
                aria-label="Run now"
              >
                <Play className="size-3" />
              </button>
              <button
                type="button"
                onClick={() => togglePause.mutate(j)}
                className="rounded px-1 py-0.5 text-[10px] text-sidebar-foreground/40 hover:text-sidebar-foreground/90 border border-sidebar-border/40"
                title={j.paused ? 'Resume' : 'Pause'}
              >
                {j.paused ? '▶' : '❙❙'}
              </button>
              <button
                type="button"
                onClick={() => remove.mutate(j.id)}
                className="p-0.5 rounded text-sidebar-foreground/40 hover:text-destructive"
                title="Delete routine"
                aria-label="Delete routine"
              >
                <Trash2 className="size-3" />
              </button>
            </span>
          </div>
        ))}
        {routines.length === 0 && !showNew && (
          <p className="px-2 py-1 text-[11px] text-sidebar-foreground/30 italic" data-testid="routines-empty">
            No routines — give this Bot a schedule.
          </p>
        )}
      </div>
    </div>
  );
}
