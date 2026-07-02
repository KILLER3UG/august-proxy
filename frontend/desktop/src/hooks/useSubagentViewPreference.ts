/* ── Subagent View Preference ────────────────────────────────────────── */
/* Persists the subagent panel view mode (collapsed/expanded) to localStorage. */

import { useState, useCallback } from 'react';

const STORAGE_KEY = 'august-subagent-view';

type SubagentView = 'collapsed' | 'expanded';

function loadPreference(): SubagentView {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'collapsed' || saved === 'expanded') return saved;
  } catch { /* noop */ }
  return 'expanded'; // default
}

function savePreference(view: SubagentView) {
  try {
    localStorage.setItem(STORAGE_KEY, view);
  } catch { /* noop */ }
}

export function useSubagentViewPreference() {
  const [view, setViewState] = useState<SubagentView>(loadPreference);

  const setView = useCallback((newView: SubagentView) => {
    setViewState(newView);
    savePreference(newView);
  }, []);

  const toggle = useCallback(() => {
    setView((prev) => (prev === 'expanded' ? 'collapsed' : 'expanded'));
  }, [setView]);

  return { view, setView, toggle };
}
