/* Harness agent_mode: chat | agent | code | orchestrator (orthogonal to guard mode). */

export type HarnessAgentMode = 'chat' | 'agent' | 'code' | 'orchestrator';

export function normalizeHarnessMode(raw?: string | null): HarnessAgentMode {
  const m = (raw || 'agent').trim().toLowerCase();
  if (m === 'planner' || m === 'orchestrator') return 'orchestrator';
  if (m === 'chat' || m === 'code' || m === 'agent') return m;
  return 'agent';
}
