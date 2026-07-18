/* ── BrainSettings — modern orchestrator controls ──────────────────── */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Brain, RotateCcw, Save, Sparkles } from 'lucide-react';
import {
  getBrainConfig,
  saveBrainConfig,
  resetBrainConfig,
  getBrainConfigFromSession,
  type BrainConfig,
  type BrainConfigResponse,
  type BrainConfigSource,
} from '@/api/workbench';
import { openBrainEventStream } from '@/api/api-client';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const BOOLEAN_KEYS: { key: keyof BrainConfig; label: string; description: string }[] = [
  { key: 'enabled', label: 'Master switch', description: 'Turns the brain orchestrator on or off. When off, the model runs without per-turn policy injection.' },
  { key: 'adaptivePolicy', label: 'Adaptive policy', description: 'When on, the orchestrator picks a per-turn policy based on the user message.' },
  { key: 'failureLearning', label: 'Failure learning', description: 'Surface past tool-failure hints in the system prompt.' },
  { key: 'graphMemory', label: 'Graph memory', description: 'Pull graph-memory observations into context.' },
  { key: 'agentJobs', label: 'Agent jobs persistence', description: 'Persist sub-agent invocations for Agents tab and audit log.' },
  { key: 'hierarchicalAgents', label: 'Hierarchical agents', description: 'Allow sub-agents to spawn their own children.' },
  { key: 'adapterParallelTools', label: 'Adapter parallel tools', description: 'Run tool calls in parallel when the provider supports it.' },
  { key: 'parallelReadTools', label: 'Parallel read-only tools', description: 'Allow multiple read-only tool calls in a single turn.' },
  { key: 'reviewLearnedGuidelines', label: 'Review learned guidelines', description: 'Surface pending learned guidelines for accept/reject.' },
];

const DEPTH_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }));
const LOOP_OPTIONS = [10, 25, 50, 75, 100, 150, 200, 300, 500].map((n) => ({
  value: String(n),
  label: String(n),
}));

