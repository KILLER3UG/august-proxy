/* ── ToolSummary — the phrase for a run of tool calls, rendered ───────── */
/* The component half of the activity header. The wording itself lives in
 * `lib/tool-summary.ts`, so the phrase can be read without rendering it and
 * a module that exports a component and a plain function stays out of
 * React Fast Refresh's way. */

import type { ToolEntry } from '@/components/chat/tool/types';
import { summarizeToolRun } from '@/lib/tool-summary';

export function ToolSummary({
  tools,
  className,
}: {
  tools: readonly ToolEntry[];
  className?: string;
}) {
  return <span className={className}>{summarizeToolRun(tools)}</span>;
}
