/**
 * Live per-section context sizes per session.
 *
 * The backend measures the volatile tail blocks it injects each turn (memory
 * recall, relevant skills, session state, habit nudge) and reports their byte
 * sizes on the `contextPressure` event. Before that producer existed, the
 * composer's context readout had no source for the skills/memory row and
 * would have displayed a confident `0` for something that had never been
 * measured.
 *
 * It is READ by exactly one surface: `sections/chat/composer/
 * ContextUsageReadout.tsx`, the detail panel behind the composer's context
 * percentage. That panel shows the MEASURED byte sizes — the row is a
 * measurement, not an estimate.
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
  /** Per-skill share of the Relevant skills section, by skill name. Answers
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

/** The measured section sizes for one session, or null when the backend has
 *  not reported this session yet — null keeps "unknown" distinct from a
 *  measured zero. */
export function selectContextSections(
  state: ContextSectionsState,
  sessionId: string | null | undefined,
): ContextSections | null {
  if (!sessionId) return null;
  return state.bySession[sessionId] ?? null;
}
