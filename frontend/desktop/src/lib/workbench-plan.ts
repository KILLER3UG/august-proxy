/* Pending-plan helpers — keep banner / drawer gates consistent. */

import type { WorkbenchPlan, WorkbenchSession } from '@/types/workbench';

/** Real plan payload (object with at least one key). Rejects null, {}, booleans. */
export function isNonEmptyPlan(plan: unknown): plan is WorkbenchPlan {
  return (
    !!plan &&
    typeof plan === 'object' &&
    !Array.isArray(plan) &&
    Object.keys(plan).length > 0
  );
}

type PlanGateSession = Pick<WorkbenchSession, 'plan' | 'approved' | 'approvedAt'> & {
  planApproved?: boolean;
};

/** True when the UI should show the plan proposal banner. */
export function hasPendingWorkbenchPlan(
  session: PlanGateSession | null | undefined,
): boolean {
  if (!session) return false;
  if (session.approved || !!session.approvedAt || session.planApproved) return false;
  return isNonEmptyPlan(session.plan);
}

/**
 * Map a backend session payload onto the frontend shape.
 * Backend uses `planApproved`; UI historically checked `approved` / `approvedAt`.
 * Also collapses empty `{}` plans (legacy hydration) to null.
 */
export function normalizeWorkbenchSession(
  raw: WorkbenchSession | Record<string, unknown> | null | undefined,
): WorkbenchSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id) return null;
  const planApproved = Boolean(s.planApproved ?? s.approved);
  const plan = isNonEmptyPlan(s.plan) ? (s.plan) : null;
  return {
    ...(s as unknown as WorkbenchSession),
    plan,
    approved: planApproved,
    approvedAt: (typeof s.approvedAt === 'string' ? s.approvedAt : null) ?? null,
    planApproved,
  };
}
