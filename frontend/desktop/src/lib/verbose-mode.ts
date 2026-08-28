/**
 * Per-session verbose mode (plan §4.2 item 4): `/verbose` toggles inline raw
 * tool output for the current session — the debug-depth escape hatch from
 * the minimal-output transcript. Rendering policy only: the data layer
 * always keeps the full output (drawer/trajectory are unaffected).
 */

import { useSyncExternalStore } from 'react';

const verboseSessions = new Set<string>();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function isVerboseMode(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId) && verboseSessions.has(sessionId as string);
}

export function setVerboseMode(sessionId: string | null | undefined, on: boolean): void {
  if (!sessionId) return;
  const had = verboseSessions.has(sessionId);
  if (on) verboseSessions.add(sessionId);
  else verboseSessions.delete(sessionId);
  if (had !== on) emitChange();
}

/** Flip the flag for a session; returns the new state. */
export function toggleVerboseMode(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const next = !verboseSessions.has(sessionId);
  setVerboseMode(sessionId, next);
  return next;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reactive read for components; re-renders when the session's flag flips. */
export function useVerboseMode(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => isVerboseMode(sessionId));
}

/** Test-only: wipe all flags. */
export function __resetVerboseModeForTests(): void {
  verboseSessions.clear();
  emitChange();
}
