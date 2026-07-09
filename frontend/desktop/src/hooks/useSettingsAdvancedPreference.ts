/* ── Settings Advanced Preference ────────────────────────────────────────── */
/* Persists the rail's "Show advanced" toggle to localStorage. Defaults to
 * hidden (false) so first-time users see the short, beginner-friendly list.
 *
 * Mirrors the localStorage pattern in `useSubagentViewPreference.ts`. */

import { useState, useCallback } from 'react';

const STORAGE_KEY = 'august-settings-advanced';

type AdvancedPreference = boolean;

function loadPreference(): AdvancedPreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'true') return true;
    if (saved === 'false') return false;
  } catch { /* noop */ }
  return false; // default: beginner-friendly, advanced hidden
}

function savePreference(value: AdvancedPreference) {
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
  } catch { /* noop */ }
}

export function useSettingsAdvancedPreference() {
  const [showAdvanced, setShowAdvancedState] = useState<AdvancedPreference>(loadPreference);

  const setShowAdvanced = useCallback(
    (next: AdvancedPreference | ((prev: AdvancedPreference) => AdvancedPreference)) => {
      setShowAdvancedState((prev) => {
        const value =
          typeof next === 'function'
            ? (next)(prev)
            : next;
        savePreference(value);
        return value;
      });
    },
    [],
  );

  const toggle = useCallback(() => {
    setShowAdvanced((prev) => !prev);
  }, [setShowAdvanced]);

  return { showAdvanced, setShowAdvanced, toggle };
}