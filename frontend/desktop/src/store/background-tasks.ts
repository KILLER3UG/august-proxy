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
  tasks: [],
  trayOpen: false,

  upsert: (task) => {
    set((s) => {
      const idx = s.tasks.findIndex((t) => t.id === task.id);
      const ts = now();
      if (idx >= 0) {
        const next = [...s.tasks];
        next[idx] = { ...next[idx], ...task, updatedAt: ts };
        return { tasks: next };
      }
      return {
        tasks: [
          {
            createdAt: task.createdAt ?? ts,
            updatedAt: ts,
            ...task,
          },
          ...s.tasks,
        ].slice(0, 40),
      };
    });
  },

  update: (id, patch) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id ? { ...t, ...patch, updatedAt: now() } : t,
      ),
    }));
  },

  remove: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),

  clearFinished: () =>
    set((s) => ({
      tasks: s.tasks.filter((t) => t.status === 'queued' || t.status === 'running'),
    })),

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
