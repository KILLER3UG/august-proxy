/* ── SubagentSpawnModal — composer launcher bound to the active session ── */
/* One spawn surface in chat: goal lines + agent role + effort. Launched
 * agents stream into THIS transcript (X-Session-Id binding) and render via
 * the inline SubagentLaunchList. */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bot, Loader2, Play, X } from 'lucide-react';
import * as subagents from '@/api/subagents';

const AGENT_OPTIONS = [
  { id: 'general', label: 'General', hint: 'General-purpose fallback' },
  { id: 'explore', label: 'Explore', hint: 'Read-only codebase exploration' },
  { id: 'plan', label: 'Plan', hint: 'Planning-focused' },
  { id: 'shell', label: 'Shell', hint: 'Command-oriented' },
];

const EFFORT_OPTIONS = ['low', 'medium', 'high', 'max'] as const;
type Effort = (typeof EFFORT_OPTIONS)[number];

export function SubagentSpawnModal({
  sessionId,
  open,
  onClose,
}: {
  sessionId?: string;
  open: boolean;
  onClose: () => void;
}) {
  const [goals, setGoals] = useState('');
  const [agent, setAgent] = useState('general');
  const [effort, setEffort] = useState<Effort>('medium');
  const qc = useQueryClient();

  const launch = useMutation({
    mutationFn: () =>
      subagents.spawn(
        {
          workItems: goals
            .split('\n')
            .map((g) => g.trim())
            .filter(Boolean)
            .map((goal) => ({ goal, agentId: agent, effort })),
          mode: 'auto',
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
              value={goals}
              onChange={(e) => setGoals(e.target.value)}
              rows={4}
              placeholder={'Find all callers of executeSubAgent\nSummarize the retry policy'}
              className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs outline-none focus:border-primary/50"
            />
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
          </div>
          {!sessionId && (
            <p className="text-[11px] text-amber-600">
              No active chat session — agents will not stream into a transcript.
            </p>
          )}
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
