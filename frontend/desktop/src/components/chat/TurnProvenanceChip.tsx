/* ── TurnProvenanceChip — what the shell injected for this answer ────── */
/* Audit A6 / #15. A turn's `turnTelemetry` frame names the skills and facts
 * that went into its prompt and the failure families it hit. Without that on
 * screen, a surprising answer has no visible cause: the user sees the model
 * "know" something and can only guess whether it recalled it, was handed a
 * skill, or simply made it up.
 *
 * Shape: ONE chip group, because the three lists are one fact ("what this
 * turn was given") split three ways. The label is deliberately terse and the
 * detail lives in the tooltip — a transcript that has to be read should not
 * have to be scrolled to find out why an answer came out the way it did.
 *
 * Silence is the default state. A turn that injected nothing and hit nothing
 * renders NOTHING: the backend omits those keys entirely when the lists are
 * empty, so a "0 skills · 0 facts" chip would be a claim the shell never
 * made, on every single turn.                                                          */

import { AlertTriangle, BookOpen, Brain } from 'lucide-react';
import type { WorkbenchTurnProvenance } from '@/types/workbench';
import { SettingsTooltip } from '@/components/settings/SettingsTooltip';
import { cn } from '@/lib/utils';

/** One chip's own label + count. `text` already carries the plural, so the
 *  tooltip and the chip can never disagree about "1 skill" vs "1 skills". */
function countLabel(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function TurnProvenanceChip({ provenance }: { provenance?: WorkbenchTurnProvenance }) {
  const skills = provenance?.skillsInjected ?? [];
  const facts = provenance?.factsInjected ?? [];
  const families = provenance?.errorFamilies ?? [];

  if (skills.length === 0 && facts.length === 0 && families.length === 0) return null;

  const skillsText = countLabel(skills.length, 'skill', 'skills');
  const factsText = countLabel(facts.length, 'fact', 'facts');
  const familiesText = countLabel(families.length, 'failure', 'failures');

  return (
    <SettingsTooltip
      side="top"
      className="max-w-full"
      content={
        <div className="space-y-1.5" data-testid="turn-provenance-detail">
          {skills.length > 0 && (
            <div>
              <p className="mb-0.5 font-semibold uppercase tracking-wider text-muted-foreground/70">
                {skillsText} injected
              </p>
              <ul className="space-y-0.5">
                {skills.map((s) => (
                  <li key={s} className="font-mono break-all">{s}</li>
                ))}
              </ul>
            </div>
          )}
          {facts.length > 0 && (
            <p>
              <span className="font-semibold">{factsText}</span> recalled from memory
              {facts.length <= 3 ? `: ${facts.join(', ')}` : ''}
            </p>
          )}
          {families.length > 0 && (
            <p>
              <span className="font-semibold">{familiesText}</span> hit this turn:{' '}
              <span className="font-mono">{families.join(', ')}</span>
            </p>
          )}
          <p className="text-muted-foreground/70">
            The shell&apos;s own accounting for this turn — the same lists the
            turn ledger records.
          </p>
        </div>
      }
      trigger={(t) => (
        <span
          tabIndex={0}
          data-testid="turn-provenance-chip"
          className={cn(
            'inline-flex max-w-full cursor-help flex-wrap items-center gap-1.5 rounded-md',
            'border border-border/50 bg-muted/30 px-1.5 py-0.5 text-3xs font-medium',
            'uppercase tracking-wide text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
          {...t}
        >
          {skills.length > 0 && (
            <span className="inline-flex items-center gap-1" data-testid="provenance-skills">
              <BookOpen className="size-3" aria-hidden />
              {skillsText}
            </span>
          )}
          {facts.length > 0 && (
            <span className="inline-flex items-center gap-1" data-testid="provenance-facts">
              <Brain className="size-3" aria-hidden />
              {factsText}
            </span>
          )}
          {families.length > 0 && (
            <span
              className="inline-flex items-center gap-1 text-warning/90"
              data-testid="provenance-errors"
            >
              <AlertTriangle className="size-3" aria-hidden />
              {familiesText}
            </span>
          )}
        </span>
      )}
    />
  );
}
