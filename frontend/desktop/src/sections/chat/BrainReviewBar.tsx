/* Selected-model memory review — improve / remove / enhance, user applies. */

import { useEffect, useState } from 'react';
import { Brain, Check, Loader2, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';

interface ImproveItem {
  id: number;
  rewritten: string;
  why?: string;
}
interface RemoveItem {
  id: number;
  why?: string;
}
interface EnhanceItem {
  content: string;
  why?: string;
}

interface ReviewResult {
  model?: string;
  message?: string;
  improve?: ImproveItem[];
  remove?: RemoveItem[];
  enhance?: EnhanceItem[];
}

const LAST_KEY = 'august-memory-review-at';
const NUDGE_MS = 36 * 60 * 60 * 1000;

function stampReview() {
  try {
    localStorage.setItem(LAST_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

function shouldNudge(): boolean {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return true;
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() - at > NUDGE_MS;
  } catch {
    return false;
  }
}

export function BrainReviewBar({
  modelId,
  turnCount,
}: {
  modelId?: string | null;
  turnCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ReviewResult | null>(null);

  useEffect(() => {
    if ((turnCount ?? 0) >= 6 && shouldNudge()) setNudge(true);
  }, [turnCount]);

  const run = () => {
    if (running) return;
    setRunning(true);
    setOpen(true);
    setNudge(false);
    stampReview();
    void api
      .post<ReviewResult>('/api/memory/review', { model: modelId || '' })
      .then((res) => setResult(res))
      .catch(() => {
        toast.error('Memory review failed');
        setResult({ message: 'Could not reach the selected model.' });
      })
      .finally(() => setRunning(false));
  };

  const apply = (kind: string, extra: Record<string, unknown>) => {
    void api
      .post('/api/memory/review/apply', { actions: [{ kind, ...extra }] })
      .then(() => {
        toast.success(
          kind === 'remove' ? 'Removed' : kind === 'enhance' ? 'Always include' : 'Updated',
        );
        setResult((cur) => {
          if (!cur) return cur;
          if (kind === 'improve') {
            return { ...cur, improve: (cur.improve ?? []).filter((i) => i.id !== extra.id) };
          }
          if (kind === 'remove') {
            return { ...cur, remove: (cur.remove ?? []).filter((i) => i.id !== extra.id) };
          }
          return {
            ...cur,
            enhance: (cur.enhance ?? []).filter((i) => i.content !== extra.content),
          };
        });
      })
      .catch(() => toast.error('Could not apply'));
  };

  if (!open && !nudge) {
    return (
      <div className="mb-1.5">
        <button
          type="button"
          onClick={run}
          disabled={running}
          data-testid="brain-review-chip"
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/40 transition disabled:opacity-50"
        >
          {running ? <Loader2 className="size-3 animate-spin" /> : <Brain className="size-3 text-primary" />}
          Review what I remember
        </button>
      </div>
    );
  }

  if (!open && nudge) {
    return (
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5" data-testid="brain-review-nudge">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
          <Sparkles className="size-3 text-primary" />
          Memory
        </span>
        <button
          type="button"
          onClick={run}
          className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] text-foreground hover:bg-primary/15"
        >
          Let {modelId ? 'this model' : 'August'} review memories
        </button>
        <button
          type="button"
          className="p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => {
            setNudge(false);
            stampReview();
          }}
          aria-label="Dismiss memory review nudge"
        >
          <X className="size-3" />
        </button>
      </div>
    );
  }

  const improve = result?.improve ?? [];
  const remove = result?.remove ?? [];
  const enhance = result?.enhance ?? [];
  const empty =
    !running && result && improve.length === 0 && remove.length === 0 && enhance.length === 0;

  return (
    <div
      className="mb-2 rounded-xl border border-border/50 bg-muted/15 px-2.5 py-2 space-y-2"
      data-testid="brain-review-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground/85 inline-flex items-center gap-1.5">
          {running ? <Loader2 className="size-3 animate-spin" /> : <Brain className="size-3 text-primary" />}
          Memory review
          {result?.model ? (
            <span className="font-mono text-[10px] text-muted-foreground/70">{result.model}</span>
          ) : null}
        </span>
        <button
          type="button"
          className="p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => {
            setOpen(false);
            setResult(null);
          }}
          aria-label="Close memory review"
        >
          <X className="size-3" />
        </button>
      </div>
      {running ? (
        <p className="text-[12px] text-muted-foreground">Reading brain and memories…</p>
      ) : empty ? (
        <p className="text-[12px] text-muted-foreground">{result?.message || 'Looks healthy.'}</p>
      ) : (
        <ul className="space-y-1.5">
          {improve.map((item) => (
            <li
              key={`i-${item.id}`}
              className="flex items-start gap-2 rounded-lg border border-border/40 bg-background/40 px-2 py-1.5 text-[12px]"
            >
              <Wand2 className="mt-0.5 size-3 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Improve</div>
                <p className="text-foreground/90">{item.rewritten}</p>
                {item.why ? <p className="text-[11px] text-muted-foreground">{item.why}</p> : null}
              </div>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-success hover:bg-success/10"
                title="Apply rewrite"
                onClick={() => apply('improve', { id: item.id, rewritten: item.rewritten })}
              >
                <Check className="size-3.5" />
              </button>
            </li>
          ))}
          {remove.map((item) => (
            <li
              key={`r-${item.id}`}
              className="flex items-start gap-2 rounded-lg border border-border/40 bg-background/40 px-2 py-1.5 text-[12px]"
            >
              <Trash2 className="mt-0.5 size-3 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Remove</div>
                <p className="text-muted-foreground">{item.why || `Memory #${item.id}`}</p>
              </div>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-destructive hover:bg-destructive/10"
                title="Delete this memory"
                onClick={() => apply('remove', { id: item.id })}
              >
                <Check className="size-3.5" />
              </button>
            </li>
          ))}
          {enhance.map((item) => (
            <li
              key={`e-${item.content.slice(0, 24)}`}
              className="flex items-start gap-2 rounded-lg border border-border/40 bg-background/40 px-2 py-1.5 text-[12px]"
            >
              <Sparkles className="mt-0.5 size-3 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Always include</div>
                <p className="text-foreground/90">{item.content}</p>
                {item.why ? <p className="text-[11px] text-muted-foreground">{item.why}</p> : null}
              </div>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-success hover:bg-success/10"
                title="Pin as always-include"
                onClick={() => apply('enhance', { content: item.content })}
              >
                <Check className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
