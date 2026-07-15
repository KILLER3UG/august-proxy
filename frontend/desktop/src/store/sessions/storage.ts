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
  localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(sessions));
};

export const saveFoldersToStorage = (folders: Folder[]) => {
  localStorage.setItem(LOCAL_FOLDERS_KEY, JSON.stringify(folders));
};
