/* One composer card for pending subagent proposals. */

import { SubagentProposalBar } from './SubagentProposalBar';

export function ComposerDecisionStack({
  sessionId,
}: {
  sessionId: string | null;
}) {
  return (
    <div className="mb-1 space-y-1 empty:mb-0" data-testid="composer-decision-stack">
      <SubagentProposalBar sessionId={sessionId} />
    </div>
  );
}
