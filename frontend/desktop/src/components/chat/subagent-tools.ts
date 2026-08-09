/** Shared subagent chat types + re-exports for spawn detection. */

export { isSubagentToolName } from '@/lib/tool-classify';

/** Sub-agent prompt payload stored on ChatThread's `subagentPrompts` map. */
export interface SubagentPromptEntry {
  content: string;
  systemPrompt: string;
  userMessage: string;
  tokens: number;
  subagentId?: string;
  jobId?: string;
}

export const SUBAGENT_STATUS_LABEL = {
  running: 'Running',
  pending: 'Pending',
  completed: 'Completed',
  recovered: 'Recovered',
  partial: 'Partial',
  failed: 'Failed',
  error: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
} as const;