export function BrainSettings() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<BrainConfig | null>(null);
  const [sourceInfo, setSourceInfo] = useState<BrainConfigResponse | null>(null);
  const [learning, setLearning] = useState(false);
  const learningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['brain-config'],
    queryFn: () => getBrainConfig(),
    refetchOnMount: 'always',
  });

  useEffect(() => {
    if (data) {
      setDraft(data.config);
      setSourceInfo(data);
    }
  }, [data]);

  // Pulse the header brain while live brain events arrive (shows it's functioning).
  useEffect(() => {
    const es = openBrainEventStream();
    es.onmessage = () => {
      setLearning(true);
      if (learningTimerRef.current) clearTimeout(learningTimerRef.current);
      learningTimerRef.current = setTimeout(() => setLearning(false), 2800);
    };
    return () => {
      es.close();
      if (learningTimerRef.current) clearTimeout(learningTimerRef.current);
    };
  }, []);

  const save = useMutation({
    mutationFn: (updates: Partial<BrainConfig>) => saveBrainConfig(updates),
    onSuccess: (res) => {
      setDraft(res.config);
      void queryClient.invalidateQueries({ queryKey: ['brain-config'] });
      void queryClient.invalidateQueries({ queryKey: ['brain-policy'] });
      toast.success('Brain config saved — next turn will use the new policy.');
    },
    onError: (e: Error) => toast.error(e.message || 'Save failed'),
  });

  const reset = useMutation({
    mutationFn: () => resetBrainConfig(),
    onSuccess: (res) => {
      setDraft(res.config);
      void queryClient.invalidateQueries({ queryKey: ['brain-config'] });
      toast.message('Reset to factory defaults');
    },
    onError: (e: Error) => toast.error(e.message || 'Reset failed'),
  });

  const pullFromSession = useMutation({
    mutationFn: () =>
      data?.sessionId
        ? getBrainConfigFromSession(data.sessionId)
        : Promise.reject(new Error('No session')),
    onSuccess: (res) => {
      setDraft(res.config);
      setSourceInfo(res);
      toast.message('Pulled defaults from the most recent chat session');
    },
    onError: (e: Error) => toast.error(e.message || 'Pull failed'),
  });

  if (isError) {
    return (
      <div
        className="mx-auto max-w-3xl p-8 text-sm text-destructive flex items-center gap-3"
        data-testid="brain-settings-error"
      >
        <span>Could not load brain config: {(error)?.message || 'unknown error'}</span>
        <Button size="sm" variant="outline" onClick={() => { void refetch(); }}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (isLoading || !draft) {
    return (
      <div className="mx-auto max-w-3xl p-8 space-y-3" data-testid="brain-settings-skeleton">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-14 rounded-xl border border-white/[0.06] bg-card/40 animate-pulse" />
        ))}
      </div>
    );
  }

  const update = <K extends keyof BrainConfig>(key: K, value: BrainConfig[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(data?.config);

  return (
    <div
      className="mx-auto w-full max-w-3xl px-6 py-8 space-y-6"
      data-testid="brain-settings-page"
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Brain
              className={cn(
                'size-5 text-primary brain-icon-idle',
                learning && 'brain-icon-learning',
              )}
              aria-hidden
            />
            Brain Orchestrator
            {draft.enabled ? (
              <span
                className={cn(
                  'text-[11px] font-normal text-primary/80',
                  learning && 'animate-pulse',
                )}
              >
                {learning ? 'Learning…' : 'Active'}
              </span>
            ) : null}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-lg">
            Tune the policy the model uses on every turn. For memories, skill genesis, env watcher, and boot
            layers, open{' '}
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => void navigate('/brain')}
            >
              Brain → Ops
            </button>
            .
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SourceBadge source={sourceInfo?.source} sessionId={sourceInfo?.sessionId} />
          <Button
            size="sm"
            variant="outline"
            onClick={() => pullFromSession.mutate()}
            disabled={!sourceInfo?.sessionId || pullFromSession.isPending}
          >
            <Sparkles className="mr-1 h-3.5 w-3.5" />
            Use chat defaults
          </Button>
          <Button size="sm" variant="outline" onClick={() => reset.mutate()} disabled={reset.isPending}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            Reset
          </Button>
          <Button size="sm" onClick={() => save.mutate(draft)} disabled={!dirty || save.isPending}>
            <Save className="mr-1 h-3.5 w-3.5" />
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </header>

      {sourceInfo?.source === 'session' && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-warning/90 flex items-center gap-2">
          <Brain className="h-4 w-4 shrink-0" />
          Defaults pulled from your last chat session
          {sourceInfo.sessionId ? ` (${sourceInfo.sessionId.slice(0, 12)}…)` : ''}. Edit and Save to apply.
        </div>
      )}

      <section className="rounded-2xl border border-white/[0.06] bg-card/50 p-2 space-y-0.5">
        <h2 className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Toggles
        </h2>
        {BOOLEAN_KEYS.map((b) => (
          <SettingsToggle
            key={b.key}
            checked={!!draft[b.key]}
            onCheckedChange={(v) => update(b.key, v as never)}
            label={b.label}
            description={b.description}
          />
        ))}
      </section>

      <section className="rounded-2xl border border-white/[0.06] bg-card/50 p-4 space-y-5">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Limits
        </h2>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Max agent depth</label>
            <div className="flex gap-2">
              <div className="flex-1 min-w-0">
                <SettingsSelect
                  aria-label="Max agent depth preset"
                  value={
                    DEPTH_OPTIONS.some((o) => o.value === String(draft.maxAgentDepth))
                      ? String(draft.maxAgentDepth)
                      : 'custom'
                  }
                  onChange={(v) => {
                    if (v === 'custom') return;
                    update('maxAgentDepth', Math.max(1, Math.min(5, Number(v) || 1)));
                  }}
                  options={[...DEPTH_OPTIONS, { value: 'custom', label: 'Custom…' }]}
                />
              </div>
              <input
                type="number"
                min={1}
                max={5}
                value={draft.maxAgentDepth}
                onChange={(e) =>
                  update('maxAgentDepth', Math.max(1, Math.min(5, Number(e.target.value) || 1)))
                }
                aria-label="Max agent depth custom value"
                className="w-20 rounded-lg border border-white/[0.08] bg-card px-2 py-2 text-sm text-foreground tabular-nums outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/30"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Maximum nested sub-agent depth (1–5). Default 4. Pick a preset or type a value.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Max tool loops</label>
            <div className="flex gap-2">
              <div className="flex-1 min-w-0">
                <SettingsSelect
                  aria-label="Max tool loops preset"
                  value={
                    LOOP_OPTIONS.some((o) => o.value === String(draft.maxWorkbenchToolLoops))
                      ? String(draft.maxWorkbenchToolLoops)
                      : 'custom'
                  }
                  onChange={(v) => {
                    if (v === 'custom') return;
                    update(
                      'maxWorkbenchToolLoops',
                      Math.max(1, Math.min(500, Number(v) || 100)),
                    );
                  }}
                  options={[...LOOP_OPTIONS, { value: 'custom', label: 'Custom…' }]}
                />
              </div>
              <input
                type="number"
                min={1}
                max={500}
                value={draft.maxWorkbenchToolLoops}
                onChange={(e) =>
                  update(
                    'maxWorkbenchToolLoops',
                    Math.max(1, Math.min(500, Number(e.target.value) || 1)),
                  )
                }
                aria-label="Max tool loops custom value"
                className="w-24 rounded-lg border border-white/[0.08] bg-card px-2 py-2 text-sm text-foreground tabular-nums outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/30"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Tool calls one turn may emit (1–500). Default 100. Preset list or type any value.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function SourceBadge({ source, sessionId }: { source?: BrainConfigSource; sessionId?: string | null }) {
  if (!source) return null;
  if (source === 'persisted') {
    return <Badge variant="secondary" className="text-[10px]">Persisted</Badge>;
  }
  if (source === 'session') {
    return (
      <Badge variant="outline" className="text-[10px] border-warning/40 text-warning">
        From session {sessionId?.slice(0, 8) ?? ''}
      </Badge>
    );
  }
  return <Badge variant="outline" className="text-[10px]">Factory default</Badge>;
}

export default BrainSettings;
