import { ToolStepRow } from '@/components/chat/ToolStepRow';
import { ToolCallItemBody } from '@/components/chat/tool/ToolCallItemBody';
import { getToolLabel } from '@/lib/tool-labels';
import type { ToolEntry } from '@/components/chat/tool/types';
import type { ChatMessage } from '@/types/chat';

/**
 * Legacy `role:'tool'` message card — thin adapter over the canonical
 * transcript row.
 *
 * Only pre-migration sessions (restored through
 * `stream/session-history.ts` — live SSE never emits role:'tool') reach
 * here. The card used to own its own chrome (a non-expandable
 * DisclosureRow), its own running-state animation, and a THIRD copy of
 * the per-file progress list; legacy rows were therefore the only rows
 * a user could not open. It now maps the stored shape onto a ToolEntry
 * and renders ToolStepRow + ToolCallItemBody like every live row.
 */
export function ToolCallCard({
  tool,
  progress,
  verbose = false,
}: {
  tool: NonNullable<ChatMessage['tool']>;
  timestamp: string;
  progress?: ReadonlyArray<{ path: string; status: 'reading' | 'read' }>;
  verbose?: boolean;
}) {
  const name = tool.name.replace(/^@/, '');
  const isCommand = name === 'run_command' || tool.name.startsWith('@run_command');
  const entry: ToolEntry = {
    id: `legacy-${tool.name}-${tool.duration ?? 0}`,
    name: tool.name,
    context: tool.args || undefined,
    summary: typeof tool.result === 'string' && tool.result.trim() ? tool.result : undefined,
    status: tool.status === 'running' ? 'running' : tool.status === 'error' ? 'error' : 'done',
  };

  return (
    <div data-slot="tool-block">
      <ToolStepRow
        tool={entry}
        label={getToolLabel(tool.name)}
        isCommand={isCommand}
        expanded={false}
        verbose={verbose}
        onToggle={() => {}}
        progress={progress}
      >
        <ToolCallItemBody tool={entry} progress={progress} verbose={verbose} />
      </ToolStepRow>
    </div>
  );
}