/* Harness agent_mode: chat | agent | code | orchestrator | benchmark (orthogonal to guard mode). */

export type HarnessAgentMode = 'chat' | 'agent' | 'code' | 'orchestrator' | 'benchmark';

export function normalizeHarnessMode(raw?: string | null): HarnessAgentMode {
  const m = (raw || 'agent').trim().toLowerCase();
  if (m === 'planner' || m === 'orchestrator') return 'orchestrator';
  if (m === 'chat' || m === 'code' || m === 'agent' || m === 'benchmark') return m;
  return 'agent';
}

// Tooltip helper for verifier gate: shows expected verification_command + exit code context
export function verifierTooltip(ev: { verificationCommand?: string; detail?: string } | null | undefined): string {
  if (!ev) return "Verification gate: run the test/lint/build command, then update_state(phase='complete')";
  const cmd = ev.verificationCommand?.trim();
  const det = ev.detail?.trim();
  if (cmd && det) return `Expected: ${cmd} — ${det}`;
  if (cmd) return `Expected: ${cmd}`;
  if (det) return det;
  return "Verification gate blocked — run verification then retry";
}
