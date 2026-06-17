/* ── Right drawer state ─ shared open/section/diff state ─────────── */

import { atom } from 'nanostores';
import { useStore } from '@nanostores/react';
import type { GitDiffResult } from '@/api/git';

export type RightDrawerSectionId = 'preview' | 'diff' | 'terminal' | 'tasks' | 'plan';

export interface RightDrawerState {
  open: boolean;
  sections: RightDrawerSectionId[];
  activeSection?: RightDrawerSectionId;
  diff?: GitDiffResult;
  selectedDiffPath?: string;
}

const MAX_SECTIONS = 4;
const SECTION_ORDER: RightDrawerSectionId[] = ['preview', 'diff', 'terminal', 'tasks', 'plan'];

export const $rightDrawer = atom<RightDrawerState>({
  open: false,
  sections: [],
});

export function useRightDrawer() {
  return useStore($rightDrawer);
}

export function openRightDrawer(section?: RightDrawerSectionId, options: Partial<Pick<RightDrawerState, 'diff' | 'selectedDiffPath'>> = {}) {
  const current = $rightDrawer.get();
  const nextSections = [...new Set([...current.sections, section].filter(Boolean))] as RightDrawerSectionId[];

  $rightDrawer.set({
    ...current,
    ...options,
    open: true,
    activeSection: section || current.activeSection || nextSections[0] || SECTION_ORDER[0],
    sections: nextSections.slice(-MAX_SECTIONS),
  });
}

export function closeRightDrawer() {
  const current = $rightDrawer.get();
  $rightDrawer.set({ ...current, open: false });
}

export function toggleRightDrawerSection(section: RightDrawerSectionId) {
  const current = $rightDrawer.get();
  const hasSection = current.sections.includes(section);
  const nextSections = hasSection
    ? current.sections.filter((item) => item !== section)
    : [...current.sections, section].slice(-MAX_SECTIONS);

  $rightDrawer.set({
    ...current,
    sections: nextSections,
    open: nextSections.length > 0 ? true : current.open,
    activeSection: hasSection
      ? (current.activeSection === section ? nextSections[nextSections.length - 1] : current.activeSection)
      : section,
  });
}

export function closeRightDrawerSection(section: RightDrawerSectionId) {
  const current = $rightDrawer.get();
  const nextSections = current.sections.filter((item) => item !== section);

  $rightDrawer.set({
    ...current,
    sections: nextSections,
    activeSection: current.activeSection === section ? nextSections[nextSections.length - 1] : current.activeSection,
  });
}

export function setActiveRightDrawerSection(section: RightDrawerSectionId) {
  const current = $rightDrawer.get();
  $rightDrawer.set({
    ...current,
    activeSection: section,
    open: true,
  });
}

export function setRightDrawerSections(sections: RightDrawerSectionId[], activeSection: RightDrawerSectionId = sections[0]) {
  $rightDrawer.set({
    open: true,
    sections,
    activeSection,
  });
}

export function setRightDrawerDiff(diff?: GitDiffResult, selectedDiffPath?: string) {
  const current = $rightDrawer.get();
  $rightDrawer.set({
    ...current,
    diff,
    selectedDiffPath,
  });
}

export function clearRightDrawerDiff() {
  const current = $rightDrawer.get();
  $rightDrawer.set({
    ...current,
    diff: undefined,
    selectedDiffPath: undefined,
  });
}
