import { create } from 'zustand';
import { deleteWorkbenchSession } from '@/api/workbench';
import { deleteManageSession } from '@/api/api-client';
import {
  defaultSessionTitle,
  dedupeSessions,
  deriveSessionTitleFromMessage,
  folderNameFromPath,
  isPlaceholderTitle,
  makeSessionId,
  normalizePath,
  preferSessionRow,
  preferSessionTitle,
  sessionIsEmpty,
} from './sessions/helpers';
import { reconcileSessionsFromBackend as reconcileSessionsFromBackendImpl } from './sessions/reconcile';
import {
  loadFolders,
  loadSessions,
  saveFoldersToStorage,
  saveSessionsToStorage,
} from './sessions/storage';
import { isSessionIdTombstoned, tombstoneSessionId } from './sessions/tombstone';
import type { Folder, Session, SessionStatus } from './sessions/types';

export type { Session, SessionStatus, Folder } from './sessions/types';
export {
  defaultSessionTitle,
  dedupeSessions,
  deriveSessionTitleFromMessage,
  isPlaceholderTitle,
  preferSessionRow,
  preferSessionTitle,
  sessionIsEmpty,
} from './sessions/helpers';
export { saveFoldersToStorage, saveSessionsToStorage } from './sessions/storage';

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

export function createSession(
  folderId: string | null = null,
  title?: string,
  workspacePath?: string | null,
): Session {
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

/** One-shot heal for corrupt localStorage pairs (sess_* + wb_* duplicates). */
export function healDuplicateSessions(): void {
  const current = useSessionsStore.getState().sessions;
  const healed = dedupeSessions(current);
  if (healed.length === current.length) {
    // Still rewrite storage if content changed (same length, different ids)
    const same =
      healed.length === current.length &&
      healed.every(
        (s, i) =>
          s.id === current[i]?.id && s.workbenchSessionId === current[i]?.workbenchSessionId,
      );
    if (same) return;
  }
  useSessionsStore.setState({ sessions: healed });
  saveSessionsToStorage(healed);
}

/**
 * Find an existing empty chat in the same folder/workspace so "New session"
 * does not stack blank chats when the user is already on one.
 */
export function findReusableEmptySession(
  opts: {
    folderId?: string | null;
    workspacePath?: string | null;
  } = {},
): Session | null {
  const folderId = opts.folderId ?? null;
  const workspacePath = opts.workspacePath ?? null;
  const sessions = useSessionsStore.getState().sessions;
  return (
    sessions.find((s) => {
      if (!sessionIsEmpty(s)) return false;
      if ((s.folderId ?? null) !== folderId) return false;
      // Match workspace when both sides have a path; empty workspace is reusable.
      if (workspacePath && s.workspacePath && s.workspacePath !== workspacePath) {
        return false;
      }
      return true;
    }) ?? null
  );
}

/**
 * Create a session, or reuse an existing empty one (same folder/workspace).
 * Moves the reused session to the top of the list for visibility.
 */
export function getOrCreateEmptySession(
  folderId: string | null = null,
  title?: string,
  workspacePath?: string | null,
): Session {
  const existing = findReusableEmptySession({ folderId, workspacePath });
  if (existing) {
    // Bump to top so it feels like "new" without stacking blanks.
    const rest = useSessionsStore.getState().sessions.filter((s) => s.id !== existing.id);
    const bumped: Session = {
      ...existing,
      folderId: folderId ?? existing.folderId ?? null,
      workspacePath: workspacePath ?? existing.workspacePath ?? null,
      startedAt: new Date().toISOString(),
      title: isPlaceholderTitle(existing.title)
        ? (title ?? defaultSessionTitle())
        : existing.title,
    };
    const updated = [bumped, ...rest];
    useSessionsStore.setState({ sessions: updated });
    saveSessionsToStorage(updated);
    return bumped;
  }
  return createSession(folderId, title, workspacePath);
}

/**
 * Start a new empty chat inside a Repositories (or manual) folder — Codex-style
 * multi-thread per project. Inherits the folder's workspacePath when set.
 */
export function createEmptySessionInFolder(
  folderId: string,
  title?: string,
): Session {
  const folder = useSessionsStore.getState().folders.find((f) => f.id === folderId);
  const workspacePath = folder?.workspacePath ?? null;
  return getOrCreateEmptySession(folderId, title ?? defaultSessionTitle(), workspacePath);
}

export function renameSession(id: string, newTitle: string) {
  const title = newTitle.trim();
  if (!title) return;
  const sessions = useSessionsStore.getState().sessions;
  const sess = sessions.find((s) => s.id === id || s.workbenchSessionId === id);
  const updated = sessions.map((s) =>
    s.id === id || s.workbenchSessionId === id ? { ...s, title } : s,
  );
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);

  // Persist to workbench SoT so reconcile / other tabs keep the title.
  const backendId = sess?.workbenchSessionId || (id.startsWith('wb_') ? id : '');
  if (backendId) {
    void fetch(`/api/workbench/sessions/${encodeURIComponent(backendId)}/title`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).catch(() => {
      // Best-effort — local title already applied.
    });
  }
}

