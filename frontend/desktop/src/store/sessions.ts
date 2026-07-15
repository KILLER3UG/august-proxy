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

/** True when the title is still a default/empty placeholder. */
export function isPlaceholderTitle(title: string | null | undefined): boolean {
  const t = (title || '').trim();
  if (!t) return true;
  if (/^(new chat|new session|untitled|conversation started\.?)$/i.test(t)) return true;
  // Date-stamped defaults: "Chat 2026-07-15 14:30" / "Chat 2026-07-15 14:30 UTC"
  if (/^chat\s+\d{4}-\d{2}-\d{2}/i.test(t)) return true;
  return false;
}

/** Prefer a real title over a placeholder when merging local + backend. */
export function preferSessionTitle(
  preferred: string | null | undefined,
  fallback: string | null | undefined,
): string {
  if (preferred && !isPlaceholderTitle(preferred)) return preferred.trim();
  if (fallback && !isPlaceholderTitle(fallback)) return fallback.trim();
  return (preferred || fallback || defaultSessionTitle()).trim();
}

/** True when the session has no real conversation content yet. */
export function sessionIsEmpty(s: Session): boolean {
  if (s.isArchived) return false;
  if ((s.messageCount ?? 0) > 0) return false;
  for (const id of [s.id, s.workbenchSessionId].filter(Boolean) as string[]) {
    try {
      const raw = localStorage.getItem(`chat_messages_${id}`);
      if (!raw) continue;
      const msgs = JSON.parse(raw) as Array<{ role?: string }>;
      if (
        Array.isArray(msgs) &&
        msgs.some((m) => m?.role === 'user' || m?.role === 'assistant')
      ) {
        return false;
      }
    } catch {
      /* ignore corrupt storage */
    }
  }
  return true;
}

/**
 * Find an existing empty chat in the same folder/workspace so "New session"
 * does not stack blank chats when the user is already on one.
 */
export function findReusableEmptySession(opts: {
  folderId?: string | null;
  workspacePath?: string | null;
} = {}): Session | null {
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
    const rest = useSessionsStore
      .getState()
      .sessions.filter((s) => s.id !== existing.id);
    const bumped: Session = {
      ...existing,
      startedAt: new Date().toISOString(),
      title: isPlaceholderTitle(existing.title)
        ? title ?? defaultSessionTitle()
        : existing.title,
    };
    const updated = [bumped, ...rest];
    useSessionsStore.setState({ sessions: updated });
    saveSessionsToStorage(updated);
    return bumped;
  }
  return createSession(folderId, title, workspacePath);
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

/** Short sidebar title from the first user message (not a raw dump). */
export function deriveSessionTitleFromMessage(text: string): string | null {
  let cleaned = (text || '').replace(/\r\n/g, '\n').trim();
  if (!cleaned) return null;
  // Drop accidental role-prefixed transcript dumps saved as a single "user" blob.
  cleaned = cleaned.replace(/^(user|assistant|system)\s*:\s*/i, '');
  // Prefer the first meaningful line / sentence.
  const firstChunk = cleaned.split(/\n+/)[0] || cleaned;
  cleaned = firstChunk.replace(/\s+/g, ' ').trim();
  // If it still looks like a multi-turn transcript, take text before the next role marker.
  cleaned = cleaned.split(/\s+(?:user|assistant|system)\s*:\s*/i)[0]?.trim() || cleaned;
  if (cleaned.length < 2) return null;
  if (cleaned.length > 48) cleaned = `${cleaned.slice(0, 48).trim()}…`;
  return cleaned;
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

/** IDs removed optimistically / via tool event — reconcile must not re-add them. */
const _tombstonedSessionIds = new Map<string, number>();
const TOMBSTONE_TTL_MS = 120_000;

function _tombstone(id: string): void {
  if (!id) return;
  _tombstonedSessionIds.set(id, Date.now() + TOMBSTONE_TTL_MS);
}

function _isTombstoned(id: string | undefined | null): boolean {
  if (!id) return false;
  const exp = _tombstonedSessionIds.get(id);
  if (exp == null) return false;
  if (Date.now() > exp) {
    _tombstonedSessionIds.delete(id);
    return false;
  }
  return true;
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
    _tombstone(id);
    return false;
  }
  const dropIds = new Set(
    [id, sess?.id, sess?.workbenchSessionId].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    ),
  );
  for (const d of dropIds) _tombstone(d);

  const updated = sessions.filter(
    (s) => !dropIds.has(s.id) && !(s.workbenchSessionId && dropIds.has(s.workbenchSessionId)),
  );
  if (updated.length === sessions.length) {
    _tombstone(id);
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
    // Skip ids the user (or a tool) just deleted — cascade may still be mid-flight.
    const liveBackend = backendSessions.filter(
      (s) => !_isTombstoned(s.id),
    );
    const backendMap = new Map(liveBackend.map((s) => [s.id, s]));

    const current = useSessionsStore.getState().sessions;
    const merged: Session[] = [];
    const claimed = new Set<string>();
    const now = new Date().toISOString();

    for (const local of current) {
      if (_isTombstoned(local.id) || _isTombstoned(local.workbenchSessionId)) {
        continue;
      }
      const key = local.workbenchSessionId || local.id;
      const backend = backendMap.get(key) ?? backendMap.get(local.id);
      if (backend) {
        claimed.add(backend.id);
        // Single ID scheme: sidebar id is always the workbench SoT id.
        merged.push({
          ...local,
          id: backend.id,
          workbenchSessionId: backend.id,
          // Never clobber a real local title with a backend placeholder
          // ("Chat 2026-…", "New Session") — that was wiping auto-titles.
          title: preferSessionTitle(
            backend.title as string | undefined,
            local.title,
          ),
          startedAt: local.startedAt,
          messageCount: backend.messageCount ?? local.messageCount,
          provider: backend.provider || local.provider,
          model: (backend.model as string | undefined) || local.model,
          workbenchProvider: backend.provider || local.workbenchProvider,
        });
      }
      // Not in workbench SoT → dropped from sidebar (deleted server-side).
    }

    for (const bs of liveBackend) {
      if (claimed.has(bs.id) || _isTombstoned(bs.id)) continue;
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
