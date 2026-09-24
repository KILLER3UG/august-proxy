/* ── approval-scope ────────────────────────────────────────────────────── */
/* Which approval scopes may be offered for a pending tool call, and how a  */
/* chosen scope maps onto the confirm-mutation payload.                      */
/*                                                                          */
/* The backend (app/services/workbench/grant_policy.py) stores three scopes: */
/* `once` covers this one call, `session` covers the conversation, `always`  */
/* is written to disk under the session's workspace path. There is no       */
/* separate `project` scope — `always` IS the durable project-scoped one,    */
/* and it is only ever as narrow as the grant key.                          */
/*                                                                          */
/* A grant key is a fingerprint of the exact command or path, so `always`    */
/* means "stop asking for exactly this". It is NOT offered when the key is   */
/* broad (`<tool>:*`), is a sandbox-escape fallback, or when the permission  */
/* axis classified the call as destructive or network — a durable grant for */
/* those would silently auto-run on every later turn in the project. The UI  */
/* hides the choice; the backend clamps it if a caller asks anyway.         */

export type GrantScope = 'once' | 'session' | 'always';

export type ApprovalChoice =
  | 'once'
  | 'session'
  | 'always'
  | 'deny'
  | 'instructions';

export type Decision = {
  reject: boolean;
  scope: GrantScope;
};

/** Categories whose approvals may not outlive the current chat. */
export const NON_DURABLE_CATEGORIES = ['destructive', 'network'] as const;

export type ApprovalSubject = {
  /** Backend-computed fingerprint of the exact approved call. */
  grantKey?: string | null;
  /** Permission-axis categories, e.g. ['destructive'] or ['network']. */
  categories?: readonly string[] | null;
};

/**
 * May a durable (on-disk, project-wide) grant be offered for this call?
 *
 * Fails closed: an unknown or missing grant key is not specific enough to be
 * made permanent, so the choice is withheld rather than guessed at.
 */
export function canGrantAlways(subject: ApprovalSubject | null | undefined): boolean {
  if (!subject) return false;
  const key = (subject.grantKey || '').trim();
  if (!key) return false;
  // `run_command:*` / `delete_file:*` — covers every future call to the tool.
  if (key.endsWith(':*')) return false;
  // Produced by the sandbox-escape fingerprint failure path; a transient
  // exception must not be able to mint permanent policy.
  if (key.includes(':sandbox:unsandboxed')) return false;
  const cats = (subject.categories || []).map((c) => String(c).toLowerCase());
  return !cats.some((c) => (NON_DURABLE_CATEGORIES as readonly string[]).includes(c));
}

/**
 * Choices to render, in order. Deny and instructions are always available;
 * `always` is appended only when the grant is safe to make permanent.
 */
export function approvalChoices(
  subject: ApprovalSubject | null | undefined,
): ApprovalChoice[] {
  const choices: ApprovalChoice[] = ['once', 'session'];
  if (canGrantAlways(subject)) choices.push('always');
  choices.push('deny', 'instructions');
  return choices;
}

/** Map a chosen scope onto the confirm-mutation request fields. */
export function scopeToDecision(scope: GrantScope): Decision {
  return { reject: false, scope };
}

/** Map a rendered choice onto the confirm-mutation request fields. */
export function choiceToDecision(choice: ApprovalChoice): Decision {
  if (choice === 'deny' || choice === 'instructions') {
    return { reject: true, scope: 'once' };
  }
  return scopeToDecision(choice);
}
