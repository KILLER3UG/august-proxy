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

  // Accept either a direct value (legacy callers) or an updater function
  // (matches React's `Dispatch<SetStateAction<T>>` shape so call sites can
  // use `(prev) => ...` safely).
  const setView = useCallback(
    (newView: SubagentView | ((prev: SubagentView) => SubagentView)) => {
      setViewState((prev) => {
        const next =
          typeof newView === 'function'
            ? (newView as (prev: SubagentView) => SubagentView)(prev)
            : newView;
        savePreference(next);
        return next;
      });
    },
    [],
  );

  const toggle = useCallback(() => {
    setView((prev) => (prev === 'expanded' ? 'collapsed' : 'expanded'));
  }, [setView]);

  return { view, setView, toggle };
}
