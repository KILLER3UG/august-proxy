/* localStorage load/save for the chat session list and sidebar folders. */

import type { Folder, Session } from './types';

export const LOCAL_SESSIONS_KEY = 'august-sessions-list-v1';
export const LOCAL_FOLDERS_KEY = 'august-folders-list-v1';

export const loadSessions = (): Session[] => {
  if (typeof localStorage === 'undefined') return [];
  const saved = localStorage.getItem(LOCAL_SESSIONS_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as Session[];
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch {
      /* silent */
    }
  }
  return [];
};

export const loadFolders = (): Folder[] => {
  if (typeof localStorage === 'undefined') return [];
  const saved = localStorage.getItem(LOCAL_FOLDERS_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch {
      /* silent */
    }
  }
  return [];
};

export const saveSessionsToStorage = (sessions: Session[]) => {
  try {
    localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(sessions));
  } catch (err) {
    // MUST NOT throw: this runs mid-send (updateSessionModel), and a
    // QuotaExceeded here escaped send() and wedged the double-Enter latch —
    // the desktop app then silently ignored every further Send click.
    // Self-heal: evict old chat transcripts to free quota, retry once; if
    // still failing, keep going — the in-memory store is already updated and
    // the send must proceed.
    try {
      import('@/sections/chat/message-storage').then(({ evictOldestTranscripts }) => {
        evictOldestTranscripts(null);
        try {
          localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(sessions));
        } catch {
          /* give up quietly — session list stays memory-only this round */
        }
      }).catch(() => undefined);
    } catch {
      /* dynamic import unavailable — keep going */
    }
    console.warn('[sessions/storage] save failed (quota?) — continuing without persisting', err);
  }
};

export const saveFoldersToStorage = (folders: Folder[]) => {
  try {
    localStorage.setItem(LOCAL_FOLDERS_KEY, JSON.stringify(folders));
  } catch {
    /* quota — folders stay memory-only this round */
  }
};
