/* ── SubagentSpawnModal — composer launcher bound to the active session ── */
/* One spawn surface in chat: goal lines + agent role + effort. Launched
 * agents stream into THIS transcript (X-Session-Id binding) and render via
 * the inline SubagentLaunchList. */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bot, ChevronDown, Loader2, Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as subagents from '@/api/subagents';
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

export function SubagentSpawnModal({
  sessionId,
  open,
  onClose,
  models,
}: {
  sessionId?: string;
  open: boolean;
  onClose: () => void;
  /** Model fleet for the per-launch model override (empty = inherit). */
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
  const goalsRef = useRef<HTMLTextAreaElement | null>(null);
  const qc = useQueryClient();

  // Escape closes; the goals textarea takes focus on open.
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

  // Per-launch advanced options apply to EVERY work item (the goals
  // textarea is one prompt per line — per-item editors would need a
  // structured form; the shared advanced block covers the common cases).
  const parsedSchema = (() => {
    const text = yieldSchema.trim();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null; // invalid JSON — validation hint below
    }
  })();
  const schemaInvalid = parsedSchema === null;
  const toolsList = restrictedTools
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const launch = useMutation({
    mutationFn: () =>
      subagents.spawn(
        {
          workItems: goals
            .split('\n')
            .map((g) => g.trim())
            .filter(Boolean)
            .map((goal) => ({
              goal,
              agentId: agent,
              effort,
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
          : 'Launched — watch the subagent list in chat',
      );
      onClose();
      setGoals('');
      void qc.invalidateQueries({ queryKey: ['subagent-runs'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Launch failed'),
  });

  if (!open) return null;

  const items = goals
    .split('\n')
    .map((g) => g.trim())
    .filter(Boolean).length;

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
          <h2 className="text-sm font-semibold">Spawn sub-agents</h2>
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
              Goals — one per line
            </label>
            <textarea
              id="spawn-goals"
              ref={goalsRef}
              value={goals}
              onChange={(e) => setGoals(e.target.value)}
              rows={4}
              placeholder={'Find all callers of executeSubAgent\nSummarize the retry policy'}
              className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs outline-none focus:border-primary/50"
            />
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
              Proposed — approve the breakdown first
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
              <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                {AGENT_OPTIONS.find((a) => a.id === agent)?.hint}
              </p>
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
              <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                {effort === 'max' ? 'Deepest reasoning (slowest, most thorough)' : `${effort} thinking budget`}
              </p>
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
              <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                Override for every work item
              </p>
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
                    Shared context (appended to every goal)
                  </label>
                  <textarea
                    id="spawn-context"
                    value={context}
                    onChange={(e) => setContext(e.target.value)}
                    rows={2}
                    placeholder={'Focus on the backend. Report file:line references.'}
                    className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground" htmlFor="spawn-restrict">
                    Restricted tools (denylist, comma-separated)
                  </label>
                  <input
                    id="spawn-restrict"
                    value={restrictedTools}
                    onChange={(e) => setRestrictedTools(e.target.value)}
                    placeholder={'web_search, browser, delete_file'}
                    className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground" htmlFor="spawn-schema">
                    yieldSchema (JSON — each subagent returns a validated object)
                  </label>
                  <textarea
                    id="spawn-schema"
                    value={yieldSchema}
                    onChange={(e) => setYieldSchema(e.target.value)}
                    rows={4}
                    placeholder={'{\n  "type": "object",\n  "required": ["summary"],\n  "properties": { "summary": { "type": "string" } }\n}'}
                    className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-primary/50"
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
            disabled={items === 0 || launch.isPending}
            onClick={() => launch.mutate()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            data-testid="spawn-launch-button"
          >
            {launch.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Play className="size-3" />
            )}
            Launch {items > 0 ? `${items} sub-agent${items === 1 ? '' : 's'}` : 'sub-agents'}
          </button>
        </div>
      </div>
    </div>
  );
}
