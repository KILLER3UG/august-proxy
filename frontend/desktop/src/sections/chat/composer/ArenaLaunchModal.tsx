/* ── ArenaLaunchModal ─────────────────────────────────────────────────── */
/* "Ask in parallel": pick 2–3 models, one prompt → each model answers in
 * its own forked session; the sidebar shows all lanes, you pick the winner
 * to continue. Reuses branch + per-turn model override + SSE infra. */

import { useMemo, useState } from 'react';
import { Swords, X } from 'lucide-react';
import type { ModelItem } from '../model-display';

const MAX_LANES = 3;
const MIN_LANES = 2;

export function ArenaLaunchModal({
  models,
  initialPrompt,
  onLaunch,
  onClose,
}: {
  models: ModelItem[];
  initialPrompt: string;
  onLaunch: (targets: ModelItem[], prompt: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const m of models.slice(0, 2)) s.add(m.id);
    return s;
  });
  const [prompt, setPrompt] = useState(initialPrompt);

  const targets = useMemo(
    () => models.filter((m) => selected.has(m.id)),
    [models, selected],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_LANES) {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Ask in parallel"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="arena-modal"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-popover p-4 shadow-xl space-y-3">
        <div className="flex items-center gap-2">
          <Swords className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Ask in parallel</h3>
          <span className="text-[10px] text-muted-foreground/70 ml-auto">
            {targets.length}/{MAX_LANES} models
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
          placeholder="One prompt — every selected model answers it"
          aria-label="Arena prompt"
          data-testid="arena-prompt"
        />

        <ul className="space-y-1 max-h-56 overflow-y-auto">
          {models.map((m) => {
            const checked = selected.has(m.id);
            const disabled = !checked && selected.size >= MAX_LANES;
            return (
              <li key={m.id}>
                <label
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs cursor-pointer hover:bg-muted/40 ${
                    disabled ? 'opacity-40 cursor-not-allowed' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggle(m.id)}
                    className="accent-primary"
                    data-testid={`arena-model-${m.id}`}
                  />
                  <span className="flex-1 min-w-0 truncate">{m.name || m.id}</span>
                  <span className="text-[10px] text-muted-foreground truncate max-w-40">
                    {m.provider}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

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
            disabled={targets.length < MIN_LANES || !prompt.trim()}
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-50"
            data-testid="arena-launch"
            onClick={() => onLaunch(targets, prompt.trim())}
          >
            <Swords className="size-3 inline mr-1" />
            Launch {targets.length} lane{targets.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
