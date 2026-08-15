/* One composer card for decisions + always-include, instead of stacked bars. */

import { BrainReviewBar } from './BrainReviewBar';
import { CuratorSuggestionBar } from './CuratorSuggestionBar';
import { DistillPendingBar } from './DistillPendingBar';
import { MemorySuggestionBar } from './MemorySuggestionBar';
import { PinnedMemoryBar } from './PinnedMemoryBar';
import { SubagentProposalBar } from './SubagentProposalBar';

export function ComposerDecisionStack({
  sessionId,
  modelId,
  turnCount,
}: {
  sessionId: string | null;
  modelId?: string | null;
  turnCount?: number;
}) {
  return (
    <div
      className="mb-2 space-y-1.5 rounded-xl border border-border/40 bg-muted/10 px-2.5 py-2"
      data-testid="composer-decision-stack"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          August
        </span>
        <BrainReviewBar modelId={modelId} turnCount={turnCount} />
        <CuratorSuggestionBar />
      </div>
      <PinnedMemoryBar />
      <DistillPendingBar />
      <MemorySuggestionBar sessionId={sessionId} />
      <SubagentProposalBar sessionId={sessionId} />
    </div>
  );
}
