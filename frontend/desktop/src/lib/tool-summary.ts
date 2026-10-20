/* ── tool-summary — one phrase for a run of tool calls ────────────────── */
/* The collapsed activity line has to say what happened, in words a person
 * reads at a glance: "Ran 4 commands", "Read a file", "Ran 4 commands, read
 * a file". This is the ONLY place that phrasing lives, so the activity
 * header and anything else that needs it read the same words.
 *
 * It lives here rather than beside the component because a module that
 * exports both a component and a plain function breaks React Fast Refresh
 * (the `react-refresh/only-export-components` rule), and the phrase is worth
 * more outside the component than the component is worth a second file for.
 *
 * There was a `components/chat/ToolSummary.tsx` that exported a component
 * wrapping this function, and nothing imported it — the activity header
 * calls `summarizeToolRun` directly. It is gone, because a component nobody
 * renders is a component that rots silently: nothing type-checks its props,
 * nothing exercises it, and the next reader cannot tell whether it is live.
 * The phrasing lives here; the header lives in
 * `components/chat/ActivityGroup.tsx`. */

import type { ToolEntry } from '@/components/chat/tool/types';
import { classifyTool, type ToolBucket } from '@/lib/tool-classify';

/** Per-bucket phrasing. Lower case, so a joined phrase reads as one clause
 *  ("ran 4 commands, read a file"); the whole phrase is capitalised once at
 *  the end. */
const PHRASES: Record<ToolBucket, { one: string; many: string }> = {
  run: { one: 'ran a command', many: 'ran {n} commands' },
  view: { one: 'read a file', many: 'read {n} files' },
  edit: { one: 'edited a file', many: 'edited {n} files' },
  memoryWrite: { one: 'saved a memory', many: 'saved {n} memories' },
  tool: { one: 'ran a tool', many: 'ran {n} tools' },
};

/** The order buckets appear in a joined phrase. The work that happened
 *  first reads first, and a run reads before it is described in detail. */
const BUCKET_ORDER: ToolBucket[] = ['run', 'view', 'edit', 'memoryWrite', 'tool'];

function phrase(bucket: ToolBucket, n: number): string {
  const p = PHRASES[bucket];
  return n === 1 ? p.one : p.many.replace('{n}', String(n));
}

/**
 * One phrase for a run of tool calls.
 *
 * Counts by bucket rather than by tool name, so "4 commands" stays "4
 * commands" whether they were `bash`, `run_command` or `powershell`, and a
 * mixed run reads as a list of what it did rather than as a count of
 * unrelated names.
 */
export function summarizeToolRun(tools: readonly ToolEntry[]): string {
  const counts = new Map<ToolBucket, number>();
  for (const t of tools) {
    const bucket = classifyTool(t.name);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const bucket of BUCKET_ORDER) {
    const n = counts.get(bucket);
    if (n) parts.push(phrase(bucket, n));
  }
  if (parts.length === 0) return 'Ran a tool';
  const joined = parts.join(', ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}
