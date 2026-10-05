/* ── Skill version history ──────────────────────────────────────────── */
/* Wrappers for the version endpoints in app/routers/skills.py:
 *   GET  /api/skills/{name}/versions                → { versions: [{ts, …}] }
 *   GET  /api/skills/{name}/versions/{ts}/diff      → { diff }  (vs the LIVE file)
 *   POST /api/skills/{name}/versions/{ts}/restore   → write that version back
 *
 * The restore wrapper exists because the backend route does, and in that
 * order: a button that offered an undo with no single server-side path to
 * take would be the second write path this file used to refuse. Reads are not
 * the point any more — the write is why the reads are worth showing.
 *
 * The diff is ALWAYS against the current `SKILL.md`, never against the
 * next-newer snapshot — the question a reader has is "what did I lose when
 * this was replaced", and the live file is the only honest other end of it.
 * An EMPTY diff therefore means "this snapshot is what is live now", which is
 * how the UI answers the `sha` question without hashing anything client-side,
 * and how it knows when there is nothing to undo.
 */

import { api } from '../client';

export interface SkillVersionEntry {
  /** Bare unix-timestamp id the snapshot is stored under, and the id the diff
   *  endpoint takes. Digits only — never feed this to `new Date()` as a
   *  string; multiply by 1000 first. */
  ts: string;
  /** Who replaced it: `user` / `distiller` / `curator`. '' when unrecorded. */
  actor: string;
  /** Why the write happened. '' when the snapshot carries no reason. */
  rationale: string;
  /** SHA-256 of the snapshotted content. '' when the server could not compute
   *  one — an empty sha must never be read as "matches the live file". */
  sha: string;
}

export interface SkillVersionList {
  /** Newest first, as the server sorts them. */
  versions: SkillVersionEntry[];
}

export interface SkillVersionDiff {
  /** Unified diff of this version against the current SKILL.md. `''` means
   *  the snapshot is byte-identical to the file on disk right now. */
  diff: string;
}

/** `?workspace=` for a project-scoped skill; '' for the global scope. */
function scopeQuery(workspace?: string): string {
  return workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
}

export function listSkillVersions(
  name: string,
  workspace?: string,
): Promise<SkillVersionList> {
  return api.get<SkillVersionList>(
    `/api/skills/${encodeURIComponent(name)}/versions${scopeQuery(workspace)}`,
  );
}

export function getSkillVersionDiff(
  name: string,
  ts: string,
  workspace?: string,
): Promise<SkillVersionDiff> {
  // The same all-digits gate the server applies (`read_version`), applied
  // here because `ts` is a URL path segment: a value that is not a bare
  // unixts would traverse out of the versions directory if it ever reached
  // the filesystem. Refusing locally keeps a malformed row from becoming a
  // request at all, and turns a silent 404 into a named failure.
  if (!isVersionId(ts)) {
    return Promise.reject(new Error(`Refusing a non-numeric skill version id: ${ts}`));
  }
  return api.get<SkillVersionDiff>(
    `/api/skills/${encodeURIComponent(name)}/versions/${ts}/diff${scopeQuery(workspace)}`,
  );
}

export interface SkillVersionRestore {
  ok: boolean;
  name: string;
  /** The version id written back — echo of the request, not the server's guess. */
  restored: string;
  /** The parsed skill as the backend now reads it. */
  skill: Record<string, unknown>;
}

function isVersionId(ts: string): boolean {
  return /^\d+$/.test(ts);
}

/** Undo one skill change: write version `ts` back over the live SKILL.md.
 *
 * This is the ONLY client for that route, and `skill_service.restoreVersion`
 * is the ONLY server path from a version id to file content — the panel's
 * button and the probation auto-revert both come through it, so "undo" has one
 * meaning. The write snapshots what it replaces, so every restore is itself in
 * the history it extends. */
export function restoreSkillVersion(
  name: string,
  ts: string,
  workspace?: string,
): Promise<SkillVersionRestore> {
  if (!isVersionId(ts)) {
    return Promise.reject(new Error(`Refusing a non-numeric skill version id: ${ts}`));
  }
  return api.post<SkillVersionRestore>(
    `/api/skills/${encodeURIComponent(name)}/versions/${ts}/restore${scopeQuery(workspace)}`,
  );
}

/** One change August made to a skill by itself, as the rails record it. */
export interface AutoAppliedChange {
  at: string;
  proposalId: string;
  skill: string;
  /** The snapshot the apply took. '' when there was none — a created skill has
   *  no previous version, so its undo is the soft disable below. */
  versionTs: string;
  /** True when the machine CREATED the skill rather than editing one. Decides
   *  which undo the chip can honestly offer. */
  created: boolean;
  /** Probation already put this one back. */
  reverted: boolean;
}

export interface AutoApplyHistory {
  /** Which way the switch is set right now, because a list of auto-changes with
   *  no state beside it reads as "this is what happens" when it may be "what
   *  happened". */
  autonomy: boolean;
  changes: AutoAppliedChange[];
}

/** The record of what the rails applied — read by the settings history and by
 *  the chat chip, which is why it lives here and not in either caller. */
export function getAutoApplyHistory(limit = 20): Promise<AutoApplyHistory> {
  return api.get<AutoApplyHistory>(`/api/harness/proposals/auto-history?limit=${limit}`);
}

/** Probation's answer for an auto-CREATED skill: flip it off through the same
 *  `PATCH /api/skills/{name}` the Skills page toggle uses.
 *
 *  A create takes no snapshot, so there is no version to restore, and deleting
 *  the file would take the user's work with it. Disabling is the reversible
 *  half of the lifecycle that already exists — no new write path is invented
 *  here, only the existing one is named. */
export function disableSkill(name: string, workspace?: string): Promise<unknown> {
  return api.patch(`/api/skills/${encodeURIComponent(name)}`, {
    disabled: true,
    ...(workspace ? { workspace } : {}),
  });
}

/** Human label for a version id: the snapshot's own unixts, as a date.
 *  Returns the raw id when it is not a number the Date constructor can use,
 *  so a malformed row still names itself instead of rendering "Invalid Date". */
export function formatVersionStamp(ts: string): string {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return ts;
  return new Date(seconds * 1000).toLocaleString();
}

/* ── Per-skill measured effect ────────────────────────────────────────────
 * GET /api/brain/skills/suggestions aggregates the turn ledger: the
 * resolved rate on turns that carried a skill vs turns that did not. The
 * numbers have been computed server-side since migration 050 and were
 * rendered NOWHERE — this client is what finally surfaces them (2026-10-03).
 */
export interface SkillSuggestion {
  skill: string;
  turnsWith: number;
  okRateWith: number | null;
  turnsWithout: number;
  okRateWithout: number | null;
  /** okRateWith − okRateWithout, rounded; null when either side has no turns. */
  lift: number | null;
}

export interface SkillSuggestionsResponse {
  days: number;
  suggestions: SkillSuggestion[];
}

export function listSkillSuggestions(days = 30, limit = 50): Promise<SkillSuggestionsResponse> {
  return api.get<SkillSuggestionsResponse>(
    `/api/brain/skills/suggestions?days=${days}&limit=${limit}`,
  );
}
