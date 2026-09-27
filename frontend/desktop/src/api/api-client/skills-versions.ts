/* ── Skill version history (read-only) ──────────────────────────────── */
/* Wrappers for the two version endpoints in app/routers/skills.py:
 *   GET /api/skills/{name}/versions           → { versions: [{ts, …}] }
 *   GET /api/skills/{name}/versions/{ts}/diff → { diff }  (vs the LIVE file)
 *
 * There is deliberately NO revert/restore wrapper. The backend has no such
 * endpoint, so a button that offered one would either be a lie or a second
 * write path invented in the UI. This is a reading surface: what a skill used
 * to say, and how it differs from what it says now.
 *
 * The diff is ALWAYS against the current `SKILL.md`, never against the
 * next-newer snapshot — the question a reader has is "what did I lose when
 * this was replaced", and the live file is the only honest other end of it.
 * An EMPTY diff therefore means "this snapshot is what is live now", which is
 * how the UI answers the `sha` question without hashing anything client-side.
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
  if (!/^\d+$/.test(ts)) {
    return Promise.reject(new Error(`Refusing a non-numeric skill version id: ${ts}`));
  }
  return api.get<SkillVersionDiff>(
    `/api/skills/${encodeURIComponent(name)}/versions/${ts}/diff${scopeQuery(workspace)}`,
  );
}

/** Human label for a version id: the snapshot's own unixts, as a date.
 *  Returns the raw id when it is not a number the Date constructor can use,
 *  so a malformed row still names itself instead of rendering "Invalid Date". */
export function formatVersionStamp(ts: string): string {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return ts;
  return new Date(seconds * 1000).toLocaleString();
}
