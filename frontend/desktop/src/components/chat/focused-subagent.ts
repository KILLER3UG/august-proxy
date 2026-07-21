/**
 * Focused subagent — when an expanded subagent card is open, the main
 * composer shows "Send follow-up with subagent" instead of the default
 * placeholder (Cursor parity).
 */

import { useSyncExternalStore } from 'react';

export interface FocusedSubagent {
  jobId: string;
  title: string;
}

let focused: FocusedSubagent | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setFocusedSubagent(next: FocusedSubagent | null) {
  const same =
    (focused == null && next == null) ||
    (focused != null &&
      next != null &&
      focused.jobId === next.jobId &&
      focused.title === next.title);
  if (same) return;
  focused = next;
  emit();
}

export function getFocusedSubagent(): FocusedSubagent | null {
  return focused;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFocusedSubagent(): FocusedSubagent | null {
  return useSyncExternalStore(subscribe, getFocusedSubagent, () => null);
}
