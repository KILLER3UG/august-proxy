import { create } from 'zustand';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  lastUsedAt: string;
}

const LOCAL_WORKSPACES_KEY = 'august-workspaces-v1';
const LOCAL_CURRENT_WORKSPACE_KEY = 'august-current-workspace';

const loadWorkspaces = (): Workspace[] => {
  if (typeof localStorage === 'undefined') return [];
  const saved = localStorage.getItem(LOCAL_WORKSPACES_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch { /* silent */ }
  }
  return [];
};

const loadCurrentWorkspaceId = (): string | null => {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(LOCAL_CURRENT_WORKSPACE_KEY);
};

interface WorkspacesState {
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
}

export const useWorkspacesStore = create<WorkspacesState>(() => ({
  workspaces: loadWorkspaces(),
  currentWorkspaceId: loadCurrentWorkspaceId(),
}));

/** Nanostores-shaped shims for imperative get/set callers and tests. */
export const $workspaces = {
  get: (): Workspace[] => useWorkspacesStore.getState().workspaces,
  set: (workspaces: Workspace[]): void => {
    useWorkspacesStore.setState({ workspaces });
  },
  subscribe: (listener: (workspaces: Workspace[]) => void): (() => void) => {
    listener(useWorkspacesStore.getState().workspaces);
    return useWorkspacesStore.subscribe((s) => listener(s.workspaces));
  },
};

export const $currentWorkspaceId = {
  get: (): string | null => useWorkspacesStore.getState().currentWorkspaceId,
  set: (currentWorkspaceId: string | null): void => {
    useWorkspacesStore.setState({ currentWorkspaceId });
  },
  subscribe: (listener: (id: string | null) => void): (() => void) => {
    listener(useWorkspacesStore.getState().currentWorkspaceId);
    return useWorkspacesStore.subscribe((s) => listener(s.currentWorkspaceId));
  },
};

const saveWorkspacesToStorage = (workspaces: Workspace[]) => {
  localStorage.setItem(LOCAL_WORKSPACES_KEY, JSON.stringify(workspaces));
};

const saveCurrentWorkspaceToStorage = (id: string | null) => {
  if (id) {
    localStorage.setItem(LOCAL_CURRENT_WORKSPACE_KEY, id);
  } else {
    localStorage.removeItem(LOCAL_CURRENT_WORKSPACE_KEY);
  }
};

/**
 * Extract a human-readable name from a file path.
 * Uses the last directory segment (e.g., "/Users/foo/bar" → "bar").
 */
function workspaceNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : path;
}

/**
 * Add a workspace from a filesystem path.
 * If a workspace with the same path already exists, it is updated and selected.
 */
export function addWorkspace(path: string): Workspace {
  // Match session-store path normalization so sidebar folders group correctly.
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const existing = useWorkspacesStore
    .getState()
    .workspaces.find((w) => w.path.replace(/\\/g, '/').replace(/\/+$/, '') === normalized);
  if (existing) {
    setCurrentWorkspace(existing.id);
    return existing;
  }

  const newWorkspace: Workspace = {
    id: 'ws_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5),
    name: workspaceNameFromPath(normalized),
    path: normalized,
    lastUsedAt: new Date().toISOString(),
  };

  const updated = [newWorkspace, ...useWorkspacesStore.getState().workspaces];
  useWorkspacesStore.setState({ workspaces: updated });
  saveWorkspacesToStorage(updated);
  setCurrentWorkspace(newWorkspace.id);
  return newWorkspace;
}

/**
 * Remove a workspace by id.
 */
export function removeWorkspace(id: string) {
  const updated = useWorkspacesStore.getState().workspaces.filter(w => w.id !== id);
  useWorkspacesStore.setState({ workspaces: updated });
  saveWorkspacesToStorage(updated);

  if (useWorkspacesStore.getState().currentWorkspaceId === id) {
    setCurrentWorkspace(updated.length > 0 ? updated[0].id : null);
  }
}

/**
 * Set the active workspace by id. Pass null to clear the selection.
 */
export function setCurrentWorkspace(id: string | null) {
  useWorkspacesStore.setState({ currentWorkspaceId: id });
  saveCurrentWorkspaceToStorage(id);

  // Update lastUsedAt on the selected workspace
  if (id) {
    const now = new Date().toISOString();
    const updated = useWorkspacesStore.getState().workspaces.map(w =>
      w.id === id ? { ...w, lastUsedAt: now } : w
    );
    useWorkspacesStore.setState({ workspaces: updated });
    saveWorkspacesToStorage(updated);
  }
}

/**
 * Get the current workspace object (or null).
 */
export function getCurrentWorkspace(): Workspace | null {
  const { currentWorkspaceId, workspaces } = useWorkspacesStore.getState();
  if (!currentWorkspaceId) return null;
  return workspaces.find(w => w.id === currentWorkspaceId) ?? null;
}
