/* ── Right drawer state ─ shared open/section/diff state (Zustand) ─ */

import { create } from 'zustand';
import type { GitDiffResult } from '@/api/git';

export type RightDrawerSectionId =
  | 'activity'
  | 'preview'
  | 'diff'
  | 'terminal'
  | 'tasks'
  | 'plan'
  | 'browser';

export interface RightDrawerState {
  open: boolean;
  sections: RightDrawerSectionId[];
  activeSection?: RightDrawerSectionId;
  diff?: GitDiffResult;
  selectedDiffPath?: string;
  /**
   * When true, live-stream auto-open will not re-add the Activity section
   * after the user closed it (or the whole drawer) during the turn.
   */
  activityAutoOpenSuppressed: boolean;
}

const MAX_SECTIONS = 4;
const SECTION_ORDER: RightDrawerSectionId[] = [
  'activity',
  'preview',
  'diff',
  'terminal',
  'tasks',
  'plan',
  'browser',
];

const initialState: RightDrawerState = {
  open: false,
  sections: [],
  activityAutoOpenSuppressed: false,
};

export const useRightDrawerStore = create<RightDrawerState>(() => ({
  ...initialState,
}));

export type AddRightDrawerSectionOptions = {
  /** Auto-open from live stream — respects user dismiss for this turn. */
  fromAuto?: boolean;
};

export type CloseRightDrawerSectionOptions = {
  /** System close (e.g. stream ended) — does not suppress future auto-open. */
  fromAuto?: boolean;
};

/** Nanostores-shaped shim for imperative get/set callers. */
export const $rightDrawer = {
  get: (): RightDrawerState => useRightDrawerStore.getState(),
  set: (state: RightDrawerState): void => {
    useRightDrawerStore.setState(state, true);
  },
  subscribe: (listener: (state: RightDrawerState) => void): (() => void) => {
    listener(useRightDrawerStore.getState());
    return useRightDrawerStore.subscribe((s) => listener(s));
  },
};

/**
 * Subscribe with a selector so components re-render only for the fields they need.
 * Prefer field hooks below for hot paths (open / activeSection).
 */
export function useRightDrawer(): RightDrawerState {
  const open = useRightDrawerStore((s) => s.open);
  const sections = useRightDrawerStore((s) => s.sections);
  const activeSection = useRightDrawerStore((s) => s.activeSection);
  const diff = useRightDrawerStore((s) => s.diff);
  const selectedDiffPath = useRightDrawerStore((s) => s.selectedDiffPath);
  return { open, sections, activeSection, diff, selectedDiffPath };
}

export function useRightDrawerOpen(): boolean {
  return useRightDrawerStore((s) => s.open);
}

export function useRightDrawerActiveSection(): RightDrawerSectionId | undefined {
  return useRightDrawerStore((s) => s.activeSection);
}

export function useRightDrawerSections(): RightDrawerSectionId[] {
  return useRightDrawerStore((s) => s.sections);
}

export function openRightDrawer(section?: RightDrawerSectionId, options: Partial<Pick<RightDrawerState, 'diff' | 'selectedDiffPath'>> = {}) {
  const current = useRightDrawerStore.getState();
  const target = section ?? current.activeSection ?? SECTION_ORDER[0];
  const nextSections = current.sections.includes(target)
    ? current.sections
    : [...current.sections, target].slice(-MAX_SECTIONS);

  useRightDrawerStore.setState({
    ...current,
    ...options,
    open: true,
    activeSection: target,
    sections: nextSections,
    // Manual open of Activity clears dismiss for this turn.
    activityAutoOpenSuppressed:
      target === 'activity' ? false : current.activityAutoOpenSuppressed,
  });
}

/**
 * Close the drawer AND reset all expanded sections. Reopening will start
 * fresh — no sections will be restored from the previous session.
 * If Activity was open, suppress live auto-reopen for the rest of the turn.
 */
export function closeRightDrawer(options: CloseRightDrawerSectionOptions = {}) {
  const current = useRightDrawerStore.getState();
  const suppressActivity =
    !options.fromAuto && current.sections.includes('activity');
  useRightDrawerStore.setState({
    open: false,
    sections: [],
    activeSection: undefined,
    activityAutoOpenSuppressed:
      suppressActivity || current.activityAutoOpenSuppressed,
  });
}

/** Allow the next live turn to auto-open Activity again. */
export function clearActivityAutoOpenSuppression() {
  const current = useRightDrawerStore.getState();
  if (!current.activityAutoOpenSuppressed) return;
  useRightDrawerStore.setState({
    ...current,
    activityAutoOpenSuppressed: false,
  });
}

/**
 * Apply a section list. Empty list closes the drawer entirely — never leave
 * an open shell with "No section selected".
 */
