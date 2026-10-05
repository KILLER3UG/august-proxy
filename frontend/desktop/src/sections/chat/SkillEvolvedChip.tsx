/* ── SkillEvolvedChip — August changed a skill by itself ──────────────────── */
/* Item 15. One line above the composer naming the skill it changed, with the
 * undo attached, and a disclosure for the rest.
 *
 * It reads the same query the settings history reads (`harness-auto-history`),
 * and the rails invalidate that key when they apply — so a change made by the
 * six-hour job reaches a window that is already open, and a change made while
 * the app was closed is here on the next load. One store, one signal.
 *
 * Three things this deliberately does not do:
 *   * appear while autonomy is off. The settings history keeps the record; a
 *     chip in the chat column is a claim about what the machine is doing now.
 *   * offer an undo it cannot perform. A created skill has no previous version
 *     to put back, so the chip says what happened and stops there — inventing a
 *     "delete it" write to fill the button is exactly the second-write-path
 *     mistake the version history was built to avoid.
 *   * announce a human's approval. The backend only records reviewer-applied
 *     changes, so there is nothing here about work a person decided.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, X } from 'lucide-react';
import {
  getAutoApplyHistory,
  restoreSkillVersion,
  type AutoAppliedChange,
} from '@/api/api-client/skills-versions';
import { formatTimeAgo } from '@/lib/utils';

const DISMISS_KEY = 'august.skill-evolved.dismissed-at';

/** Watermark, not a per-id list: dismissing the newest also quiets the older
 *  ones, which is what "I have seen this" means for a stack of the same news. */
function dismissedAt(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) ?? '';
  } catch {
    return ''; // storage unavailable (private mode) — show the chip, never throw
  }
}

function rememberDismissedAt(at: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, at);
  } catch {
    // Losing the dismissal is a re-show on next load, not a broken chip.
  }
}

export function SkillEvolvedChip() {
  const [open, setOpen] = useState(false);
  // localStorage alone would not re-render, so the dismissal needs local state
  // as well: the watermark is what keeps it quiet on the NEXT load.
  const [dismissed, setDismissed] = useState(false);
  const queryClient = useQueryClient();

  const historyQ = useQuery({
    queryKey: ['harness-auto-history'],
    queryFn: () => getAutoApplyHistory(20),
    staleTime: 30_000,
  });
  const data = historyQ.data;
  const changes = data?.changes ?? [];
  const newest: AutoAppliedChange | null = changes[0] ?? null;
  const visible = Boolean(data?.autonomy && newest && newest.at > dismissedAt()) && !dismissed;

  const hide = (at: string) => {
    rememberDismissedAt(at);
    setDismissed(true);
    setOpen(false);
  };

  const undo = useMutation({
    mutationFn: () =>
      restoreSkillVersion(newest?.skill ?? '', newest?.versionTs ?? ''),
    onSuccess: () => {
      // The announce was for this change; once it is undone it has been said.
      hide(newest?.at ?? '');
      void queryClient.invalidateQueries({ queryKey: ['harness-auto-history'] });
      void queryClient.invalidateQueries({ queryKey: ['skill-versions'] });
    },
  });

  if (!visible || !newest) return null;

  return (
    <div
      data-testid="skill-evolved-chip"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/60 bg-card/60 px-2.5 py-1.5 text-2xs text-muted-foreground"
    >
      <Sparkles className="size-3 shrink-0 text-primary" aria-hidden />
      <span className="text-foreground">
        August updated <span className="font-medium">{newest.skill}</span> by itself
      </span>

      {newest.versionTs ? (
        <button
          type="button"
          data-testid="skill-evolved-undo"
          disabled={undo.isPending}
          onClick={() => undo.mutate()}
          className="rounded-md border border-border/60 px-1.5 py-0.5 text-2xs text-foreground transition hover:bg-accent disabled:opacity-50"
        >
          {undo.isPending ? 'Restoring…' : 'Undo'}
        </button>
      ) : (
        <span>it created the skill, so there is no earlier version to put back</span>
      )}

      {undo.isError && (
        <span data-testid="skill-evolved-undo-error" className="text-danger-fg">
          {String((undo.error as Error | null)?.message ?? 'the restore failed')}
        </span>
      )}

      <button
        type="button"
        data-testid="skill-evolved-expand"
        onClick={() => setOpen((cur) => !cur)}
        aria-expanded={open}
        className="underline decoration-dotted underline-offset-2 transition hover:text-foreground"
      >
        {open ? 'hide' : 'details'}
      </button>

      <button
        type="button"
        data-testid="skill-evolved-dismiss"
        aria-label="Dismiss this notice"
        onClick={() => hide(newest.at)}
        className="ml-auto rounded p-0.5 transition hover:text-foreground"
      >
        <X className="size-3" aria-hidden />
      </button>

      {open && (
        <ul
          data-testid="skill-evolved-details"
          className="basis-full space-y-0.5 pt-1"
        >
          {changes.slice(0, 5).map((c) => (
            <li key={c.proposalId} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-foreground">{c.skill}</span>
              <span>{formatTimeAgo(c.at)}</span>
              {c.reverted && <span>restored</span>}
              {!c.versionTs && !c.reverted && <span>created — no earlier version</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
