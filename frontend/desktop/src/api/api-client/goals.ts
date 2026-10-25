/* ── Goal environments ───────────────────────────────────────────────── */
/* The API behind Settings → Goals: what the agent is working toward, the runs that carry
 * it, the outputs it filed (with their movement ledger) and the claims it has not proved.
 *
 * Reads are taken from the server on every mount rather than cached here: a goal is edited
 * by the agent MID-TURN, so anything this module remembered would be the wrong answer within
 * one reply. The two writes are the user's alone — stop a goal, close a run. */

import { api } from '../client';

export interface GoalBound {
  allow: string[];
  deny: string[];
  maxRounds: number;
  contextChars: number;
}

export interface GoalEnv {
  id: string;
  parentId: string | null;
  title: string;
  goal: string;
  inputs: string[];
  outputs: string[];
  bound: GoalBound;
  status: 'active' | 'done' | 'abandoned';
  owner: 'agent' | 'system';
  version: number;
  depth: number;
  /** The app's own environment: its bound is the ceiling every goal narrows from. */
  readOnly: boolean;
}

export interface GoalRun {
  id: string;
  envId: string;
  sessionId: string;
  status: 'running' | 'parked' | 'woken' | 'done' | 'failed';
  round: number;
  model: string;
  reason: string;
  startedAt: number;
}

export interface GoalMovement {
  artifact_id: string;
  at: number;
  actor: string;
  from_env: string;
  to_env: string;
  /** 0/1 from SQLite — a refusal is kept beside the successes on purpose. */
  ok: number;
  reason: string;
}

export interface GoalArtifactRow {
  id: string;
  env_id: string;
  kind: string;
  ref: string;
  summary: string;
  produced_by: string;
  movements: GoalMovement[];
}

export interface GoalClaimRow {
  id: string;
  env_id: string;
  text: string;
  made_by: string;
  made_at: number;
  marked?: boolean;
}

export interface GoalMarkRow {
  id: string;
  env_id: string;
  claim_id: string;
  text: string;
  verdict: 'confirmed' | 'refuted' | 'partial';
  evidence: string;
  by: string;
  at: number;
}

export interface GoalsSnapshot {
  envs: GoalEnv[];
  runs: GoalRun[];
  artifacts: GoalArtifactRow[];
  claims: GoalClaimRow[];
  marks: GoalMarkRow[];
}

export const listGoals = (): Promise<GoalsSnapshot> => api.get<GoalsSnapshot>('/api/goals');

export const abandonGoal = (envId: string): Promise<{ id: string; status: string }> =>
  api.post<{ id: string; status: string }>(`/api/goals/${encodeURIComponent(envId)}/abandon`, {});

export const closeRun = (runId: string): Promise<{ id: string; status: string; round: number }> =>
  api.post<{ id: string; status: string; round: number }>(`/api/goals/runs/${encodeURIComponent(runId)}/close`, {});
