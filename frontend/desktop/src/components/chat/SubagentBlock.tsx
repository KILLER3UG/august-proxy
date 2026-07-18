/**
 * SubagentBlock — thin compatibility wrapper around SubagentLaunchList.
 * Primary UX is the Cursor-style checklist + detail modal.
 */

import type { ReactElement } from 'react';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';
import { SubagentLaunchList } from '@/components/chat/SubagentLaunchList';
import type { SubagentPromptEntry } from '@/components/chat/subagent-tools';

export type { SubagentPromptEntry } from '@/components/chat/subagent-tools';
export { isSubagentToolName } from '@/components/chat/subagent-tools';

interface SubagentBlockProps {
  state: SubagentBlockState;
  subBlocks?: Map<string, SubagentBlockState>;
  subPrompts?: Map<string, SubagentPromptEntry>;
  modelLabel?: string;
}

/** Renders a single subagent as a one-row launch list (opens detail on click). */
export function SubagentBlock({
  state,
  subBlocks,
  subPrompts,
  modelLabel,
}: SubagentBlockProps): ReactElement {
  return (
    <SubagentLaunchList
      agents={[state]}
      subBlocks={subBlocks}
      subPrompts={subPrompts}
      modelLabel={modelLabel}
    />
  );
}
