/* One composer card for decisions + always-include, instead of stacked bars. */

import { BrainReviewBar } from './BrainReviewBar';
import { CuratorSuggestionBar } from './CuratorSuggestionBar';
import { DistillPendingBar } from './DistillPendingBar';
import { MemorySuggestionBar } from './MemorySuggestionBar';
import { PinnedMemoryBar } from './PinnedMemoryBar';
import { SubagentProposalBar } from './SubagentProposalBar';
import { ModelProfileSuggestionBar } from './ModelProfileSuggestionBar';

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
    <div className="mb-1 space-y-1 empty:mb-0" data-testid="composer-decision-stack">
      <BrainReviewBar modelId={modelId} turnCount={turnCount} />
      <CuratorSuggestionBar />
      <PinnedMemoryBar />
      <DistillPendingBar />
      <MemorySuggestionBar sessionId={sessionId} />
      <SubagentProposalBar sessionId={sessionId} />
      <ModelProfileSuggestionBar sessionId={sessionId} />
    </div>
  );
}
