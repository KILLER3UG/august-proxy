import { atom } from 'nanostores';

export interface Session {
  id: string;
  title: string;
  startedAt: string;
  messageCount: number;
  lastMessage: string;
  provider: string;
  model: string;
  folderId?: string | null;
  isArchived?: boolean;
  workspacePath?: string | null;
  workbenchSessionId?: string;
  workbenchAgentId?: string;
  workbenchProvider?: string;
}

export type SessionStatus = 'idle' | 'working' | 'awaiting' | 'error' | 'done' | 'streaming';

export const $sessionStates = atom<Record<string, SessionStatus>>({});

export function setSessionStatus(id: string, status: SessionStatus) {
  const prev = $sessionStates.get();
  $sessionStates.set({ ...prev, [id]: status });
}

export function clearSessionStatus(id: string) {
  const prev = { ...$sessionStates.get() };
  delete prev[id];
  $sessionStates.set(prev);
}

export interface Folder {
  id: string;
  name: string;
  isCollapsed?: boolean;
}

const LOCAL_SESSIONS_KEY = 'august-sessions-list-v1';
const LOCAL_FOLDERS_KEY = 'august-folders-list-v1';

const loadSessions = (): Session[] => {
  const saved = localStorage.getItem(LOCAL_SESSIONS_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch {}
  }
  return [];
};

const loadFolders = (): Folder[] => {
  const saved = localStorage.getItem(LOCAL_FOLDERS_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch {}
  }
  return [];
};

export const $sessions = atom<Session[]>(loadSessions());
export const $folders = atom<Folder[]>(loadFolders());

export const saveSessionsToStorage = (sessions: Session[]) => {
  localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(sessions));
};

export const saveFoldersToStorage = (folders: Folder[]) => {
  localStorage.setItem(LOCAL_FOLDERS_KEY, JSON.stringify(folders));
};

export function createSession(folderId: string | null = null, title: string = 'New Chat', workspacePath?: string | null): Session {
  const newSess: Session = {
    id: 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5),
    title,
    startedAt: new Date().toISOString(),
    messageCount: 0,
    lastMessage: 'Conversation started.',
    provider: '',
    model: '',
    folderId,
    isArchived: false,
    workspacePath: workspacePath ?? null,
  };
  const updated = [newSess, ...$sessions.get()];
  $sessions.set(updated);
  saveSessionsToStorage(updated);
  return newSess;
}

export function renameSession(id: string, newTitle: string) {
  const updated = $sessions.get().map(s => s.id === id ? { ...s, title: newTitle } : s);
  $sessions.set(updated);
  saveSessionsToStorage(updated);
}

export function updateSessionModel(id: string, model: string, provider: string) {
  const updated = $sessions.get().map(s => s.id === id ? { ...s, model, provider } : s);
  $sessions.set(updated);
  saveSessionsToStorage(updated);
}

export function updateSessionWorkbenchMetadata(
  id: string,
  metadata: Pick<Session, 'workbenchSessionId' | 'workbenchAgentId' | 'workbenchProvider'>
) {
  const updated = $sessions.get().map(s => s.id === id ? { ...s, ...metadata } : s);
  $sessions.set(updated);
  saveSessionsToStorage(updated);
}

export function deleteSession(id: string) {
  const updated = $sessions.get().filter(s => s.id !== id);
  $sessions.set(updated);
  saveSessionsToStorage(updated);
  localStorage.removeItem(`chat_messages_${id}`);
  localStorage.removeItem(`august_composer_draft_${id}`);
}

export function archiveSession(id: string) {
  const updated = $sessions.get().map(s => s.id === id ? { ...s, isArchived: true } : s);
  $sessions.set(updated);
  saveSessionsToStorage(updated);
}

export function restoreSession(id: string) {
  const sess = $sessions.get().find(s => s.id === id);
  if (sess && sess.folderId) {
    // If the folder it originally belonged to was deleted, recreate it
    const folderExists = $folders.get().some(f => f.id === sess.folderId);
    if (!folderExists) {
      const newFolders = [...$folders.get(), { id: sess.folderId, name: 'Restored', isCollapsed: false }];
      $folders.set(newFolders);
      saveFoldersToStorage(newFolders);
    }
  }

  const updated = $sessions.get().map(s => s.id === id ? { ...s, isArchived: false } : s);
  $sessions.set(updated);
  saveSessionsToStorage(updated);
}

export function moveSessionToFolder(id: string, folderId: string | null) {
  const updated = $sessions.get().map(s => s.id === id ? { ...s, folderId } : s);
  $sessions.set(updated);
  saveSessionsToStorage(updated);
}

export function clearAllSessions(includeArchived: boolean = true) {
  const sessions = $sessions.get();
  
  // Clear all localStorage chat histories
  sessions.forEach(s => {
    if (includeArchived || !s.isArchived) {
      localStorage.removeItem(`chat_messages_${s.id}`);
      localStorage.removeItem(`august_composer_draft_${s.id}`);
    }
  });

  const nextSessions = includeArchived 
    ? [] 
    : sessions.filter(s => s.isArchived);

  // Keep or create a single fresh empty session
  const newSess: Session = {
    id: 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5),
    title: 'New Chat',
    startedAt: new Date().toISOString(),
    messageCount: 0,
    lastMessage: 'Conversation started.',
    provider: '',
    model: '',
    folderId: null,
    isArchived: false,
  };

  const finalSessions = [newSess, ...nextSessions];
  $sessions.set(finalSessions);
  saveSessionsToStorage(finalSessions);
  return newSess;
}

export function createFolder(name: string): Folder {
  const newFolder: Folder = {
    id: 'folder_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5),
    name,
    isCollapsed: false,
  };
  const updated = [...$folders.get(), newFolder];
  $folders.set(updated);
  saveFoldersToStorage(updated);
  return newFolder;
}

export function renameFolder(id: string, newName: string) {
  const updated = $folders.get().map(f => f.id === id ? { ...f, name: newName } : f);
  $folders.set(updated);
  saveFoldersToStorage(updated);
}

export function deleteFolder(id: string) {
  const updatedFolders = $folders.get().filter(f => f.id !== id);
  $folders.set(updatedFolders);
  saveFoldersToStorage(updatedFolders);

  // Sessions in deleted folder move to root (null)
  const updatedSessions = $sessions.get().map(s => s.folderId === id ? { ...s, folderId: null } : s);
  $sessions.set(updatedSessions);
  saveSessionsToStorage(updatedSessions);
}

export function toggleFolderCollapse(id: string) {
  const updated = $folders.get().map(f => f.id === id ? { ...f, isCollapsed: !f.isCollapsed } : f);
  $folders.set(updated);
  saveFoldersToStorage(updated);
}

export function updateSessionWorkspace(id: string, path: string | null) {
  const updated = $sessions.get().map(s => s.id === id ? { ...s, workspacePath: path } : s);
  $sessions.set(updated);
  saveSessionsToStorage(updated);
}
