import { atom } from 'nanostores';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  lastUsedAt: string;
}

const LOCAL_WORKSPACES_KEY = 'august-workspaces-v1';
const LOCAL_CURRENT_WORKSPACE_KEY = 'august-current-workspace';

const loadWorkspaces = (): Workspace[] => {
  const saved = localStorage.getItem(LOCAL_WORKSPACES_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch { /* silent */ }
  }
  return [];
};

const loadCurrentWorkspaceId = (): string | null => {
  return localStorage.getItem(LOCAL_CURRENT_WORKSPACE_KEY);
};

export const $workspaces = atom<Workspace[]>(loadWorkspaces());
export const $currentWorkspaceId = atom<string | null>(loadCurrentWorkspaceId());

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
  const existing = $workspaces.get().find(w => w.path === path);
  if (existing) {
    setCurrentWorkspace(existing.id);
    return existing;
  }

  const newWorkspace: Workspace = {
    id: 'ws_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5),
    name: workspaceNameFromPath(path),
    path,
    lastUsedAt: new Date().toISOString(),
  };

  const updated = [newWorkspace, ...$workspaces.get()];
  $workspaces.set(updated);
  saveWorkspacesToStorage(updated);
  setCurrentWorkspace(newWorkspace.id);
  return newWorkspace;
}

/**
 * Remove a workspace by id.
 */
export function removeWorkspace(id: string) {
  const updated = $workspaces.get().filter(w => w.id !== id);
  $workspaces.set(updated);
  saveWorkspacesToStorage(updated);

  if ($currentWorkspaceId.get() === id) {
    setCurrentWorkspace(updated.length > 0 ? updated[0].id : null);
  }
}

/**
 * Set the active workspace by id. Pass null to clear the selection.
 */
export function setCurrentWorkspace(id: string | null) {
  $currentWorkspaceId.set(id);
  saveCurrentWorkspaceToStorage(id);

  // Update lastUsedAt on the selected workspace
  if (id) {
    const now = new Date().toISOString();
    const updated = $workspaces.get().map(w =>
      w.id === id ? { ...w, lastUsedAt: now } : w
    );
    $workspaces.set(updated);
    saveWorkspacesToStorage(updated);
  }
}

/**
 * Get the current workspace object (or null).
 */
export function getCurrentWorkspace(): Workspace | null {
  const id = $currentWorkspaceId.get();
  if (!id) return null;
  return $workspaces.get().find(w => w.id === id) ?? null;
}
