import { create } from 'zustand';
import { deleteWorkbenchSession, getWorkbenchSessions } from '@/api/workbench';
import { deleteManageSession } from '@/api/api-client';

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

export interface Folder {
  id: string;
  name: string;
  isCollapsed?: boolean;
  /** Filesystem path this folder represents (for workspace folders created via
   *  the folder picker). Manual sidebar folders have `null`/`undefined` here and
   *  are never auto-matched to a path. */
  workspacePath?: string | null;
}

const LOCAL_SESSIONS_KEY = 'august-sessions-list-v1';
const LOCAL_FOLDERS_KEY = 'august-folders-list-v1';

const loadSessions = (): Session[] => {
  if (typeof localStorage === 'undefined') return [];
  const saved = localStorage.getItem(LOCAL_SESSIONS_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch { /* silent */ }
  }
  return [];
};

const loadFolders = (): Folder[] => {
  if (typeof localStorage === 'undefined') return [];
  const saved = localStorage.getItem(LOCAL_FOLDERS_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch { /* silent */ }
  }
  return [];
};

interface SessionsState {
  sessions: Session[];
  folders: Folder[];
  sessionStates: Record<string, SessionStatus>;
}

export const useSessionsStore = create<SessionsState>(() => ({
  sessions: loadSessions(),
  folders: loadFolders(),
  sessionStates: {},
}));

/** Nanostores-shaped shims for imperative get/set callers and tests. */
export const $sessions = {
  get: (): Session[] => useSessionsStore.getState().sessions,
  set: (sessions: Session[]): void => {
    useSessionsStore.setState({ sessions });
  },
  subscribe: (listener: (sessions: Session[]) => void): (() => void) => {
    listener(useSessionsStore.getState().sessions);
    return useSessionsStore.subscribe((s) => listener(s.sessions));
  },
};

export const $folders = {
  get: (): Folder[] => useSessionsStore.getState().folders,
  set: (folders: Folder[]): void => {
    useSessionsStore.setState({ folders });
  },
  subscribe: (listener: (folders: Folder[]) => void): (() => void) => {
    listener(useSessionsStore.getState().folders);
    return useSessionsStore.subscribe((s) => listener(s.folders));
  },
};

export const $sessionStates = {
  get: (): Record<string, SessionStatus> => useSessionsStore.getState().sessionStates,
  set: (sessionStates: Record<string, SessionStatus>): void => {
    useSessionsStore.setState({ sessionStates });
  },
  subscribe: (listener: (states: Record<string, SessionStatus>) => void): (() => void) => {
    listener(useSessionsStore.getState().sessionStates);
    return useSessionsStore.subscribe((s) => listener(s.sessionStates));
  },
};

export function setSessionStatus(id: string, status: SessionStatus) {
  const prev = useSessionsStore.getState().sessionStates;
  useSessionsStore.setState({ sessionStates: { ...prev, [id]: status } });
}

export function clearSessionStatus(id: string) {
  const prev = { ...useSessionsStore.getState().sessionStates };
  delete prev[id];
  useSessionsStore.setState({ sessionStates: prev });
}

export const saveSessionsToStorage = (sessions: Session[]) => {
  localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(sessions));
};

export const saveFoldersToStorage = (folders: Folder[]) => {
  localStorage.setItem(LOCAL_FOLDERS_KEY, JSON.stringify(folders));
};

