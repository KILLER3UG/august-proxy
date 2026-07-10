/**
 * InitAugCard — preview UI for the `/init` AUG.md flow.
 *
 * Shows the LLM-generated (or refined) AUG.md draft and lets the user
 * confirm (save), regenerate, or cancel. When refining an existing file,
 * a side-by-side diff is shown so the user can see what will change.
 */
import { useState } from 'react';
import { Markdown } from './ChatMarkdown';
import { api } from '@/api/client';
import { voiceCommandEvents } from '@/api/voice/registry-events';
import { Check, RefreshCw, X } from 'lucide-react';

interface InitAugCardProps {
  draft: string;
  existing: boolean;
  workspacePath: string;
  sessionId?: string;
}

function simpleDiff(existing: string, next: string): { type: 'same' | 'add' | 'del'; text: string }[] {
  const a = existing.split('\n');
  const b = next.split('\n');
  const out: { type: 'same' | 'add' | 'del'; text: string }[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right) out.push({ type: 'same', text: right ?? '' });
    else {
      if (left !== undefined) out.push({ type: 'del', text: left });
      if (right !== undefined) out.push({ type: 'add', text: right });
    }
  }
  return out;
}

export function InitAugCard({ draft, existing, workspacePath, sessionId }: InitAugCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentDraft, setCurrentDraft] = useState(draft);
  const [currentExisting, _setCurrentExisting] = useState(existing);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  async function regenerate() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ draft: string; existing: boolean }>('/api/aug/init', {
        mode: currentExisting ? 'refine' : 'create',
        workspacePath: workspacePath || undefined,
      });
      setCurrentDraft(res.draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to regenerate');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.put<{ path: string }>('/api/aug/content', {
        content: currentDraft,
        workspacePath: workspacePath || undefined,
        sessionId: sessionId || undefined,
      });
      setSavedPath(res.path);
      voiceCommandEvents.emit({ type: 'aug-saved', path: res.path });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save AUG.md');
    } finally {
      setBusy(false);
    }
  }

  function close() {
    voiceCommandEvents.emit({ type: 'reset-session' } as never);
  }

  if (savedPath) {
    return (
      <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
        <p className="font-medium text-emerald-300">AUG.md saved to:</p>
        <code className="block mt-1 break-all text-xs text-emerald-200/80">{savedPath}</code>
        <p className="mt-2 text-emerald-200/70">
          It will be loaded into the system prompt on your next message.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">
            {currentExisting ? 'Refine AUG.md' : 'Initialize AUG.md'}
          </h3>
          <p className="text-xs text-zinc-400">
            {workspacePath ? workspacePath : 'project root'}
          </p>
        </div>
        <button
          onClick={close}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          aria-label="Dismiss"
        >
          <X size={16} />
        </button>
      </div>

      {currentExisting ? (
        <div className="mb-3 max-h-72 overflow-auto rounded border border-zinc-800 bg-black/30 p-2 text-xs">
          {simpleDiff(draft, currentDraft).map((line, i) => (
            <div
              key={i}
              className={
                line.type === 'add'
                  ? 'text-emerald-300'
                  : line.type === 'del'
                    ? 'text-rose-300 line-through'
                    : 'text-zinc-500'
              }
            >
              <span className="select-none opacity-60">
                {line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}
              </span>
              {line.text}
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-3 max-h-72 overflow-auto rounded border border-zinc-800 bg-black/30 p-3">
          <Markdown content={currentDraft} />
        </div>
      )}

      {error && <p className="mb-2 text-xs text-rose-400">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={() => { void save(); }}
          disabled={busy}
          className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          <Check size={14} /> {currentExisting ? 'Refine & Save' : 'Save AUG.md'}
        </button>
        <button
          onClick={() => { void regenerate(); }}
          disabled={busy}
          className="flex items-center gap-1 rounded bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-600 disabled:opacity-50"
        >
          <RefreshCw size={14} /> Regenerate
        </button>
        <button
          onClick={close}
          disabled={busy}
          className="ml-auto rounded px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
