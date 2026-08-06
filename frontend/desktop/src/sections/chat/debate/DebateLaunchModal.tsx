/* ── DebateLaunchModal — pick debaters, optional judge, rounds (A5) ──── */

import { useMemo, useState } from 'react';
import { Gavel, Minus, Plus, X } from 'lucide-react';
import type { ModelItem } from '../model-display';
import type { DebateLane } from './debate-store';

export function DebateLaunchModal({
  models,
  initialPrompt,
  onLaunch,
  onClose,
}: {
  models: ModelItem[];
  initialPrompt: string;
  onLaunch: (debaterA: DebateLane, debaterB: DebateLane, judge: DebateLane | null, rounds: number, prompt: string) => void;
  onClose: () => void;
}) {
  const [aId, setAId] = useState<string>(models[0]?.id ?? '');
  const [bId, setBId] = useState<string>(models[1]?.id ?? '');
  const [judgeId, setJudgeId] = useState<string>('');
  const [rounds, setRounds] = useState(3);
  const [prompt, setPrompt] = useState(initialPrompt);

  const laneFor = (id: string): DebateLane | null => {
    const m = models.find((x) => x.id === id);
    return m ? { modelId: m.id, modelName: m.name || m.id, provider: m.provider } : null;
  };

  const a = laneFor(aId);
  const b = laneFor(bId);
  const judge = judgeId ? laneFor(judgeId) : null;
  const canLaunch = !!a && !!b && a.modelId !== b.modelId && prompt.trim().length > 0;

  const select = (
    label: string,
    value: string,
    set: (v: string) => void,
    exclude: string[] = [],
  ) => (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground w-14 shrink-0">{label}</span>
      <select
        value={value}
        onChange={(e) => set(e.target.value)}
        className="flex-1 min-w-0 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
        data-testid={`debate-select-${label.toLowerCase()}`}
      >
        <option value="">—</option>
        {models
          .filter((m) => !exclude.includes(m.id))
          .map((m) => (
            <option key={m.id} value={m.id}>
              {m.name || m.id} ({m.provider})
            </option>
          ))}
      </select>
    </label>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Start a debate"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="debate-modal"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-popover p-4 shadow-xl space-y-3">
        <div className="flex items-center gap-2">
          <Gavel className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Structured debate</h3>
          <span className="text-[10px] text-muted-foreground/70 ml-auto">
            alternating turns in this chat
          </span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs resize-none"
          placeholder="The question or topic the two models will debate"
          aria-label="Debate prompt"
          data-testid="debate-prompt"
        />

        <div className="space-y-1.5">
          {select('Debater A', aId, setAId, [bId])}
          {select('Debater B', bId, setBId, [aId])}
          {select('Judge (optional)', judgeId, setJudgeId, [aId, bId])}
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground w-14 shrink-0">Rounds</span>
          <button
            type="button"
            onClick={() => setRounds((r) => Math.max(1, r - 1))}
            className="p-1 rounded bg-muted text-muted-foreground hover:text-foreground"
            aria-label="Fewer rounds"
          >
            <Minus className="size-3" />
          </button>
          <span className="w-8 text-center font-medium" data-testid="debate-rounds">
            {rounds}
          </span>
          <button
            type="button"
            onClick={() => setRounds((r) => Math.min(8, r + 1))}
            className="p-1 rounded bg-muted text-muted-foreground hover:text-foreground"
            aria-label="More rounds"
          >
            <Plus className="size-3" />
          </button>
          <span className="text-[10px] text-muted-foreground ml-1">
            {rounds} round{rounds === 1 ? '' : 's'} of alternating argument
            {judge ? ' + judge summary' : ''}
          </span>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded bg-muted text-muted-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canLaunch}
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-50"
            data-testid="debate-launch"
            onClick={() => a && b && onLaunch(a, b, judge, rounds, prompt.trim())}
          >
            <Gavel className="size-3 inline mr-1" />
            Start debate
          </button>
        </div>
      </div>
    </div>
  );
}
