/* ── useBackendSetup — live backend bootstrap phases (Tauri) ─────────── */
/* Polls `backend_setup_status` and listens for `backend-setup` events so
 * the overlay can animate first-launch install → start → ready. */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@/lib/tauri-detect';

export type BackendSetupPhaseId =
  | 'idle'
  | 'copying'
  | 'creating_venv'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'error';

export interface BackendSetupPhase {
  phase: BackendSetupPhaseId | string;
  detail: string | null;
}

const INITIAL: BackendSetupPhase = { phase: 'idle', detail: null };

export function useBackendSetup() {
  const [status, setStatus] = useState<BackendSetupPhase>(INITIAL);
  const tauri = isTauri;

  const refresh = useCallback(async () => {
    if (!tauri) return;
    try {
      const next = await invoke<BackendSetupPhase>('backend_setup_status');
      setStatus({
        phase: next.phase || 'idle',
        detail: next.detail ?? null,
      });
    } catch {
      /* command unavailable in older builds */
    }
  }, [tauri]);

  useEffect(() => {
    if (!tauri) return;
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 750);
    let unlisten: (() => void) | undefined;
    void listen<BackendSetupPhase>('backend-setup', (event) => {
      setStatus({
        phase: event.payload.phase || 'idle',
        detail: event.payload.detail ?? null,
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      window.clearInterval(interval);
      unlisten?.();
    };
  }, [tauri, refresh]);

  return { status, refresh, isTauri: tauri };
}

export const SETUP_STEPS: { id: BackendSetupPhaseId; label: string }[] = [
  { id: 'copying', label: 'Preparing files' },
  { id: 'creating_venv', label: 'Creating environment' },
  { id: 'installing', label: 'Installing dependencies' },
  { id: 'starting', label: 'Starting backend' },
  { id: 'ready', label: 'Ready' },
];

export function setupStepIndex(phase: string): number {
  if (phase === 'idle') return -1;
  if (phase === 'error') return -2;
  const idx = SETUP_STEPS.findIndex((s) => s.id === phase);
  return idx >= 0 ? idx : phase === 'ready' ? SETUP_STEPS.length - 1 : 0;
}
