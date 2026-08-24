/* Harness agent_mode: chat | agent | code | orchestrator | benchmark (orthogonal to guard mode). */

export type HarnessAgentMode = 'chat' | 'agent' | 'code' | 'orchestrator' | 'benchmark';

export function normalizeHarnessMode(raw?: string | null): HarnessAgentMode {
  const m = (raw || 'agent').trim().toLowerCase();
  if (m === 'planner' || m === 'orchestrator') return 'orchestrator';
  if (m === 'chat' || m === 'code' || m === 'agent' || m === 'benchmark') return m;
  return 'agent';
}