export function updateSessionModel(id: string, model: string, provider: string) {
  const updated = useSessionsStore
    .getState()
    .sessions.map((s) => (s.id === id ? { ...s, model, provider } : s));
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
}

export function updateSessionWorkbenchMetadata(
  id: string,
  metadata: Pick<Session, 'workbenchSessionId' | 'workbenchAgentId' | 'workbenchProvider'>,
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
  // SSE may have already inserted a standalone wb_* row for the same
  // workbench session — collapse so the sidebar never shows two entries.
  const deduped = dedupeSessions(updated);
  useSessionsStore.setState({ sessions: deduped });
  saveSessionsToStorage(deduped);
}

/**
 * Purge a session from the backend (workbench SoT + brain SQLite cascade).
 * Best-effort + parallel: local UI delete already applied; network must not block it.
 */
async function purgeBackendSession(ids: string[]): Promise<void> {
  const seen = new Set<string>();
  const unique = ids
    .map((raw) => (raw || '').trim())
    .filter((id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  await Promise.all(
    unique.map(async (id) => {
      try {
        await deleteWorkbenchSession(id);
      } catch {
        try {
          await deleteManageSession(id);
        } catch {
          /* ignore — local delete already applied */
        }
      }
    }),
  );
}

/**
 * Drop a session from the sidebar immediately (no network).
 * Used by optimistic UI deletes and real-time ``session_deleted`` SSE events
 * from the model’s delete_session tool.
 * @returns true if a row was removed
 */
export function removeSessionLocally(id: string): boolean {
  if (!id) return false;
  const sessions = useSessionsStore.getState().sessions;
  const sess = sessions.find((s) => s.id === id || s.workbenchSessionId === id);
  if (!sess && !sessions.some((s) => s.id === id || s.workbenchSessionId === id)) {
    // Still tombstone so a lagging reconcile cannot resurrect a just-deleted id.
    tombstoneSessionId(id);
    return false;
  }
  const dropIds = new Set(
    [id, sess?.id, sess?.workbenchSessionId].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    ),
  );
  for (const d of dropIds) tombstoneSessionId(d);

  const updated = sessions.filter(
    (s) => !dropIds.has(s.id) && !(s.workbenchSessionId && dropIds.has(s.workbenchSessionId)),
  );
  if (updated.length === sessions.length) {
    tombstoneSessionId(id);
    return false;
  }
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
  for (const lid of dropIds) {
    try {
      localStorage.removeItem(`chat_messages_${lid}`);
      localStorage.removeItem(`august_composer_draft_${lid}`);
    } catch {
      /* ignore */
    }
  }
  return true;
}

/**
 * Remove a session from the sidebar and permanently delete backend data.
 * Optimistic: UI updates immediately (AnimatePresence exit runs); backend
 * purge runs in the background so a network blip doesn't block the animation.
 */
export function deleteSession(id: string) {
  const sessions = useSessionsStore.getState().sessions;
  const sess = sessions.find((s) => s.id === id || s.workbenchSessionId === id);
  const localIds = [id, sess?.id, sess?.workbenchSessionId].filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );
  removeSessionLocally(id);
  // Fire-and-forget — never await on the UI path
  void purgeBackendSession(localIds);
}

export function archiveSession(id: string) {
  const updated = useSessionsStore
    .getState()
    .sessions.map((s) => (s.id === id ? { ...s, isArchived: true } : s));
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
}

export function restoreSession(id: string) {
  const { sessions, folders } = useSessionsStore.getState();
  const sess = sessions.find((s) => s.id === id);
  if (sess && sess.folderId) {
    // If the folder it originally belonged to was deleted, recreate it
    const folderExists = folders.some((f) => f.id === sess.folderId);
    if (!folderExists) {
      const newFolders = [...folders, { id: sess.folderId, name: 'Restored', isCollapsed: false }];
      useSessionsStore.setState({ folders: newFolders });
      saveFoldersToStorage(newFolders);
    }
  }

  const updated = useSessionsStore
    .getState()
    .sessions.map((s) => (s.id === id ? { ...s, isArchived: false } : s));
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
}

