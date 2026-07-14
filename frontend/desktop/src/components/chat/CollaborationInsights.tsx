/* Evolving skills + persistent memory strip shown above the chat thread. */
import { Brain, Sparkles, BookMarked } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLearningData } from '@/hooks/useLearningData';
import { cn } from '@/lib/utils';

function factPreview(coreFacts: unknown): string[] {
  if (!coreFacts) return [];
  if (Array.isArray(coreFacts)) {
    return coreFacts
      .map((f) => (typeof f === 'string' ? f : typeof f === 'object' && f && 'fact' in f ? String((f as { fact: unknown }).fact) : JSON.stringify(f)))
      .filter(Boolean)
      .slice(0, 4);
  }
  if (typeof coreFacts === 'object') {
    return Object.values(coreFacts as Record<string, unknown>)
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .filter(Boolean)
      .slice(0, 4);
  }
  if (typeof coreFacts === 'string') return [coreFacts.slice(0, 160)];
  return [];
}

/**
 * Surfaces collaboration intelligence:
 * - Evolving skills (pending genesis / auto-authored skills)
 * - Persistent memory (auto-memories + core facts the agent already knows)
 */
export function CollaborationInsights({ className }: { className?: string }) {
  const { data } = useLearningData();
  if (!data) return null;

  const pending = data.pendingSkills ?? [];
  const memories = data.autoMemories ?? [];
  const facts = factPreview(data.coreFacts);
  const remembered = [
    ...memories.slice(0, 3).map((m) => m.content),
    ...facts,
  ].filter(Boolean).slice(0, 4);

  if (pending.length === 0 && remembered.length === 0) return null;

  return (
    <div
      className={cn('px-4 pt-2 space-y-2', className)}
      data-testid="collaboration-insights"
    >
      {pending.length > 0 && (
        <div
          className="rounded-lg border border-primary/25 bg-primary/8 px-3 py-2 text-xs flex gap-2 items-start"
          data-testid="evolving-skills-banner"
        >
          <Sparkles className="size-3.5 text-primary shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="font-medium text-foreground/90">
              Evolving skills
            </div>
            <p className="text-muted-foreground leading-relaxed">
              August is learning as you collaborate — turning complex work into skills made for you.
              {pending.length === 1
                ? ` Draft ready: ${pending[0].name}.`
                : ` ${pending.length} skill drafts ready for review.`}
            </p>
            <ul className="flex flex-wrap gap-1.5 pt-0.5">
              {pending.slice(0, 4).map((s) => (
                <li
                  key={s.id}
                  className="rounded-full border border-primary/20 bg-background/40 px-2 py-0.5 font-mono text-[10px] text-primary"
                  title={s.description || s.name}
                >
                  {s.name}
                </li>
              ))}
            </ul>
            <Link
              to="/settings/skill-curator"
              className="inline-flex text-[11px] text-primary hover:underline"
            >
              Review in Skills →
            </Link>
          </div>
        </div>
      )}

      {remembered.length > 0 && (
        <div
          className="rounded-lg border border-emerald-500/20 bg-emerald-500/8 px-3 py-2 text-xs flex gap-2 items-start"
          data-testid="persistent-memory-banner"
        >
          <Brain className="size-3.5 text-emerald-400 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="font-medium text-foreground/90 flex items-center gap-1.5">
              <BookMarked className="size-3 text-emerald-400/80" />
              Persistent memory
            </div>
            <p className="text-muted-foreground leading-relaxed">
              August remembers what you have shared so you never have to repeat yourself.
            </p>
            <ul className="space-y-0.5 pt-0.5">
              {remembered.map((line, i) => (
                <li
                  key={i}
                  className="text-[11px] text-foreground/75 truncate"
                  title={line}
                >
                  · {line}
                </li>
              ))}
            </ul>
            <Link
              to="/settings/memory-knowledge"
              className="inline-flex text-[11px] text-emerald-400 hover:underline"
            >
              Open memory →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
