/* ── ReviewFindingsPanel — advisory code-review findings (Part 10 R-A) ──
 * Renders severity counts + grounded findings anchored to file:line.
 * Advisory only, never a gate: a skipped review shows its loud notice and
 * dropped (ungrounded) findings are reported as a count, never hidden. */

import { X, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CodeReviewResult, ReviewFinding } from '@/api/codeReview';

const TAG_STYLES: Record<string, string> = {
  P0: 'bg-destructive/20 text-destructive border-destructive/40',
  P1: 'bg-orange-500/15 text-orange-400 border-orange-500/40',
  P2: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/40',
  P3: 'bg-white/[0.06] text-muted-foreground border-white/10',
};

function TagBadge({ tag }: { tag: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded border px-1 font-mono text-[10px] font-semibold',
        TAG_STYLES[tag] || TAG_STYLES.P3,
      )}
    >
      {tag}
    </span>
  );
}

function FindingRow({
  finding,
  onSelectFile,
}: {
  finding: ReviewFinding;
  onSelectFile?: (path: string) => void;
}) {
  return (
    <div
      data-testid="review-finding-row"
      className="space-y-1 rounded-md border border-white/[0.06] bg-black/20 p-2"
    >
      <div className="flex items-start gap-1.5">
        <TagBadge tag={finding.tag} />
        <span className="min-w-0 text-xs font-medium text-foreground/90">
          {finding.title}
        </span>
        {finding.failSafe && (
          <span
            className="shrink-0 rounded bg-white/[0.06] px-1 text-[9px] text-muted-foreground"
            title="Finding had no leading severity tag — escalated to P1 fail-safe"
          >
            untagged → P1
          </span>
        )}
      </div>
      {finding.file && (
        <button
          type="button"
          data-testid="review-finding-anchor"
          onClick={() => onSelectFile?.(finding.file)}
          className="block max-w-full truncate font-mono text-[10px] text-primary/80 hover:text-primary hover:underline"
          title={`Jump to ${finding.file}${finding.line ? `:${finding.line}` : ''}`}
        >
          {finding.file}
          {finding.line > 0 ? `:${finding.line}` : ''}
          {finding.status === 'rehomed' && (
            <span className="ml-1 text-muted-foreground">(rehomed by grounding)</span>
          )}
        </button>
      )}
      {finding.body && (
        <p className="line-clamp-4 whitespace-pre-wrap text-[11px] leading-snug text-muted-foreground">
          {finding.body}
        </p>
      )}
    </div>
  );
}

export function ReviewFindingsPanel({
  result,
  onSelectFile,
  onDismiss,
}: {
  result: CodeReviewResult;
  onSelectFile?: (path: string) => void;
  onDismiss?: () => void;
}) {
  const { counts, findings } = result;
  const total = counts.p0 + counts.p1 + counts.p2 + counts.p3;

  return (
    <div
      data-testid="review-findings-panel"
      className="space-y-2 rounded-lg border border-border/60 bg-card/60 p-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5" data-testid="review-counts">
          <span className="text-xs font-medium text-foreground/85">Review</span>
          {counts.p0 > 0 && <TagBadge tag="P0" />}
          {counts.p0 > 0 && <span className="text-[10px] tabular-nums text-destructive">{counts.p0}</span>}
          {counts.p1 > 0 && <TagBadge tag="P1" />}
          {counts.p1 > 0 && <span className="text-[10px] tabular-nums text-orange-400">{counts.p1}</span>}
          {counts.p2 > 0 && <TagBadge tag="P2" />}
          {counts.p2 > 0 && <span className="text-[10px] tabular-nums text-yellow-300">{counts.p2}</span>}
          {counts.p3 > 0 && <TagBadge tag="P3" />}
          {counts.p3 > 0 && <span className="text-[10px] tabular-nums text-muted-foreground">{counts.p3}</span>}
          {total === 0 && !result.skipped && (
            <span className="text-[10px] text-muted-foreground">no findings</span>
          )}
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            data-testid="review-dismiss"
            className="rounded p-0.5 text-muted-foreground/60 hover:text-foreground"
            title="Dismiss review results"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {result.skipped && (
        <div
          data-testid="review-notice"
          className="flex items-start gap-1.5 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2 text-[11px] text-yellow-200"
        >
          <Info className="mt-0.5 size-3 shrink-0" />
          <span>{result.notice || 'Review skipped.'}</span>
        </div>
      )}

      {findings.map((finding, i) => (
        <FindingRow key={`${finding.file}:${finding.line}:${i}`} finding={finding} onSelectFile={onSelectFile} />
      ))}

      {!!result.droppedUngrounded && result.droppedUngrounded > 0 && (
        <div className="text-[10px] text-muted-foreground/70">
          {result.droppedUngrounded} finding{result.droppedUngrounded === 1 ? '' : 's'} dropped —
          quoted code matched no file (Layer-1 grounding).
        </div>
      )}

      {result.judge?.ran && (
        <div className="text-[10px] text-muted-foreground/70" data-testid="review-judge-line">
          Independent judge{result.judge.judgeModel ? ` (${result.judge.judgeModel})` : ''}:
          {' '}dropped {result.judge.discarded ?? 0}, clustered {result.judge.clusteredDuplicates ?? 0}.
        </div>
      )}

      <div className="text-[9px] text-muted-foreground/50">
        Advisory only — review never blocks or withholds.
      </div>
    </div>
  );
}
