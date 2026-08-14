/**
 * Composer intent beyond the default send path:
 *  - focused worker → steer
 *  - named workstream → continue that thread
 */

import { useSyncExternalStore } from 'react';

let continueName: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setContinueWorkstream(name: string | null) {
  const next = name?.trim() || null;
  if (continueName === next) return;
  continueName = next;
  emit();
}

export function getContinueWorkstream(): string | null {
  return continueName;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useContinueWorkstream(): string | null {
  return useSyncExternalStore(subscribe, getContinueWorkstream, () => null);
}
