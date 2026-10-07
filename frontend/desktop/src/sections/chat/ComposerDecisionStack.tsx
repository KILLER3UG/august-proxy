/* One composer card for pending subagent proposals, and the notice that a
 * skill changed by itself. */

import { SubagentProposalBar } from './SubagentProposalBar';
import { SkillEvolvedChip } from './SkillEvolvedChip';

export function ComposerDecisionStack({
  sessionId,
}: {
  sessionId: string | null;
}) {
  return (
    <div className="mb-1 space-y-1 empty:mb-0" data-testid="composer-decision-stack">
      <SubagentProposalBar sessionId={sessionId} />
      {/* Above the thread, not in it: an auto-apply is not something the model
          said during this conversation, and the reviewer job can make one while
          no turn is running. */}
      <SkillEvolvedChip />
    </div>
  );
}
