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

/**
 * Best-effort body text for a plan. The backend stores whatever the model
 * submitted via `submit_plan` — commonly `{ plan: "..." }` — while older UI
 * shapes used `markdown` / `summary`. Return the richest non-empty field so the
 * drawer/panel never paint a blank card for a validly-submitted plan.
 */
export function planBodyText(plan: WorkbenchPlan | null | undefined): string | null {
  if (!plan) return null;
  for (const text of [plan.markdown, plan.summary, plan.plan]) {
    if (typeof text === 'string' && text.trim()) return text;
  }
  return null;
}

type PlanGateSession = Pick<WorkbenchSession, 'plan' | 'approved' | 'approvedAt'> & {
  planApproved?: boolean;
  /** True only when `submit_plan` ran this session (set by the `planProposed`
   *  SSE event). Used to gate the proposal BANNER (so a plan restored from
   *  hydration doesn't re-raise it), while the plan drawer/panel still show
   *  any real pending plan regardless of this flag. */
  planSubmittedLive?: boolean;
};

/**
 * True when there is a real, un-approved plan on the session. This is the
 * general pending-plan signal used by both the plan panel (approved state)
 * and the proposal banner gate.
 *
 * NOTE: do NOT require `planSubmittedLive` here — WorkbenchPlanPanel derives
 * its "approved" badge from this, and gating on the live flag would wrongly
 * mark a restored pending plan as approved. Gate the *banner* on the live
 * flag at the call site instead.
 */
export function hasPendingWorkbenchPlan(
  session: PlanGateSession | null | undefined,
): boolean {
  if (!session) return false;
  if (session.approved || !!session.approvedAt || session.planApproved) return false;
  return isNonEmptyPlan(session.plan);
}

/**
 * Banner-specific gate: only raise the proposal banner when a plan was
 * actually submitted THIS session (onPlanProposed → planSubmittedLive). A
 * pending plan recovered from hydration/session-restore must not re-raise it.
 */
export function shouldShowPlanBanner(
  session: PlanGateSession | null | undefined,
): boolean {
  if (!session) return false;
  if (!session.planSubmittedLive) return false;
  return hasPendingWorkbenchPlan(session);
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
