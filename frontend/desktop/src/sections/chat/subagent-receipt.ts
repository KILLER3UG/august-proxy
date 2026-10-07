/* ── Subagent completion receipts ─────────────────────────────────────── */
/* The backend injects a subagent's result as a user message wrapped in a
 * `[SUBAGENT_COMPLETE taskId="…" agentId="…" status="…"] … [/SUBAGENT_COMPLETE]`
 * envelope (`spawn_subagents_tool.py:366`). That is addressed to the model.
 * Rendered verbatim it puts raw protocol text in the transcript AND styles a
 * machine receipt as a pending, warning-amber "Queued" item — so both surfaces
 * route through here instead. */

export interface SubagentReceipt {
  taskId: string;
  agentId: string;
  status: string;
  goal: string;
  /** The result body the model was handed, minus the goal line. */
  body: string;
}

const ENVELOPE =
  /^\s*\[SUBAGENT_COMPLETE\s+taskId="([^"]*)"\s+agentId="([^"]*)"\s+status="([^"]*)"\]\s*\n?([\s\S]*?)\n?\[\/SUBAGENT_COMPLETE\]\s*$/;
const ENVELOPE_OPEN =
  /^\s*\[SUBAGENT_COMPLETE\s+taskId="([^"]*)"\s+agentId="([^"]*)"\s+status="([^"]*)"\]\s*\n?([\s\S]*)$/;

/** Returns the parsed receipt, or null when the text is an ordinary message.
 *  The closing tag is optional because the queue truncates long payloads. */
export function parseSubagentReceipt(text: string | undefined | null): SubagentReceipt | null {
  if (!text) return null;
  const m = ENVELOPE.exec(text) ?? ENVELOPE_OPEN.exec(text);
  if (!m) return null;
  const raw = (m[4] || '').trim();
  const firstBreak = raw.indexOf('\n');
  const firstLine = firstBreak < 0 ? raw : raw.slice(0, firstBreak);
  const goalMatch = /^goal:\s*(.*)$/i.exec(firstLine);
  return {
    taskId: m[1],
    agentId: m[2],
    status: m[3],
    goal: goalMatch ? goalMatch[1].trim() : '',
    body: goalMatch && firstBreak >= 0 ? raw.slice(firstBreak + 1).trim() : goalMatch ? '' : raw,
  };
}

/** One quiet line: what finished, for whom, and how. */
export function describeSubagentReceipt(r: SubagentReceipt): string {
  const who = r.agentId && r.agentId !== 'general' ? ` “${r.agentId}”` : '';
  const status = r.status === 'completed' ? 'finished' : r.status || 'reported';
  return `Subagent${who} ${status}`;
}
