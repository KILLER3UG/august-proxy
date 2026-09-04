/* ── ArenaLaunchModal ─────────────────────────────────────────────────── */
/* "Ask in parallel": pick 2–3 models, one prompt → each model answers in
 * its own forked session; the split-pane overlay streams all lanes and you
 * pick the winner to continue. Supports saved templates (A3, localStorage). */

import { useEffect, useMemo, useState } from 'react';
import { Bookmark, History, Sparkles, Swords, X } from 'lucide-react';
import { api } from '@/api/client';
import type { ModelItem } from '../model-display';
import { openArenaArchive } from '../arena/arena-store';

const MAX_LANES = 3;
const MIN_LANES = 2;
const TEMPLATES_KEY = 'august_arena_templates';

export interface ArenaTemplate {
  id: string;
  name: string;
  modelIds: string[];
  prompt: string;
  savedAt: number;
}

function loadTemplates(): ArenaTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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
  const [templates, setTemplates] = useState<ArenaTemplate[]>(loadTemplates);
  const [templateName, setTemplateName] = useState('');
  // Routing-evidence hint (surpass #1): "for 'tests' tasks, X wins 7/9".
  // Backend sends `modelId` (Part 26 7.2 — the old `.model` reads rendered
  // blank chips and React duplicate-key warnings).
  const [suggestions, setSuggestions] = useState<
    Array<{ modelId: string; wins: number; total: number; winRate: number; avgTokens: number }>
  >([]);

  // Escape closes (Phase 4 — modal keyboard coverage).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!prompt.trim()) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      void api
        .get<{
          taskType: string;
          suggestions: Array<{
            modelId: string;
            wins: number;
            total: number;
            winRate: number;
            avgTokens: number;
          }>;
        }>(`/api/brain/routing/suggestions?prompt=${encodeURIComponent(prompt.trim())}`)
        .then((res) => setSuggestions(res.suggestions ?? []))
        .catch(() => setSuggestions([]));
    }, 400);
    return () => clearTimeout(timer);
  }, [prompt]);

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

  const saveTemplate = () => {
    const name = templateName.trim() || `${targets.length} models`;
    const template: ArenaTemplate = {
      id: `tpl_${Date.now()}`,
      name,
      modelIds: targets.map((m) => m.id),
      prompt,
      savedAt: Date.now(),
    };
    const next = [template, ...templates].slice(0, 12);
    setTemplates(next);
    try {
      localStorage.setItem(TEMPLATES_KEY, JSON.stringify(next));
    } catch {
      /* storage full / unavailable */
    }
    setTemplateName('');
  };

  const applyTemplate = (t: ArenaTemplate) => {
    setSelected(new Set(t.modelIds.filter((id) => models.some((m) => m.id === id))));
    setPrompt(t.prompt);
  };

  const deleteTemplate = (id: string) => {
    const next = templates.filter((t) => t.id !== id);
    setTemplates(next);
    try {
      localStorage.setItem(TEMPLATES_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  // Keep the default selection in sync when the catalog loads after mount.
  useEffect(() => {
    if (selected.size === 0 && models.length > 0) {
      setSelected(new Set(models.slice(0, 2).map((m) => m.id)));
    }
  }, [models, selected.size]);

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
            onClick={() => {
              onClose();
              openArenaArchive();
            }}
            className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
            data-testid="arena-open-archive"
          >
            <History className="size-3" />
            Archive
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-3.5" />
          </button>
        </div>

        {/* Saved templates (A3) */}
        {templates.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Bookmark className="size-3 text-muted-foreground" />
            {templates.map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10px]"
              >
                <button
                  type="button"
                  onClick={() => applyTemplate(t)}
                  title={t.prompt}
                  className="hover:text-primary"
                  data-testid={`arena-template-${t.id}`}
                >
                  {t.name}
                </button>
                <button
                  type="button"
                  onClick={() => deleteTemplate(t.id)}
                  className="text-muted-foreground hover:text-danger"
                  aria-label={`Delete template ${t.name}`}
                >
                  <X className="size-2.5" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs resize-none"
          placeholder="One prompt — every selected model answers it"
          aria-label="Arena prompt"
          data-testid="arena-prompt"
        />

        {/* Routing-evidence hint (surpass #1) */}
        {suggestions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="arena-routing-hint">
            <Sparkles className="size-3 text-primary" />
            {suggestions.slice(0, 2).map((s) => (
              <span
                key={s.modelId}
                className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary"
                title={`${s.wins}/${s.total} wins · ${s.avgTokens} avg tokens`}
              >
                {s.modelId} wins {s.wins}/{s.total} · {s.avgTokens} tok avg
              </span>
            ))}
          </div>
        ) : null}

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

        <div className="flex items-center gap-2">
          <input
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && targets.length >= MIN_LANES) saveTemplate();
            }}
            className="flex-1 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px]"
            placeholder="Save this selection as a template…"
            aria-label="Template name"
            data-testid="arena-template-name"
          />
          <button
            type="button"
            onClick={saveTemplate}
            disabled={targets.length < MIN_LANES}
            className="text-xs px-2.5 py-1.5 rounded bg-muted text-muted-foreground disabled:opacity-50 shrink-0"
          >
            <Bookmark className="size-3 inline mr-1" />
            Save
          </button>
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
