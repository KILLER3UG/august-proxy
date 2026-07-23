/* ── Right drawer state ─ shared open/section/diff state (Zustand) ─ */

import { create } from 'zustand';
import type { GitDiffResult } from '@/api/git';

export type RightDrawerSectionId =
  | 'preview'
  | 'diff'
  | 'terminal'
  | 'tasks'
  | 'plan'
  | 'browser'
  | 'notes';

export interface RightDrawerState {
  open: boolean;
  sections: RightDrawerSectionId[];
  activeSection?: RightDrawerSectionId;
  diff?: GitDiffResult;
  selectedDiffPath?: string;
}

const MAX_SECTIONS = 4;
const SECTION_ORDER: RightDrawerSectionId[] = [
  'preview',
  'diff',
  'terminal',
  'tasks',
  'plan',
  'browser',
  'notes',
];

const initialState: RightDrawerState = {
  open: false,
  sections: [],
};

export const useRightDrawerStore = create<RightDrawerState>(() => ({
  ...initialState,
}));

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
  return {
    open,
    sections,
    activeSection,
    diff,
    selectedDiffPath,
  };
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
  });
}

/**
 * Close the drawer AND reset all expanded sections. Reopening will start
 * fresh — no sections will be restored from the previous session.
 */
export function closeRightDrawer() {
  useRightDrawerStore.setState({
    open: false,
    sections: [],
    activeSection: undefined,
  });
}

/**
 * Apply a section list. Empty list closes the drawer entirely — never leave
 * an open shell with "No section selected".
 */
function setSectionsOrClose(
  nextSections: RightDrawerSectionId[],
  activeSection?: RightDrawerSectionId,
) {
  if (nextSections.length === 0) {
    closeRightDrawer();
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
    setSectionsOrClose(nextSections);
    return;
  }

  const nextSections = [...current.sections, section].slice(-MAX_SECTIONS);
  setSectionsOrClose(nextSections, section);
}

/** Close a single section. Last section closes the whole drawer. */
export function closeRightDrawerSection(section: RightDrawerSectionId) {
  const current = useRightDrawerStore.getState();
  if (!current.sections.includes(section)) return;
  const nextSections = current.sections.filter((item) => item !== section);
  const nextActive =
    current.activeSection === section
      ? nextSections[nextSections.length - 1]
      : current.activeSection;
  setSectionsOrClose(nextSections, nextActive);
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
 */
export function addRightDrawerSection(section: RightDrawerSectionId) {
  const current = useRightDrawerStore.getState();
  if (current.sections.includes(section)) {
    useRightDrawerStore.setState({
      ...current,
      activeSection: section,
      open: true,
    });
    return;
  }
  const nextSections = [...current.sections, section].slice(-MAX_SECTIONS);
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
