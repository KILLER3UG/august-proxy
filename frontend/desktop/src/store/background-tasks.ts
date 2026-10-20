/* ── Background task tray store ───────────────────────────────────────── */
/* Tracks optional background jobs (queue overflow, long runs, subagents). */

import { create } from 'zustand';

export type BackgroundTaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface BackgroundTask {
  id: string;
  label: string;
  detail?: string;
  status: BackgroundTaskStatus;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
  progress?: number;
}

const STORAGE_KEY = 'august_background_tasks';

/** A persisted row is only a task if it still has the fields the tray reads.
 *  The guard is a type predicate rather than a cast, so a row from an older
 *  shape cannot reach the renderer as `any`. */
function isBackgroundTask(value: unknown): value is BackgroundTask {
  if (!value || typeof value !== 'object') return false;
  const t = value as Partial<BackgroundTask>;
  return (
    typeof t.id === 'string' &&
    typeof t.label === 'string' &&
    typeof t.status === 'string' &&
    typeof t.createdAt === 'number' &&
    typeof t.updatedAt === 'number'
  );
}

/** A job that was still queued or running when the app closed CANNOT still be
 *  running: the process that was running it is gone. Restoring it as
 *  "running" would be a lie the tray then shows, so it comes back CANCELLED
 *  with the reason on its face. */
function load(): BackgroundTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isBackgroundTask)
      .map((t) =>
        t.status === 'queued' || t.status === 'running'
          ? {
              ...t,
              status: 'cancelled' as const,
              detail: 'Interrupted — August was closed while this was running',
            }
          : t,
      );
  } catch {
    return [];
  }
}

function persist(tasks: BackgroundTask[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.slice(0, 40)));
  } catch {
    /* storage full / unavailable */
  }
}

interface BackgroundTaskState {
  tasks: BackgroundTask[];
  trayOpen: boolean;
  upsert: (task: Omit<BackgroundTask, 'createdAt' | 'updatedAt'> & { createdAt?: number }) => void;
  update: (id: string, patch: Partial<BackgroundTask>) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
  setTrayOpen: (open: boolean) => void;
  activeCount: () => number;
}

function now() {
  return Date.now();
}

export const useBackgroundTasksStore = create<BackgroundTaskState>((set, get) => ({
  /* PERSISTED, so the tray survives a reload. The list used to live only in
   * memory, which made "the jobs are in the right drawer" true and useless:
   * a restart emptied it, so a sandbox prep that finished while the app was
   * closed was gone with nothing to say so. The shape is the one
   * `sections/chat/offline-queue-store.ts` uses — read at creation, written on
   * every mutation — rather than zustand's `persist` middleware, because this
   * repo has three stores that persist and all three do it by hand. */
  tasks: load(),
  trayOpen: false,

  upsert: (task) => {
    const tasks = get().tasks;
    const idx = tasks.findIndex((t) => t.id === task.id);
    const ts = now();
    const next =
      idx >= 0
        ? tasks.map((t, i) => (i === idx ? { ...t, ...task, updatedAt: ts } : t))
        : [{ createdAt: task.createdAt ?? ts, updatedAt: ts, ...task }, ...tasks].slice(0, 40);
    set({ tasks: next });
    persist(next);
  },

  update: (id, patch) => {
    const next = get().tasks.map((t) =>
      t.id === id ? { ...t, ...patch, updatedAt: now() } : t,
    );
    set({ tasks: next });
    persist(next);
  },

  remove: (id) => {
    const next = get().tasks.filter((t) => t.id !== id);
    set({ tasks: next });
    persist(next);
  },

  clearFinished: () => {
    const next = get().tasks.filter((t) => t.status === 'queued' || t.status === 'running');
    set({ tasks: next });
    persist(next);
  },

  setTrayOpen: (open) => set({ trayOpen: open }),

  activeCount: () =>
    get().tasks.filter((t) => t.status === 'queued' || t.status === 'running').length,
}));

/** Imperative registry for stream handlers and other non-React callers. */
export class BackgroundTaskRegistry {
  static enqueue(partial: {
    id: string;
    label: string;
    detail?: string;
    sessionId?: string;
    status?: BackgroundTaskStatus;
  }): void {
    useBackgroundTasksStore.getState().upsert({
      id: partial.id,
      label: partial.label,
      detail: partial.detail,
      sessionId: partial.sessionId,
      status: partial.status ?? 'queued',
    });
  }

  static markRunning(id: string, detail?: string): void {
    useBackgroundTasksStore.getState().update(id, {
      status: 'running',
      ...(detail ? { detail } : {}),
    });
  }

  static markDone(id: string, detail?: string): void {
    useBackgroundTasksStore.getState().update(id, {
      status: 'done',
      ...(detail ? { detail } : {}),
    });
  }

  static markError(id: string, detail?: string): void {
    useBackgroundTasksStore.getState().update(id, {
      status: 'error',
      ...(detail ? { detail } : {}),
    });
  }
}
