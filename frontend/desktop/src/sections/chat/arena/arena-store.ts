/**
 * Arena run state — the active split-pane comparison ("ask in parallel").
 *
 * A run launches N forked sessions (lanes), each streaming the same prompt
 * with a per-turn model override. The ArenaView overlay renders the lanes
 * side by side; picking a winner navigates to that lane's session (it holds
 * the full conversation + the winning answer, so the chat continues there).
 */
import { create } from 'zustand';

export interface ArenaRunLane {
  uiSessionId: string;
  modelId: string;
  modelName: string;
  provider: string;
}

export interface ArenaRun {
  runId: string;
  /** The chat session the arena was launched from. */
  sourceSessionId: string;
  prompt: string;
  lanes: ArenaRunLane[];
  startedAt: number;
  /** Original composer settings — reused for lane re-asks (A2). */
  workbenchMode?: string;
  effort?: string;
  thinkingEnabled?: boolean;
}

interface ArenaState {
  run: ArenaRun | null;
}

export const useArenaStore = create<ArenaState>(() => ({
  run: null,
}));

export function setArenaRun(run: ArenaRun | null): void {
  useArenaStore.setState({ run });
}

export function clearArenaRun(): void {
  useArenaStore.setState({ run: null });
}
