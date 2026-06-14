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
}

export type SessionStatus = 'idle' | 'working' | 'awaiting' | 'error' | 'done';

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

const DEFAULT_FOLDERS: Folder[] = [
  { id: 'f_work', name: 'Work', isCollapsed: false },
  { id: 'f_research', name: 'Research', isCollapsed: false },
  { id: 'f_personal', name: 'Personal', isCollapsed: false },
];

const DEFAULT_SESSIONS: Session[] = [
  // Work folder
  { id: 'sess_1', title: 'Refactor the dashboard nav', startedAt: new Date(Date.now() - 3600000).toISOString(), messageCount: 12, lastMessage: 'Done — committed on refactor/ui-v2.', provider: 'opencode-go', model: 'claude-opus-4-7', folderId: 'f_work', isArchived: false },
  { id: 'sess_2', title: 'Add providers page', startedAt: new Date(Date.now() - 7200000).toISOString(), messageCount: 5, lastMessage: 'Looking at the inspector now.', provider: 'minimax', model: 'gpt-5', folderId: 'f_work', isArchived: false },
  { id: 'sess_3', title: 'Fix URL routing bug', startedAt: new Date(Date.now() - 10800000).toISOString(), messageCount: 8, lastMessage: 'Pushed. Need review.', provider: 'kilo', model: 'kilo/kimi-k2', folderId: 'f_work', isArchived: false },
  { id: 'sess_4', title: 'Wire up statusbar', startedAt: new Date(Date.now() - 14400000).toISOString(), messageCount: 20, lastMessage: 'Will continue tomorrow.', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', folderId: 'f_work', isArchived: false },

  // Research folder
  { id: 'sess_5', title: 'Memory graph query', startedAt: new Date(Date.now() - 18000000).toISOString(), messageCount: 15, lastMessage: 'Pushed. Need review.', provider: 'opencode-go', model: 'claude-opus-4-7', folderId: 'f_research', isArchived: false },
  { id: 'sess_6', title: 'Embed terminal in chat', startedAt: new Date(Date.now() - 21600000).toISOString(), messageCount: 3, lastMessage: 'Done — committed on refactor/ui-v2.', provider: 'minimax', model: 'gpt-5', folderId: 'f_research', isArchived: false },
  { id: 'sess_7', title: 'Refactor to React 19', startedAt: new Date(Date.now() - 25200000).toISOString(), messageCount: 22, lastMessage: 'Will continue tomorrow.', provider: 'kilo', model: 'kilo/kimi-k2', folderId: 'f_research', isArchived: false },

  // Personal folder
  { id: 'sess_8', title: 'Tauri tray icon', startedAt: new Date(Date.now() - 28800000).toISOString(), messageCount: 6, lastMessage: 'Looking at the inspector now.', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', folderId: 'f_personal', isArchived: false },
  { id: 'sess_9', title: 'Ship the desktop MSI', startedAt: new Date(Date.now() - 32400000).toISOString(), messageCount: 11, lastMessage: 'Pushed. Need review.', provider: 'opencode-go', model: 'claude-opus-4-7', folderId: 'f_personal', isArchived: false },

  // Root level (No folder)
  { id: 'sess_10', title: 'Onboarding flow', startedAt: new Date(Date.now() - 36000000).toISOString(), messageCount: 4, lastMessage: 'Done — committed on refactor/ui-v2.', provider: 'minimax', model: 'gpt-5', folderId: null, isArchived: false },
  { id: 'sess_11', title: 'Add cmdk palette', startedAt: new Date(Date.now() - 39600000).toISOString(), messageCount: 2, lastMessage: 'Looking at the inspector now.', provider: 'kilo', model: 'kilo/kimi-k2', folderId: null, isArchived: false },
  { id: 'sess_12', title: 'Fix rerenderCostSummary', startedAt: new Date(Date.now() - 43200000).toISOString(), messageCount: 7, lastMessage: 'Will continue tomorrow.', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', folderId: null, isArchived: false },
];

const LOCAL_SESSIONS_KEY = 'august-sessions-list-v1';
const LOCAL_FOLDERS_KEY = 'august-folders-list-v1';

const loadSessions = (): Session[] => {
  const saved = localStorage.getItem(LOCAL_SESSIONS_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch {}
  }
  return DEFAULT_SESSIONS;
};

const loadFolders = (): Folder[] => {
  const saved = localStorage.getItem(LOCAL_FOLDERS_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch {}
  }
  return DEFAULT_FOLDERS;
};

export const $sessions = atom<Session[]>(loadSessions());
export const $folders = atom<Folder[]>(loadFolders());

export const saveSessionsToStorage = (sessions: Session[]) => {
  localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(sessions));
};

export const saveFoldersToStorage = (folders: Folder[]) => {
  localStorage.setItem(LOCAL_FOLDERS_KEY, JSON.stringify(folders));
};

export function createSession(folderId: string | null = null, title: string = 'New Chat'): Session {
  const newSess: Session = {
    id: 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5),
    title,
    startedAt: new Date().toISOString(),
    messageCount: 0,
    lastMessage: 'Conversation started.',
    provider: 'opencode-zen',
    model: 'deepseek-v4-flash-free',
    folderId,
    isArchived: false,
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

export function deleteSession(id: string) {
  const updated = $sessions.get().filter(s => s.id !== id);
  $sessions.set(updated);
  saveSessionsToStorage(updated);
  localStorage.removeItem(`chat_messages_${id}`);
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
      // Find original folder name from static details if it was f_work/f_research/f_personal
      let folderName = 'Restored';
      if (sess.folderId === 'f_work') folderName = 'Work';
      else if (sess.folderId === 'f_research') folderName = 'Research';
      else if (sess.folderId === 'f_personal') folderName = 'Personal';
      
      const newFolders = [...$folders.get(), { id: sess.folderId, name: folderName, isCollapsed: false }];
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
    provider: 'opencode-zen',
    model: 'deepseek-v4-flash-free',
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
