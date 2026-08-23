/* One composer card for decisions + always-include, instead of stacked bars.
 * 0.16.6: the memory-review and skill-curation pills were REMOVED — both are
 * automatic now (backend auto-review loop + hourly curator). A quiet
 * SelfMaintenanceLine shows the last run instead; removals still reach the
 * user, but as proposals in this stack / Insights, never as click-me chips. */

import { SelfMaintenanceLine } from './SelfMaintenanceLine';
import { DistillPendingBar } from './DistillPendingBar';
import { MemorySuggestionBar } from './MemorySuggestionBar';
import { PinnedMemoryBar } from './PinnedMemoryBar';
import { SubagentProposalBar } from './SubagentProposalBar';
import { ModelProfileSuggestionBar } from './ModelProfileSuggestionBar';

export function ComposerDecisionStack({
  sessionId,
}: {
  sessionId: string | null;
}) {
  return (
    <div className="mb-1 space-y-1 empty:mb-0" data-testid="composer-decision-stack">
      <SelfMaintenanceLine />
      <PinnedMemoryBar />
      <DistillPendingBar />
      <MemorySuggestionBar sessionId={sessionId} />
      <SubagentProposalBar sessionId={sessionId} />
      <ModelProfileSuggestionBar sessionId={sessionId} />
    </div>
  );
}
