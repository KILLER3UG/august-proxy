/* ── session-read-state — when you last opened each chat ───────────────
 *
 * The reference sidebar groups chats "Pinned" and "Read", and "Read" only
 * means anything because the app also knows which chats you have NOT read.
 * August tracked neither: there was no `lastViewed`, `seenAt` or `unreadCount`
 * anywhere in the client, so the second group would have been a label over the
 * same list the first one already named.
 *
 * This is that missing state, and it is deliberately per-install rather than a
 * backend column. Pinning — the same category of "how this person arranges
 * their own sidebar" — already lives in `localStorage` under
 * `august-pinned-sessions`, written at its two mutation sites. A server column
 * would add a migration and a write on every navigation to remember something
 * that only ever affects this window's ordering, and a second chat you don't
 * use on another machine has no claim on it.
 *
 * The one thing this must not do is announce every chat as unread the first
 * time the feature ships. `backfill` stamps each session with the activity time
 * it already had, so nothing is unread until something NEW happens after this
 * build is installed. */

import { useCallback, useEffect, useState } from 'react';

const READ_KEY = 'august-session-read';

type ReadMap = Record<string, number>;

function load(): ReadMap {
  try {
    const raw = localStorage.getItem(READ_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    // A corrupt or foreign blob must not throw inside the sidebar's first
    // render, and a non-object would poison every later lookup.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ReadMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

let stamps: ReadMap = typeof window === 'undefined' ? {} : load();

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function persist(): void {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(stamps));
  } catch {
    /* storage unavailable — the grouping still works for this session */
  }
}

/** Record "I have seen this chat as of now". */
export function markSessionRead(sessionId: string): void {
  if (!sessionId) return;
  if (stamps[sessionId] === Date.now()) return;
  stamps = { ...stamps, [sessionId]: Date.now() };
  persist();
  emit();
}

/** Stamp sessions that have never been seen with the activity they ALREADY
 *  have, so installing this feature cannot retroactively mark months of chats
 *  as unread. Idempotent: only ids with no entry are touched.
 *
 *  `activityMs` is the chat's last-activity time, so a chat that moves after
 *  this point still becomes unread — the backfill freezes the starting line, it
 *  does not silence the signal. */
export function backfillReadState(entries: ReadonlyArray<[string, number]>): void {
  let changed = false;
  const next = { ...stamps };
  for (const [id, activityMs] of entries) {
    if (next[id] !== undefined) continue;
    next[id] = activityMs;
    changed = true;
  }
  if (!changed) return;
  stamps = next;
  persist();
  emit();
}

/** React view over the map. Subscription-based rather than a snapshot read, so
 *  opening a chat moves its row out of "New" without a poll. */
export function useSessionReadState(): {
  readMap: ReadMap;
  markRead: (sessionId: string) => void;
  backfill: (entries: ReadonlyArray<[string, number]>) => void;
} {
  const [readMap, setReadMap] = useState<ReadMap>(stamps);
  useEffect(() => {
    const listener = () => setReadMap(stamps);
    listeners.add(listener);
    // The module map can move between the render that registered us and the
    // registration itself; re-sync so a stamp written in that window is not
    // missed for the life of this mount.
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const markRead = useCallback((sessionId: string) => markSessionRead(sessionId), []);
  const backfill = useCallback(
    (entries: ReadonlyArray<[string, number]>) => backfillReadState(entries),
    [],
  );
  return { readMap, markRead, backfill };
}
