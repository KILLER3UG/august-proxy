/* Evolving skills strip shown above the chat thread.
 * Persistent-memory banner removed per product request. */
import { Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLearningData } from '@/hooks/useLearningData';
import { cn } from '@/lib/utils';

/**
 * Surfaces collaboration intelligence:
 * - Evolving skills (pending genesis / auto-authored skills)
 */
export function CollaborationInsights({ className }: { className?: string }) {
  const { data } = useLearningData();
  if (!data) return null;

  const pending = data.pendingSkills ?? [];
  if (pending.length === 0) return null;

  return (
    <div
      className={cn('px-4 pt-2 space-y-2', className)}
      data-testid="collaboration-insights"
    >
      <div
        className="rounded-lg border border-primary/25 bg-primary/8 px-3 py-2 text-xs flex gap-2 items-start"
        data-testid="evolving-skills-banner"
      >
        <Sparkles className="size-3.5 text-primary shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="font-medium text-foreground/90">Evolving skills</div>
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
            to="/settings/skills"
            className="inline-flex text-[11px] text-primary hover:underline"
          >
            Review in Skills →
          </Link>
        </div>
      </div>
    </div>
  );
}
