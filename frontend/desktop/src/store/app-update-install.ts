/* ── Shared app-update install progress (zustand) ───────────────────── */
/* useAppUpdate writes here so Update settings + Notifications panel see
 * the same downloading/installing animation. */

import { create } from 'zustand';

export type AppUpdatePhase = 'idle' | 'downloading' | 'installing' | 'restarting';

export interface AppUpdateProgress {
  /** 0–100 while downloading; null when size is unknown. */
  percent: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  phase: AppUpdatePhase;
}

export const IDLE_UPDATE_PROGRESS: AppUpdateProgress = {
  percent: null,
  downloadedBytes: 0,
  totalBytes: null,
  phase: 'idle',
};

interface AppUpdateInstallState {
  installing: boolean;
  progress: AppUpdateProgress;
  setInstalling: (v: boolean) => void;
  setProgress: (p: AppUpdateProgress) => void;
  reset: () => void;
}

export const useAppUpdateInstallStore = create<AppUpdateInstallState>((set) => ({
  installing: false,
  progress: IDLE_UPDATE_PROGRESS,
  setInstalling: (installing) => set({ installing }),
  setProgress: (progress) => set({ progress }),
  reset: () => set({ installing: false, progress: IDLE_UPDATE_PROGRESS }),
}));
