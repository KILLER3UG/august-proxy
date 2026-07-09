/* ── BrainSettings ────────────────────────────────────────────────────── */
/* User-tunable Brain Orchestrator knobs.                                  */
/*                                                                          */
/* On first mount, the form is pre-populated with the brain policy of the    */
/* user's most recent chat session (banner: "Defaults pulled from your last */
/* chat session"). Subsequent edits persist to cfg.brainOrchestrator.        */

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Brain, RotateCcw, Save, Sparkles, Check, X } from 'lucide-react';
import {
  getBrainConfig,
  saveBrainConfig,
  resetBrainConfig,
  getBrainConfigFromSession,
  type BrainConfig,
  type BrainConfigResponse,
  type BrainConfigSource,
} from '@/api/workbench';
import { toast } from 'sonner';

const BOOLEAN_KEYS: { key: keyof BrainConfig; label: string; description: string }[] = [
  { key: 'enabled',                    label: 'Master switch',                 description: 'Turns the brain orchestrator on or off. When off, the model runs without per-turn policy injection.' },
  { key: 'adaptivePolicy',             label: 'Adaptive policy',              description: 'When on, the orchestrator picks a per-turn policy (debug / research / code edit / …) based on the user message.' },
  { key: 'failureLearning',            label: 'Failure learning',              description: 'Surface past tool-failure hints in the system prompt so the model avoids the same mistake.' },
  { key: 'graphMemory',                label: 'Graph memory',                  description: 'Pull graph-memory observations (entities + relations) into context.' },
  { key: 'agentJobs',                  label: 'Agent jobs persistence',        description: 'Persist every sub-agent invocation to disk so they show up in the Agents tab and audit log.' },
  { key: 'hierarchicalAgents',         label: 'Hierarchical agents',           description: 'Allow sub-agents to spawn their own children (project_manager → team).' },
  { key: 'adapterParallelTools',       label: 'Adapter parallel tools',        description: 'Run tool calls in parallel when the provider supports it.' },
  { key: 'parallelReadTools',          label: 'Parallel read-only tools',      description: 'Allow the model to fire multiple read-only tool calls in a single turn.' },
  { key: 'reviewLearnedGuidelines',    label: 'Review learned guidelines',     description: 'Surface pending learned guidelines in the system prompt for the user to accept or reject.' },
];

export function BrainSettings() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<BrainConfig | null>(null);
  const [sourceInfo, setSourceInfo] = useState<BrainConfigResponse | null>(null);

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

  const save = useMutation({
    mutationFn: (updates: Partial<BrainConfig>) => saveBrainConfig(updates),
    onSuccess: (res) => {
      setDraft(res.config);
      queryClient.invalidateQueries({ queryKey: ['brain-config'] });
      queryClient.invalidateQueries({ queryKey: ['brain-policy'] });
      toast.success('Brain config saved — next turn will use the new policy.');
    },
    onError: (e: Error) => toast.error(e.message || 'Save failed'),
  });

  const reset = useMutation({
    mutationFn: () => resetBrainConfig(),
    onSuccess: (res) => {
      setDraft(res.config);
      queryClient.invalidateQueries({ queryKey: ['brain-config'] });
      toast.message('Reset to factory defaults');
    },
    onError: (e: Error) => toast.error(e.message || 'Reset failed'),
  });

  const pullFromSession = useMutation({
    mutationFn: () => (data?.sessionId ? getBrainConfigFromSession(data.sessionId) : Promise.reject(new Error('No session'))),
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
        className="p-6 text-sm text-destructive flex items-center gap-3"
        data-testid="brain-settings-error"
      >
        <span>Could not load brain config: {(error)?.message || 'unknown error'}</span>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (isLoading || !draft) {
    return <div className="p-6 text-sm text-muted-foreground">Loading brain config…</div>;
  }

  const update = <K extends keyof BrainConfig>(key: K, value: BrainConfig[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(data?.config);

  return (
    <div className="p-6 space-y-4 h-full overflow-auto" data-testid="brain-settings-page">
      <SectionHeader
        title="Brain Orchestrator"
        subtitle="Tune the policy the model uses on every turn. Defaults are pulled from your most recent chat session when available."
        actions={
          <div className="flex items-center gap-2">
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
            <Button
              size="sm"
              variant="outline"
              onClick={() => reset.mutate()}
              disabled={reset.isPending}
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              Reset
            </Button>
            <Button
              size="sm"
              onClick={() => save.mutate(draft)}
              disabled={!dirty || save.isPending}
            >
              <Save className="mr-1 h-3.5 w-3.5" />
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        }
      />

      {sourceInfo?.source === 'session' && (
        <Card className="border-warning/30 bg-warning/5">
          <CardContent className="text-xs text-warning/90 p-3 flex items-center gap-2">
            <Brain className="h-4 w-4" />
            Defaults pulled from your last chat session
            {sourceInfo.sessionId ? ` (id: ${sourceInfo.sessionId.slice(0, 12)}…)` : ''}.
            Edit any value and click Save to apply.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Toggles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {BOOLEAN_KEYS.map((b) => (
            <div key={b.key} className="flex items-start gap-3 py-1.5 border-b border-border/30 last:border-0">
              <label className="flex items-center gap-2 cursor-pointer min-w-[200px]">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={!!draft[b.key]}
                  onChange={(e) => update(b.key, e.target.checked as never)}
                />
                <span className="text-sm font-medium">{b.label}</span>
              </label>
              <span className="text-xs text-muted-foreground flex-1">{b.description}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Limits</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium min-w-[200px]">Max agent depth</label>
            <Input
              type="number"
              min={1}
              max={5}
              value={draft.maxAgentDepth}
              onChange={(e) => update('maxAgentDepth', Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
              className="w-24"
            />
            <span className="text-xs text-muted-foreground">
              Maximum nested sub-agent depth. Default 4.
            </span>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium min-w-[200px]">Max tool loops</label>
            <Input
              type="number"
              min={1}
              max={500}
              value={draft.maxWorkbenchToolLoops}
              onChange={(e) => update('maxWorkbenchToolLoops', Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
              className="w-24"
            />
            <span className="text-xs text-muted-foreground">
              How many tool calls one turn may emit before the workbench stops. Default 100. Safety nets stop sooner if the token budget is exhausted or the same tool call repeats.
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SourceBadge({ source, sessionId }: { source?: BrainConfigSource; sessionId?: string | null }) {
  if (!source) return null;
  if (source === 'persisted') {
    return <Badge variant="secondary" className="text-[10px]">Persisted</Badge>;
  }
  if (source === 'session') {
    return <Badge variant="outline" className="text-[10px] border-warning/40 text-warning">From session {sessionId?.slice(0, 8) ?? ''}</Badge>;
  }
  return <Badge variant="outline" className="text-[10px]">Factory default</Badge>;
}

export default BrainSettings;