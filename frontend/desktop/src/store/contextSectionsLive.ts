/**
 * Live per-section context sizes per session.
 *
 * The backend measures the volatile tail blocks it injects each turn (memory
 * recall, relevant skills, session state, habit nudge) and reports their byte
 * sizes on the `contextPressure` event. Before that, the composer's context
 * breakdown had no producer for the skills/memory row and displayed a
 * confident `0` for something that had never been measured.
 *
 * This is deliberately NOT folded into `promptCacheLive.ts`: that store's
 * setter drops the update when a turn has no cache tokens, which is most
 * non-Anthropic turns, so section sizes riding along would be discarded on
 * exactly the turns where the meter still needs them.
 */

import { create } from 'zustand';

export interface ContextSections {
  memoryBytes: number;
  skillsBytes: number;
  stateBytes: number;
  nudgeBytes: number;
  /** Per-skill share of the `<relevant_skills>` block, by skill name. Answers
   *  "which skill is costing me context", which the total alone cannot. */
  skillsByName: Record<string, number>;
}

interface ContextSectionsState {
  bySession: Record<string, ContextSections>;
}

export const useContextSectionsStore = create<ContextSectionsState>(() => ({
  bySession: {},
}));

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toSizes(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const bytes = toCount(raw);
    if (name && bytes > 0) out[name] = bytes;
  }
  return out;
}

export function setContextSectionsLive(
  sessionId: string,
  sections: Partial<ContextSections> | null | undefined,
): void {
  if (!sessionId || !sections || typeof sections !== 'object') return;
  const next: ContextSections = {
    memoryBytes: toCount(sections.memoryBytes),
    skillsBytes: toCount(sections.skillsBytes),
    stateBytes: toCount(sections.stateBytes),
    nudgeBytes: toCount(sections.nudgeBytes),
    skillsByName: toSizes(sections.skillsByName),
  };
  useContextSectionsStore.setState((prev) => ({
    bySession: { ...prev.bySession, [sessionId]: next },
  }));
}

export function clearContextSectionsLive(sessionId?: string | null): void {
  if (!sessionId) {
    useContextSectionsStore.setState({ bySession: {} });
    return;
  }
  useContextSectionsStore.setState((prev) => {
    if (!(sessionId in prev.bySession)) return prev;
    const next = { ...prev.bySession };
    delete next[sessionId];
    return { bySession: next };
  });
}

/** Bytes of skills + memory injected into the current turn, or null if the
 *  backend has not reported this turn yet — null keeps "unknown" distinct
 *  from a measured zero. */
export function selectSkillsMemoryBytes(
  state: ContextSectionsState,
  sessionId: string | null | undefined,
): number | null {
  if (!sessionId) return null;
  const entry = state.bySession[sessionId];
  if (!entry) return null;
  return entry.skillsBytes + entry.memoryBytes;
}

/** Stable empty object: a selector that returned a fresh `{}` every call would
 *  re-render its subscribers on unrelated store writes. */
const NO_SKILLS: Record<string, number> = {};

/** Bytes each skill contributed to this turn's `<relevant_skills>` block. */
export function selectSkillsByName(
  state: ContextSectionsState,
  sessionId: string | null | undefined,
): Record<string, number> {
  if (!sessionId) return NO_SKILLS;
  return state.bySession[sessionId]?.skillsByName ?? NO_SKILLS;
}
