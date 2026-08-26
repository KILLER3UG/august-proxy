/* ── Right drawer state ─ shared open/section/diff state (Zustand) ─ */

import { create } from 'zustand';
import type { GitDiffResult } from '@/api/git';
import type { FileAttachment } from '@/types/chat';

export type RightDrawerSectionId =
  | 'preview'
  | 'diff'
  | 'terminal'
  | 'tasks'
  | 'plan'
  | 'browser'
  | 'notes'
  | 'subagents'
  | 'trajectory'
  | 'artifacts'
  | 'circuit'
  | 'file';

export interface RightDrawerState {
  open: boolean;
  sections: RightDrawerSectionId[];
  activeSection?: RightDrawerSectionId;
  diff?: GitDiffResult;
  selectedDiffPath?: string;
  file?: FileAttachment;
  /** ZCode-style "Open tab" card-grid chooser replaces the body while set. */
  chooserActive?: boolean;
  /** JetBrains-style terminal docked at the BOTTOM of the main column
   *  instead of living as a right-panel tab. */
  bottomTerminal?: boolean;
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
  'subagents',
  'trajectory',
  'artifacts',
  'circuit',
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
  const file = useRightDrawerStore((s) => s.file);
  const chooserActive = useRightDrawerStore((s) => s.chooserActive);
  const bottomTerminal = useRightDrawerStore((s) => s.bottomTerminal);
  return {
    open,
    sections,
    activeSection,
    diff,
    selectedDiffPath,
    file,
    chooserActive,
    bottomTerminal,
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

export function openRightDrawer(section?: Exclude<RightDrawerSectionId, 'file'>, options: Partial<Pick<RightDrawerState, 'diff' | 'selectedDiffPath'>> = {}) {
  const current = useRightDrawerStore.getState();
  const target = (
    section ?? (current.activeSection === 'file' ? undefined : current.activeSection) ?? SECTION_ORDER[0]
  ) as Exclude<RightDrawerSectionId, 'file'>;
  const baseSections = current.sections.filter(
    (item): item is Exclude<RightDrawerSectionId, 'file'> => item !== 'file',
  );
  const nextSections = baseSections.includes(target)
    ? baseSections
    : [...baseSections, target].slice(-MAX_SECTIONS);

  useRightDrawerStore.setState({
    ...current,
    ...options,
    open: true,
    activeSection: target,
    sections: nextSections,
    file: undefined,
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
    file: undefined,
    chooserActive: false,
    bottomTerminal: false,
  });
}

/** Open an attachment in the full-height file viewer. */
export function openRightDrawerFile(file: FileAttachment) {
  useRightDrawerStore.setState({
    ...useRightDrawerStore.getState(),
    open: true,
    sections: ['file'],
    activeSection: 'file',
    file,
    chooserActive: false,
  });
}

/** Open the drawer straight into the ZCode-style "Open tab" chooser. */
export function openRightDrawerChooser() {
  useRightDrawerStore.setState({
    ...useRightDrawerStore.getState(),
    open: true,
    chooserActive: true,
  });
}

/** Show/hide the chooser without touching open sections. */
export function setRightDrawerChooser(active: boolean) {
  useRightDrawerStore.setState({
    ...useRightDrawerStore.getState(),
    chooserActive: active,
  });
}

/** Toggle the bottom-docked terminal strip. */
export function toggleBottomTerminal(open?: boolean) {
  const current = useRightDrawerStore.getState();
  useRightDrawerStore.setState({
    ...current,
    bottomTerminal: open ?? !current.bottomTerminal,
  });
}

/** Whether the layout shell should render the drawer panel. Chooser-only
 *  state (zero tabs + chooserActive) counts as visible — otherwise the
 *  ZCode "Open tab" view could never appear on screen. */
export function isDrawerPanelVisible(
  open: boolean,
  sectionCount: number,
  chooserActive?: boolean,
): boolean {
  return open && (sectionCount > 0 || !!chooserActive);
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
    chooserActive: false,
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
  // A file preview occupies the drawer as a focused document view. Opening a
  // Workbench section from the titlebar should replace it cleanly.
  const baseSections = current.sections.filter((item) => item !== 'file');
  if (current.sections.includes(section)) {
    useRightDrawerStore.setState({
      ...current,
      activeSection: section,
      open: true,
    });
    return;
  }
  const nextSections = [...baseSections, section].slice(-MAX_SECTIONS);
  useRightDrawerStore.setState({
    ...current,
    file: undefined,
  });
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
