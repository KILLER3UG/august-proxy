/* One workstream episode — summary, next, unmet acceptance. */

import { cn } from '@/lib/utils';
import type { WorkstreamEpisode } from '@/api/subagents';

export function EpisodeCard({
  episode,
  onContinue,
  onSaveRoutine,
  onSaveSkill,
}: {
  episode: WorkstreamEpisode;
  onContinue?: (next: string) => void;
  onSaveRoutine?: (seq: number) => void;
  onSaveSkill?: (seq: number) => void;
}) {
  const st = (episode.status || '').toLowerCase();
  return (
    <div
      className={cn(
        'rounded-lg border px-2 py-1.5 text-[11px]',
        st === 'completed' && 'border-success/25 bg-success/5',
        st === 'partial' && 'border-warning/30 bg-warning/5',
        st === 'blocked' && 'border-destructive/30 bg-destructive/5',
        !st && 'border-border/40',
      )}
      data-testid={`episode-card-${episode.seq}`}
    >
      <div className="flex items-center gap-1.5 font-mono text-muted-foreground">
        <span>#{episode.seq}</span>
        <span>{episode.status || 'open'}</span>
        {episode.criteriaMet ? <span className="text-success">criteria</span> : null}
        <span className="ml-auto flex gap-1.5">
          {onSaveSkill ? (
            <button
              type="button"
              className="text-[10px] underline-offset-2 hover:underline"
              onClick={() => onSaveSkill(episode.seq)}
            >
              Save skill
            </button>
          ) : null}
          {onSaveRoutine ? (
            <button
              type="button"
              className="text-[10px] underline-offset-2 hover:underline"
              onClick={() => onSaveRoutine(episode.seq)}
            >
              Save routine
            </button>
          ) : null}
        </span>
      </div>
      {episode.summary ? (
        <p className="mt-0.5 whitespace-pre-wrap text-foreground/85">{episode.summary}</p>
      ) : null}
      {episode.unmet ? (
        <p className="mt-0.5 text-warning">Unmet: {episode.unmet}</p>
      ) : null}
      {episode.next ? (
        <p className="mt-0.5 text-muted-foreground">
          Next: {episode.next}
          {onContinue ? (
            <button
              type="button"
              className="ml-1 underline-offset-2 hover:underline"
              onClick={() => onContinue(episode.next || '')}
            >
              Continue
            </button>
          ) : null}
        </p>
      ) : null}
      {episode.autoHop ? (
        <p className="mt-0.5 text-[10px] text-muted-foreground/70">continued automatically</p>
      ) : null}
      {(episode.skills?.length ?? 0) > 0 ? (
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground/70">
          {episode.skills!.join(' · ')}
        </p>
      ) : null}
    </div>
  );
}
