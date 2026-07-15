/* ── SessionRepository ────────────────────────────────────────────────── */
/* Loads and mutates chat session records outside React components.       */

import {
  useSessionsStore,
  createSession,
  renameSession,
  deleteSession,
  archiveSession,
  type Session,
  type SessionStatus,
  type Folder,
  setSessionStatus,
  clearSessionStatus,
  saveSessionsToStorage,
} from './sessions';

/**
 * Repository-style access to chat sessions and folders.
 * Prefer hooks (`useSessionsStore`) in React; use this class from services.
 */
export class SessionRepository {
  list(includeArchived = false): Session[] {
    const all = useSessionsStore.getState().sessions;
    return includeArchived ? all : all.filter((s) => !s.isArchived);
  }

  get(id: string): Session | undefined {
    return useSessionsStore
      .getState()
      .sessions.find((s) => s.id === id || s.workbenchSessionId === id);
  }

  create(folderId: string | null = null, title?: string, workspacePath?: string | null): Session {
    return createSession(folderId, title, workspacePath);
  }

  rename(id: string, title: string): void {
    renameSession(id, title);
  }

  remove(id: string): void {
    deleteSession(id);
  }

  archive(id: string): void {
    archiveSession(id);
  }

  setStatus(id: string, status: SessionStatus): void {
    setSessionStatus(id, status);
  }

  clearStatus(id: string): void {
    clearSessionStatus(id);
  }

  folders(): Folder[] {
    return useSessionsStore.getState().folders;
  }

  /** Persist current snapshot (normally automatic). */
  persist(): void {
    saveSessionsToStorage(useSessionsStore.getState().sessions);
  }
}

export const sessionRepository = new SessionRepository();
