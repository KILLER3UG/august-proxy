/* ── Harness API client ──────────────────────────────────────────────── */
/* Typed client for the /api/harness/* endpoints (per-turn execution       */
/* traces, drift, model profiles).                                         */

import { api } from './client';

export interface HarnessTrace {
  id: number;
  session_id: string;
  turn_seq: number;
  prompt_hash: string;
  prompt_preview: string;
  task_type: string;
  model: string;
  provider: string;
  /** Graded turn outcome: ok | refusal | thinking_only | tool_error |
   *  error | stalled | ... */
  outcome: string;
  rounds: number;
  tools_offered: number;
  tool_calls: string[] | null;
  self_heal_events:
    | {
        parse_failures?: number;
        refusals?: number;
        stall_nudges?: number;
        compacted_this_turn?: boolean;
      }
    | null;
  evidence_state: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  error: string;
  created_at?: string;
}

/** Per-turn execution traces for one session (newest first from the API). */
export async function listSessionTraces(
  sessionId: string,
  limit = 100,
): Promise<HarnessTrace[]> {
  const res = await api.get<{ traces: HarnessTrace[] }>(
    `/api/harness/traces?session_id=${encodeURIComponent(sessionId)}&limit=${limit}`,
  );
  return res.traces ?? [];
}
