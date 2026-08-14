/* ── SubagentSpawnModal — composer launcher bound to the active session ── */
/* Named DAG lines + skill preload. Launched agents stream into THIS chat. */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bot, ChevronDown, Loader2, Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/api/client';
import * as subagents from '@/api/subagents';
import { parseSpawnGoals, previewWaves } from '@/lib/parse-spawn-goals';
import type { ModelItem } from '../model-display';

const AGENT_OPTIONS = [
  { id: 'general', label: 'General', hint: 'General-purpose fallback' },
  { id: 'explore', label: 'Explore', hint: 'Read-only codebase exploration' },
  { id: 'plan', label: 'Plan', hint: 'Planning-focused' },
  { id: 'shell', label: 'Shell', hint: 'Command-oriented' },
];

const EFFORT_OPTIONS = ['low', 'medium', 'high', 'max'] as const;
type Effort = (typeof EFFORT_OPTIONS)[number];
type SpawnMode = 'auto' | 'proposed';

const PLACEHOLDER =
  'explore: map the repo\nsetup: install test deps\nprofile after:explore,setup: measure the hot path';

export function SubagentSpawnModal({
  sessionId,
  open,
  onClose,
  models,
}: {
  sessionId?: string;
  open: boolean;
  onClose: () => void;
  models?: ModelItem[];
}) {
  const [goals, setGoals] = useState('');
  const [agent, setAgent] = useState('general');
  const [effort, setEffort] = useState<Effort>('medium');
  const [mode, setMode] = useState<SpawnMode>('auto');
  const [modelOverride, setModelOverride] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [context, setContext] = useState('');
  const [restrictedTools, setRestrictedTools] = useState('');
  const [yieldSchema, setYieldSchema] = useState('');
  const [skillPick, setSkillPick] = useState<string[]>([]);
  const goalsRef = useRef<HTMLTextAreaElement | null>(null);
  const qc = useQueryClient();

  const skillsQ = useQuery({
    queryKey: ['skills-catalogue'],
    queryFn: async () => {
      const res = await api.get<{ skills?: { name: string; description?: string }[] }>(
        '/api/skills',
      );
      return res.skills ?? [];
    },
    enabled: open,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => goalsRef.current?.focus(), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(t);
    };
  }, [open, onClose]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ goals?: string }>).detail;
      if (detail?.goals) setGoals(detail.goals);
    };
    window.addEventListener('august:open-spawn', onOpen);
    return () => window.removeEventListener('august:open-spawn', onOpen);
  }, []);

  const parsedSchema = (() => {
    const text = yieldSchema.trim();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  const schemaInvalid = parsedSchema === null;
  const toolsList = restrictedTools
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const parsedItems = parseSpawnGoals(goals);
  const waves = parsedItems.length ? previewWaves(parsedItems) : [];

  const launch = useMutation({
    mutationFn: () =>
      subagents.spawn(
        {
          workItems: parsedItems.map((item) => ({
            goal: item.goal,
            agentId: agent,
            effort,
            ...(item.name ? { name: item.name, workstream: item.name } : {}),
            ...(item.dependsOn?.length ? { dependsOn: item.dependsOn } : {}),
            ...(skillPick.length ? { skills: skillPick } : {}),
            ...(modelOverride ? { model: modelOverride } : {}),
            ...(context.trim() ? { context: context.trim() } : {}),
            ...(toolsList.length > 0 ? { restrictedTools: toolsList } : {}),
            ...(parsedSchema ? { yieldSchema: parsedSchema } : {}),
          })),
          mode,
        },
        sessionId,
      ),
    onSuccess: (res) => {
      toast.success(
        res.status === 'awaiting_approval'
          ? 'Proposal created — approve it in chat'
          : `Dispatched ${parsedItems.length} worker(s) in ${waves.length || 1} wave(s)`,
      );
      onClose();
      setGoals('');
      void qc.invalidateQueries({ queryKey: ['subagent-runs'] });
      void qc.invalidateQueries({ queryKey: ['harness-jobs'] });
      void qc.invalidateQueries({ queryKey: ['workstreams'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Launch failed'),
  });

  if (!open) return null;

  const skillRows = skillsQ.data ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="subagent-spawn-modal"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <Bot className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">Dispatch workstreams</h2>
          <button
            type="button"
            aria-label="Close"
            className="ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-3 px-4 py-3">
          <div>
            <label className="text-[11px] font-medium text-muted-foreground" htmlFor="spawn-goals">
              One work item per line — <code className="text-[10px]">name: goal</code> or{' '}
              <code className="text-[10px]">name after:dep: goal</code>
            </label>
            <textarea
              id="spawn-goals"
              ref={goalsRef}
              value={goals}
              onChange={(e) => setGoals(e.target.value)}
              rows={4}
              placeholder={PLACEHOLDER}
              className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs outline-none focus:border-primary/50"
            />
          </div>
          {waves.length > 0 ? (
            <div className="rounded-md border border-border/50 bg-muted/15 px-2 py-1.5 text-[11px]" data-testid="spawn-wave-preview">
              {waves.map((w, i) => (
                <p key={i} className="text-muted-foreground">
                  Wave {i + 1}: <span className="font-mono text-foreground/80">{w.join(', ')}</span>
                </p>
              ))}
            </div>
          ) : null}
          <div>
            <span className="text-[11px] font-medium text-muted-foreground">Preload skills</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {skillRows.slice(0, 12).map((s) => {
                const name = s.name;
                if (!name) return null;
                const on = skillPick.includes(name);
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() =>
                      setSkillPick((prev) => (on ? prev.filter((x) => x !== name) : [...prev, name]))
                    }
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[10px]',
                      on ? 'border-primary/50 bg-primary/15 text-foreground' : 'border-border/60 text-muted-foreground',
                    )}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-medium text-muted-foreground">Mode</span>
            <label className="inline-flex items-center gap-1 text-[11px]">
              <input
                type="radio"
                name="spawn-mode"
                checked={mode === 'auto'}
                onChange={() => setMode('auto')}
                className="size-3"
              />
              Auto — launch immediately
            </label>
            <label className="inline-flex items-center gap-1 text-[11px]">
              <input
                type="radio"
                name="spawn-mode"
                checked={mode === 'proposed'}
                onChange={() => setMode('proposed')}
                className="size-3"
              />
              Proposed — approve first
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground" htmlFor="spawn-agent">
                Agent role
              </label>
              <select
                id="spawn-agent"
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none"
              >
                {AGENT_OPTIONS.map((a) => (
                  <option key={a.id} value={a.id} title={a.hint}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground" htmlFor="spawn-effort">
                Reasoning effort
              </label>
              <select
                id="spawn-effort"
                value={effort}
                onChange={(e) => setEffort(e.target.value as Effort)}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none"
              >
                {EFFORT_OPTIONS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground" htmlFor="spawn-model">
                Model
              </label>
              <select
                id="spawn-model"
                value={modelOverride}
                onChange={(e) => setModelOverride(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none"
              >
                <option value="">Inherit (agent alias / smol routing)</option>
                {(models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {!sessionId && (
            <p className="text-[11px] text-amber-600">
              No active chat session — agents will not stream into a transcript.
            </p>
          )}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
              data-testid="spawn-advanced-toggle"
            >
              <ChevronDown className={cn('size-3 transition-transform', showAdvanced && 'rotate-180')} />
              Advanced — context · restricted tools · yield schema
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-2.5 rounded-md border border-border/60 bg-background/50 p-2.5">
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground" htmlFor="spawn-context">
                    Shared context
                  </label>
                  <textarea
                    id="spawn-context"
                    value={context}
                    onChange={(e) => setContext(e.target.value)}
                    rows={2}
                    className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground" htmlFor="spawn-restrict">
                    Restricted tools (denylist)
                  </label>
                  <input
                    id="spawn-restrict"
                    value={restrictedTools}
                    onChange={(e) => setRestrictedTools(e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground" htmlFor="spawn-schema">
                    yieldSchema JSON
                  </label>
                  <textarea
                    id="spawn-schema"
                    value={yieldSchema}
                    onChange={(e) => setYieldSchema(e.target.value)}
                    rows={3}
                    className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11px] outline-none"
                  />
                  {schemaInvalid && (
                    <p className="mt-1 text-[10px] text-danger">Invalid JSON — the schema will not be sent.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={parsedItems.length === 0 || launch.isPending}
            onClick={() => launch.mutate()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            data-testid="spawn-launch-button"
          >
            {launch.isPending ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
            Dispatch {parsedItems.length > 0 ? `${parsedItems.length}` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
