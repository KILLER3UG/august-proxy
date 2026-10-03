/* ── Shared app-update install progress (zustand) ───────────────────── */
/* One machine for every update surface (About, notifications, the relaunch
 * overlay). The old union carried an `installing` phase that NOTHING wrote
 * — it was read at ten sites and the `restarting` pill fell through to the
 * label "installing". Under Windows the NSIS wizard is an external process,
 * so install progress is genuinely unknowable from JS; the UI says so
 * instead of faking a percentage. */

import { create } from 'zustand';

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'restarting'
  | 'failed'
  | 'cancelled';

/** A rejected signature is materially different from a network failure:
 *  one means "this build is not trustworthy — get it manually", the other
 *  "try again later". */
export type AppUpdateFailureKind = 'network' | 'signature' | 'unknown';

export interface AppUpdateProgress {
  /** 0–100 while downloading; null when size is unknown. */
  percent: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  phase: AppUpdatePhase;
  /** Set only in the `failed` phase. */
  error?: string;
  failureKind?: AppUpdateFailureKind;
}

export const IDLE_UPDATE_PROGRESS: AppUpdateProgress = {
  percent: null,
  downloadedBytes: 0,
  totalBytes: null,
  phase: 'idle',
};

/** Classify an install/download failure from its message. */
export function classifyUpdateFailure(message: string): AppUpdateFailureKind {
  const m = message.toLowerCase();
  if (m.includes('signature') || m.includes('minisign') || m.includes('not signed')) {
    return 'signature';
  }
  if (
    m.includes('network') ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('econn') ||
    m.includes('dns') ||
    m.includes('fetch') ||
    m.includes('http') ||
    m.includes('503') ||
    m.includes('502')
  ) {
    return 'network';
  }
  return 'unknown';
}

export const UPDATE_FAILURE_COPY: Record<AppUpdateFailureKind, string> = {
  network: 'Could not reach the update server. Check your connection and try again.',
  signature:
    'This installer was rejected: its signature did not verify. It was NOT installed — download the latest release manually.',
  unknown: 'The update failed.',
};

interface AppUpdateInstallState {
  installing: boolean;
  progress: AppUpdateProgress;
  setInstalling: (v: boolean) => void;
  setProgress: (p: AppUpdateProgress) => void;
  /** Terminal failure — surfaces render this instead of a toast that vanishes. */
  fail: (message: string) => void;
  /** User aborted the download: distinct from failure. */
  markCancelled: () => void;
  reset: () => void;
}

export const useAppUpdateInstallStore = create<AppUpdateInstallState>((set, get) => ({
  installing: false,
  progress: IDLE_UPDATE_PROGRESS,
  setInstalling: (installing) => set({ installing }),
  setProgress: (progress) => set({ progress }),
  fail: (message) => {
    const kind = classifyUpdateFailure(message);
    set({
      installing: false,
      progress: {
        percent: null,
        downloadedBytes: get().progress.downloadedBytes,
        totalBytes: get().progress.totalBytes,
        phase: 'failed',
        error: message,
        failureKind: kind,
      },
    });
  },
  markCancelled: () =>
    set({
      installing: false,
      progress: {
        percent: null,
        downloadedBytes: 0,
        totalBytes: null,
        phase: 'cancelled',
      },
    }),
  reset: () => set({ installing: false, progress: IDLE_UPDATE_PROGRESS }),
}));