function setSectionsOrClose(
  nextSections: RightDrawerSectionId[],
  activeSection?: RightDrawerSectionId,
  closeOptions: CloseRightDrawerSectionOptions = {},
) {
  if (nextSections.length === 0) {
    closeRightDrawer(closeOptions);
    return;
  }
  const current = useRightDrawerStore.getState();
  useRightDrawerStore.setState({
    ...current,
    open: true,
    sections: nextSections,
    activeSection: activeSection ?? nextSections[nextSections.length - 1],
  });
}

export function toggleRightDrawerSection(section: RightDrawerSectionId) {
  const current = useRightDrawerStore.getState();
  const hasSection = current.sections.includes(section);

  if (hasSection) {
    const nextSections = current.sections.filter((item) => item !== section);
    setSectionsOrClose(
      nextSections,
      undefined,
      section === 'activity' ? {} : { fromAuto: true },
    );
    // User toggled Activity off — suppress live re-open for this turn.
    if (section === 'activity') {
      const latest = useRightDrawerStore.getState();
      useRightDrawerStore.setState({
        ...latest,
        activityAutoOpenSuppressed: true,
      });
    }
    return;
  }

  if (section === 'activity') {
    useRightDrawerStore.setState({
      ...current,
      activityAutoOpenSuppressed: false,
    });
  }
  const nextSections = [...current.sections, section].slice(-MAX_SECTIONS);
  setSectionsOrClose(nextSections, section);
}

/** Close a single section. Last section closes the whole drawer. */
export function closeRightDrawerSection(
  section: RightDrawerSectionId,
  options: CloseRightDrawerSectionOptions = {},
) {
  const current = useRightDrawerStore.getState();
  if (!current.sections.includes(section)) return;
  const nextSections = current.sections.filter((item) => item !== section);
  const nextActive =
    current.activeSection === section
      ? nextSections[nextSections.length - 1]
      : current.activeSection;
  if (section === 'activity' && !options.fromAuto) {
    useRightDrawerStore.setState({
      ...current,
      activityAutoOpenSuppressed: true,
    });
  }
  // When emptying via system close of Activity, don't mark user-dismissed.
  const closeOpts =
    nextSections.length === 0 && options.fromAuto ? { fromAuto: true } : {};
  setSectionsOrClose(nextSections, nextActive, closeOpts);
}

export function setActiveRightDrawerSection(section: RightDrawerSectionId) {
  const current = useRightDrawerStore.getState();
  useRightDrawerStore.setState({
    ...current,
    activeSection: section,
    open: true,
  });
}

export function setRightDrawerSections(sections: RightDrawerSectionId[], activeSection: RightDrawerSectionId = sections[0]) {
  setSectionsOrClose([...new Set([activeSection, ...sections])].slice(-MAX_SECTIONS), activeSection);
}

/**
 * Add a section to the drawer. No-op if the section is already open.
 * Capped at MAX_SECTIONS — when full, the oldest section is dropped.
 * Opens the drawer and sets the new section as active.
 *
 * Pass `{ fromAuto: true }` for live-stream Activity opens — skipped when
 * the user dismissed Activity during the current turn.
 */
export function addRightDrawerSection(
  section: RightDrawerSectionId,
  options: AddRightDrawerSectionOptions = {},
) {
  const current = useRightDrawerStore.getState();
  if (
    section === 'activity' &&
    options.fromAuto &&
    current.activityAutoOpenSuppressed
  ) {
    return;
  }
  if (section === 'activity' && !options.fromAuto) {
    useRightDrawerStore.setState({
      ...current,
      activityAutoOpenSuppressed: false,
    });
  }
  const latest = useRightDrawerStore.getState();
  if (latest.sections.includes(section)) {
    // Auto updates must not yank focus / re-force open if the user already
    // has Activity open among other sections — only ensure it stays listed.
    if (options.fromAuto) {
      if (!latest.open) {
        // Drawer was closed without clearing suppress (shouldn't happen); bail.
        return;
      }
      return;
    }
    useRightDrawerStore.setState({
      ...latest,
      activeSection: section,
      open: true,
    });
    return;
  }
  const nextSections = [...latest.sections, section].slice(-MAX_SECTIONS);
  setSectionsOrClose(nextSections, section);
}

export function setRightDrawerDiff(diff?: GitDiffResult, selectedDiffPath?: string) {
  const current = useRightDrawerStore.getState();
  useRightDrawerStore.setState({
    ...current,
    diff,
    selectedDiffPath,
  });
}

export function clearRightDrawerDiff() {
  const current = useRightDrawerStore.getState();
  useRightDrawerStore.setState({
    ...current,
    diff: undefined,
    selectedDiffPath: undefined,
  });
}
