/* ── tool-progress ─ pure accumulator for `tool_progress` SSE events ─ */
/* Pairs with the backend's `safeEmitProgress` helper in workbench.js.    */
/*                                                                       */
/* For each tool call id, maintains an ordered list of `{ path, status } */
/* entries, where status is 'reading' (in-flight) or 'read' (done). The   */
/* reducer is a pure function so it can be unit-tested in isolation.        */
/*                                                                       */
/* Phases emitted by the backend:                                         */
/*   • 'reading' + paths:  mark these paths as in-flight (newest at the end) */
/*   • 'read'   + path:    mark this single path as done                    */
/*   • 'done':            remove the entry (tool finished, sub-list clears) */
/*   • 'error':           same as 'done'                                  */
/*   • 'running':         no-op (used for run_command, not read-related)  */

export type ProgressPhase = 'reading' | 'read' | 'running' | 'done' | 'error';

export type ProgressStatus = 'reading' | 'read';

export interface ProgressEntry {
  path: string;
  status: ProgressStatus;
}

export interface ToolProgressEvent {
  id: string;
  phase: ProgressPhase;
  paths?: string[];
  path?: string;
}

export type ToolProgressMap = Map<string, ReadonlyArray<ProgressEntry>>;

/**
 * Apply a single `tool_progress` event to the current accumulator and
 * return a new map. Pure: never mutates the input.
 */
export function applyToolProgress(
  prev: ToolProgressMap,
  event: ToolProgressEvent
): ToolProgressMap {
  if (!event || !event.id) return prev;

  // Terminal phases: drop the entry. The UI hides the sub-list once the
  // tool call is done or has errored.
  if (event.phase === 'done' || event.phase === 'error') {
    if (!prev.has(event.id)) return prev;
    const next = new Map(prev);
    next.delete(event.id);
    return next;
  }

  if (event.phase === 'running') {
    // No read-related state to update; keep any existing sub-list intact
    // (the running tool's own row already shows the spinner).
    return prev;
  }

  const existing = prev.get(event.id) || EMPTY_ENTRIES;

  if (event.phase === 'reading') {
    const incoming = Array.isArray(event.paths) ? event.paths.filter(Boolean) : [];
    if (incoming.length === 0) return prev;

    // Build a quick lookup of the existing status for each path so we
    // don't downgrade `read` back to `reading` if a duplicate event
    // arrives. (The backend shouldn't send duplicates, but be defensive.)
    const existingByPath = new Map<string, ProgressStatus>();
    for (const e of existing) existingByPath.set(e.path, e.status);

    const incomingSet = new Set(incoming);
    // Move-to-end dedup: drop existing entries that are in `incoming`,
    // then append `incoming` (with preserved read status). This keeps
    // the most recently read path at the bottom of the sub-list, which
    // matches the reference's "Reading X" → "Reading Y" visual flow.
    const next: ProgressEntry[] = [];
    for (const e of existing) {
      if (incomingSet.has(e.path)) continue;
      next.push(e);
    }
    for (const p of incoming) {
      const status = existingByPath.get(p) === 'read' ? 'read' : 'reading';
      next.push({ path: p, status });
    }
    return updateMap(prev, event.id, next);
  }

  if (event.phase === 'read') {
    if (!event.path) return prev;
    const next = markRead(existing, event.path);
    return next === existing ? prev : updateMap(prev, event.id, next);
  }

  return prev;
}

const EMPTY_ENTRIES: ReadonlyArray<ProgressEntry> = [];

function markRead(
  entries: ReadonlyArray<ProgressEntry>,
  path: string
): ReadonlyArray<ProgressEntry> {
  const idx = entries.findIndex(e => e.path === path);
  if (idx === -1) {
    // Defensive: a `read` event for a path we never saw `reading` for.
    // Still create the entry so the sub-list can reflect late-arriving
    // events (e.g. events out-of-order from a parallel tool call).
    return [...entries, { path, status: 'read' }];
  }
  if (entries[idx].status === 'read') return entries; // no change
  const next = entries.slice();
  next[idx] = { path, status: 'read' };
  return next;
}

function updateMap(
  prev: ToolProgressMap,
  id: string,
  entries: ReadonlyArray<ProgressEntry>
): ToolProgressMap {
  const next = new Map(prev);
  if (entries.length === 0) {
    next.delete(id);
  } else {
    next.set(id, entries);
  }
  return next;
}

/** Visible cap for the live sub-list (4 most recent). */
export const MAX_VISIBLE_PROGRESS = 4;

/** Helper: truncate a progress list to the last N entries for the UI. */
export function visibleProgress(
  entries: ReadonlyArray<ProgressEntry> | undefined
): ReadonlyArray<ProgressEntry> {
  if (!entries || entries.length === 0) return EMPTY_ENTRIES;
  if (entries.length <= MAX_VISIBLE_PROGRESS) return entries;
  return entries.slice(entries.length - MAX_VISIBLE_PROGRESS);
}