/** Human-readable session id with local date/time, e.g. sess_20260715_143052_a1b2 */
function makeSessionId(prefix = 'sess'): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${stamp}_${rand}`;
}

/** Default title stamped with local date/time until the first user message. */
export function defaultSessionTitle(when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  return `Chat ${stamp}`;
}

export function createSession(folderId: string | null = null, title?: string, workspacePath?: string | null): Session {
  const newSess: Session = {
    id: makeSessionId('sess'),
    title: title ?? defaultSessionTitle(),
    startedAt: new Date().toISOString(),
    messageCount: 0,
    lastMessage: 'Conversation started.',
    provider: '',
    model: '',
    folderId,
    isArchived: false,
    workspacePath: workspacePath ?? null,
  };
  const updated = [newSess, ...useSessionsStore.getState().sessions];
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
  return newSess;
}

export function renameSession(id: string, newTitle: string) {
  const updated = useSessionsStore.getState().sessions.map(s => s.id === id ? { ...s, title: newTitle } : s);
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
}

export function updateSessionModel(id: string, model: string, provider: string) {
  const updated = useSessionsStore.getState().sessions.map(s => s.id === id ? { ...s, model, provider } : s);
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
}

export function updateSessionWorkbenchMetadata(
  id: string,
  metadata: Pick<Session, 'workbenchSessionId' | 'workbenchAgentId' | 'workbenchProvider'>
) {
  // Keep the sidebar/route session id STABLE. Rewriting `s.id` to the
  // workbench id mid-turn caused ChatLayout to treat the URL as invalid,
  // navigate away, remount ChatThread, and drop the in-flight stream —
  // so free-model replies (which work fine on the API) never appeared.
  // workbenchSessionId is the backend handle; UI keys stay on `s.id`.
  const updated = useSessionsStore.getState().sessions.map((s) => {
    if (s.id !== id && s.workbenchSessionId !== id) return s;
    return { ...s, ...metadata };
  });
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
}

/**
 * Purge a session from the backend (workbench SoT + brain SQLite cascade).
 * Best-effort: local UI delete still succeeds if the network is down.
 */
async function purgeBackendSession(ids: string[]): Promise<void> {
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = (raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      await deleteWorkbenchSession(id);
    } catch {
      // Workbench may not know this id (local-only UI session) — try manage plane.
      try {
        await deleteManageSession(id);
      } catch {
        /* ignore — local delete already applied */
      }
    }
  }
}

/**
 * Remove a session from the sidebar and permanently delete backend data.
 * Optimistic: UI updates immediately (AnimatePresence exit runs); backend
 * purge runs in the background so a network blip doesn't block the animation.
 */
export function deleteSession(id: string) {
  const sessions = useSessionsStore.getState().sessions;
  const sess = sessions.find((s) => s.id === id || s.workbenchSessionId === id);
  const updated = sessions.filter(
    (s) => s.id !== id && s.workbenchSessionId !== id && s.id !== sess?.id,
  );
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);

  const localIds = [id, sess?.id, sess?.workbenchSessionId].filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );
  for (const lid of localIds) {
    localStorage.removeItem(`chat_messages_${lid}`);
    localStorage.removeItem(`august_composer_draft_${lid}`);
  }

  void purgeBackendSession(localIds);
}

export function archiveSession(id: string) {
  const updated = useSessionsStore.getState().sessions.map(s => s.id === id ? { ...s, isArchived: true } : s);
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
}

export function restoreSession(id: string) {
  const { sessions, folders } = useSessionsStore.getState();
  const sess = sessions.find(s => s.id === id);
  if (sess && sess.folderId) {
    // If the folder it originally belonged to was deleted, recreate it
    const folderExists = folders.some(f => f.id === sess.folderId);
    if (!folderExists) {
      const newFolders = [...folders, { id: sess.folderId, name: 'Restored', isCollapsed: false }];
      useSessionsStore.setState({ folders: newFolders });
      saveFoldersToStorage(newFolders);
    }
  }

  const updated = useSessionsStore.getState().sessions.map(s => s.id === id ? { ...s, isArchived: false } : s);
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
}

export function moveSessionToFolder(id: string, folderId: string | null) {
  const updated = useSessionsStore.getState().sessions.map(s => s.id === id ? { ...s, folderId } : s);
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
}

export function clearAllSessions(includeArchived: boolean = true) {
  const sessions = useSessionsStore.getState().sessions;
  const toDelete = sessions.filter((s) => includeArchived || !s.isArchived);

  // Clear all localStorage chat histories
  toDelete.forEach((s) => {
    localStorage.removeItem(`chat_messages_${s.id}`);
    localStorage.removeItem(`august_composer_draft_${s.id}`);
    if (s.workbenchSessionId) {
      localStorage.removeItem(`chat_messages_${s.workbenchSessionId}`);
      localStorage.removeItem(`august_composer_draft_${s.workbenchSessionId}`);
    }
  });

  const nextSessions = includeArchived
    ? []
    : sessions.filter((s) => s.isArchived);

  // Keep or create a single fresh empty session
  const newSess: Session = {
    id: makeSessionId('sess'),
    title: defaultSessionTitle(),
    startedAt: new Date().toISOString(),
    messageCount: 0,
    lastMessage: 'Conversation started.',
    provider: '',
    model: '',
    folderId: null,
    isArchived: false,
  };

  const finalSessions = [newSess, ...nextSessions];
  useSessionsStore.setState({ sessions: finalSessions });
  saveSessionsToStorage(finalSessions);

  // Purge backend rows so reconcile can't resurrect wiped chats
  const backendIds = toDelete.flatMap((s) =>
    [s.id, s.workbenchSessionId].filter((x): x is string => !!x),
  );
  void purgeBackendSession(backendIds);

  return newSess;
}

/**
 * Reconcile chat sidebar sessions from the workbench session SoT only
 * (`GET /api/workbench/sessions`). Do not use `/api/sessions` for chat —
 * that plane is non-chat / manage-only.
 *
 * Match order: local.workbenchSessionId → local.id → backend id.
 * Frontend-only fields (lastMessage, folderId, …) are preserved on merge.
 * Silently falls back to local state if the backend is unavailable.
 */
export async function reconcileSessionsFromBackend(): Promise<void> {
  try {
    const backendSessions = await getWorkbenchSessions();
    const backendMap = new Map(backendSessions.map(s => [s.id, s]));

    const current = useSessionsStore.getState().sessions;
    const merged: Session[] = [];
    const claimed = new Set<string>();
    const now = new Date().toISOString();

    for (const local of current) {
      const key = local.workbenchSessionId || local.id;
      const backend = backendMap.get(key) ?? backendMap.get(local.id);
      if (backend) {
        claimed.add(backend.id);
        // Single ID scheme: sidebar id is always the workbench SoT id.
        merged.push({
          ...local,
          id: backend.id,
          workbenchSessionId: backend.id,
          title: (backend.title as string | undefined) || local.title,
          startedAt: local.startedAt,
          messageCount: backend.messageCount ?? local.messageCount,
          provider: backend.provider || local.provider,
          model: (backend.model as string | undefined) || local.model,
          workbenchProvider: backend.provider || local.workbenchProvider,
        });
      }
      // Not in workbench SoT → dropped from sidebar (deleted server-side).
    }

    for (const bs of backendSessions) {
      if (claimed.has(bs.id)) continue;
      merged.push({
        id: bs.id,
        title: (bs.title as string | undefined) || 'New Session',
        startedAt: (bs.updatedAt as string | undefined) || now,
        messageCount: bs.messageCount ?? 0,
        lastMessage: 'Conversation started.',
        provider: bs.provider || '',
        model: (bs.model as string | undefined) || '',
        workbenchSessionId: bs.id,
        workbenchProvider: bs.provider || '',
      });
    }

    useSessionsStore.setState({ sessions: merged });
    saveSessionsToStorage(merged);
  } catch {
    // Backend unreachable — keep local state intact.
  }
}

export function createFolder(name: string, workspacePath?: string | null): Folder {
  const newFolder: Folder = {
    id: 'folder_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5),
    name,
    isCollapsed: false,
    workspacePath: workspacePath ?? null,
  };
  const updated = [...useSessionsStore.getState().folders, newFolder];
  useSessionsStore.setState({ folders: updated });
  saveFoldersToStorage(updated);
  return newFolder;
}

export function renameFolder(id: string, newName: string) {
  const updated = useSessionsStore.getState().folders.map(f => f.id === id ? { ...f, name: newName } : f);
  useSessionsStore.setState({ folders: updated });
  saveFoldersToStorage(updated);
}

export function deleteFolder(id: string) {
  const updatedFolders = useSessionsStore.getState().folders.filter(f => f.id !== id);
  useSessionsStore.setState({ folders: updatedFolders });
  saveFoldersToStorage(updatedFolders);

  // Sessions in deleted folder move to root (null)
  const updatedSessions = useSessionsStore.getState().sessions.map(s => s.folderId === id ? { ...s, folderId: null } : s);
  useSessionsStore.setState({ sessions: updatedSessions });
  saveSessionsToStorage(updatedSessions);
}

export function toggleFolderCollapse(id: string) {
  const updated = useSessionsStore.getState().folders.map(f => f.id === id ? { ...f, isCollapsed: !f.isCollapsed } : f);
  useSessionsStore.setState({ folders: updated });
  saveFoldersToStorage(updated);
}

export function updateSessionWorkspace(id: string, path: string | null) {
  const updated = useSessionsStore.getState().sessions.map(s => s.id === id ? { ...s, workspacePath: path } : s);
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
}

/**
 * Normalise a filesystem path for consistent comparison.
 * Replaces backslashes with forward slashes and strips trailing slashes.
 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Derive a human‑readable folder name from a filesystem path.
 */
function folderNameFromPath(path: string): string {
  const normalized = normalizePath(path);
  const segments = normalized.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : 'workspace';
}

/**
 * Find an existing session by workspace path, or create a new one.
 * Normalises paths for consistent matching.
 *
 * Returns the matched/created session and a flag indicating whether
 * it was newly created.
 */
export function findOrCreateSessionForPath(
  path: string,
  folderName?: string,
): { session: Session; created: boolean } {
  const normalized = normalizePath(path);
  const name = folderName ?? folderNameFromPath(path);

  // Find an existing folder representing this filesystem path. Manual folders
  // (created via the sidebar "New folder" button) have `workspacePath == null`
  // and are intentionally never matched here.
  let folder = useSessionsStore.getState().folders.find(f => f.workspacePath === normalized);
  if (!folder) {
    folder = createFolder(name, normalized);
  }

  // Re-parent any pre-existing sessions that share this workspace path into
  // the folder so they appear grouped (satisfies the "group existing sessions"
  // requirement). moveSessionToFolder persists the change.
  for (const s of useSessionsStore.getState().sessions) {
    if (s.workspacePath === normalized && s.folderId !== folder.id) {
      moveSessionToFolder(s.id, folder.id);
    }
  }

  // Check if a session already exists for this folder path.
  const existing = useSessionsStore.getState().sessions.find(s => s.workspacePath === normalized);
  if (existing) {
    // Ensure the existing session is associated with the folder.
    if (existing.folderId !== folder.id) {
      moveSessionToFolder(existing.id, folder.id);
    }
    return { session: existing, created: false };
  }

  // Create a new session tied to this folder path, under the folder.
  const session = createSession(folder.id, `Project: ${name}`, normalized);
  return { session, created: true };
}