export function moveSessionToFolder(id: string, folderId: string | null) {
  const updated = useSessionsStore
    .getState()
    .sessions.map((s) => (s.id === id ? { ...s, folderId } : s));
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

  const nextSessions = includeArchived ? [] : sessions.filter((s) => s.isArchived);

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

export async function reconcileSessionsFromBackend(): Promise<void> {
  return reconcileSessionsFromBackendImpl({
    getSessions: () => useSessionsStore.getState().sessions,
    setSessions: (sessions) => useSessionsStore.setState({ sessions }),
  });
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
  const updated = useSessionsStore
    .getState()
    .folders.map((f) => (f.id === id ? { ...f, name: newName } : f));
  useSessionsStore.setState({ folders: updated });
  saveFoldersToStorage(updated);
}

export function deleteFolder(id: string) {
  const updatedFolders = useSessionsStore.getState().folders.filter((f) => f.id !== id);
  useSessionsStore.setState({ folders: updatedFolders });
  saveFoldersToStorage(updatedFolders);

  // Sessions in deleted folder move to root (null)
  const updatedSessions = useSessionsStore
    .getState()
    .sessions.map((s) => (s.folderId === id ? { ...s, folderId: null } : s));
  useSessionsStore.setState({ sessions: updatedSessions });
  saveSessionsToStorage(updatedSessions);
}

export function toggleFolderCollapse(id: string) {
  const updated = useSessionsStore
    .getState()
    .folders.map((f) => (f.id === id ? { ...f, isCollapsed: !f.isCollapsed } : f));
  useSessionsStore.setState({ folders: updated });
  saveFoldersToStorage(updated);
}

export function updateSessionWorkspace(id: string, path: string | null) {
  const normalized = path == null ? null : normalizePath(path);
  const updated = useSessionsStore
    .getState()
    .sessions.map((s) => (s.id === id ? { ...s, workspacePath: normalized } : s));
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
}

/**
 * Ensure a Repositories sidebar folder exists for a filesystem path.
 * Creates one when the path is new; reuses the existing folder otherwise.
 */
export function ensureFolderForWorkspacePath(
  path: string,
  folderName?: string,
): { folder: Folder; created: boolean } {
  const normalized = normalizePath(path);
  const name = folderName ?? folderNameFromPath(path);
  const existing = useSessionsStore
    .getState()
    .folders.find((f) => f.workspacePath === normalized);
  if (existing) return { folder: existing, created: false };
  return { folder: createFolder(name, normalized), created: true };
}

/**
 * Point a session at a workspace path and ensure a Repositories sidebar
 * folder group exists for that path (creating one when the path is new).
 * Always keeps the caller on `sessionId` — does not switch to another chat.
 */
export function bindSessionToWorkspacePath(
  sessionId: string,
  path: string,
  folderName?: string,
): { session: Session; created: boolean; folderCreated: boolean } {
  const normalized = normalizePath(path);
  const { folder, created: folderCreated } = ensureFolderForWorkspacePath(
    path,
    folderName ?? folderNameFromPath(path),
  );

  updateSessionWorkspace(sessionId, normalized);
  moveSessionToFolder(sessionId, folder.id);

  // Re-parent any other sessions that already share this path.
  for (const s of useSessionsStore.getState().sessions) {
    if (s.id !== sessionId && s.workspacePath === normalized && s.folderId !== folder.id) {
      moveSessionToFolder(s.id, folder.id);
    }
  }

  const session =
    useSessionsStore.getState().sessions.find((s) => s.id === sessionId) ??
    createSession(folder.id, `Project: ${folder.name}`, normalized);

  return { session, created: false, folderCreated };
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
  const { folder } = ensureFolderForWorkspacePath(normalized, name);

  // Re-parent any pre-existing sessions that share this workspace path into
  // the folder so they appear grouped (satisfies the "group existing sessions"
  // requirement). moveSessionToFolder persists the change.
  for (const s of useSessionsStore.getState().sessions) {
    if (s.workspacePath === normalized && s.folderId !== folder.id) {
      moveSessionToFolder(s.id, folder.id);
    }
  }

  // Check if a session already exists for this folder path.
  const existing = useSessionsStore
    .getState()
    .sessions.find((s) => s.workspacePath === normalized);
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

// Re-export for internal consumers that need tombstone checks (e.g. tests).
export { isSessionIdTombstoned, tombstoneSessionId };
