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
  const target = section ?? current.activeSection ?? SECTION_ORDER[0];
  const nextSections = current.sections.includes(target)
    ? current.sections
    : [...current.sections, target].slice(-MAX_SECTIONS);

  $rightDrawer.set({
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
  $rightDrawer.set({
    open: false,
    sections: [],
    activeSection: undefined,
  });
}

export function toggleRightDrawerSection(section: RightDrawerSectionId) {
  const current = $rightDrawer.get();
  const hasSection = current.sections.includes(section);

  if (hasSection) {
    // Closing a section — if it was the last one, the drawer stays open
    // so the "No section selected" placeholder can render.
    const nextSections = current.sections.filter((item) => item !== section);
    $rightDrawer.set({
      ...current,
      sections: nextSections,
      activeSection: nextSections.length > 0 ? nextSections[nextSections.length - 1] : undefined,
    });
    return;
  }

  // Add to the open list (cap at MAX_SECTIONS, drop oldest when full).
  const nextSections = [...current.sections, section].slice(-MAX_SECTIONS);
  $rightDrawer.set({
    ...current,
    open: true,
    activeSection: section,
    sections: nextSections,
  });
}

/**
 * Close a single section. If it was the last one, the drawer stays open
 * (so the "No section selected" placeholder can be shown) — closing the
 * drawer itself is a separate action.
 */
export function closeRightDrawerSection(section: RightDrawerSectionId) {
  const current = $rightDrawer.get();
  const nextSections = current.sections.filter((item) => item !== section);

  $rightDrawer.set({
    ...current,
    sections: nextSections,
    activeSection:
      current.activeSection === section
        ? (nextSections[nextSections.length - 1] ?? undefined)
        : current.activeSection,
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
    sections: [...new Set([activeSection, ...sections])].slice(-MAX_SECTIONS),
    activeSection,
  });
}

/**
 * Add a section to the drawer. No-op if the section is already open.
 * Capped at MAX_SECTIONS — when full, the oldest section is dropped.
 * Opens the drawer and sets the new section as active.
 */
export function addRightDrawerSection(section: RightDrawerSectionId) {
  const current = $rightDrawer.get();
  if (current.sections.includes(section)) {
    $rightDrawer.set({ ...current, activeSection: section, open: true });
    return;
  }
  const nextSections = [...current.sections, section].slice(-MAX_SECTIONS);
  $rightDrawer.set({
    ...current,
    open: true,
    activeSection: section,
    sections: nextSections,
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
