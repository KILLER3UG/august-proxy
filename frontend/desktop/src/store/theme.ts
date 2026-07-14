/* ── Theme re-exports (Phase 2.4 / Phase 4 B18) ────────────────────── */
/* Thin re-export so existing `@/store/theme` imports keep working.    */
/* Source of truth is `@/lib/theme` which adds 'system' mode + textSize.*/

export {
  $themeMode,
  $textSize,
  useThemeStore,
  applyTheme,
  applyTextSize,
  hydrateTheme,
  setThemeMode,
  setTextSize,
} from '@/lib/theme';
export type { ThemeMode, TextSize } from '@/lib/theme';

/* Backward-compat shim: keep `$theme` as 'light' | 'dark' for any
 * existing consumers. Returns the resolved theme (system resolved to
 * light/dark based on current OS preference). */
import { create } from 'zustand';
import { useThemeStore, setThemeMode } from '@/lib/theme';

function resolvedTheme(): 'light' | 'dark' {
  const mode = useThemeStore.getState().mode;
  if (mode === 'system') {
    if (typeof window === 'undefined') return 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

interface ResolvedThemeState {
  theme: 'light' | 'dark';
}

export const useResolvedThemeStore = create<ResolvedThemeState>(() => ({
  theme: resolvedTheme(),
}));

// Keep resolved theme in sync when mode changes.
useThemeStore.subscribe(() => {
  useResolvedThemeStore.setState({ theme: resolvedTheme() });
});

export const $theme = {
  get: (): 'light' | 'dark' => useResolvedThemeStore.getState().theme,
  set: (theme: 'light' | 'dark'): void => {
    useResolvedThemeStore.setState({ theme });
  },
  subscribe: (listener: (theme: 'light' | 'dark') => void): (() => void) => {
    listener(useResolvedThemeStore.getState().theme);
    return useResolvedThemeStore.subscribe((s) => listener(s.theme));
  },
};

/** Backward-compat toggle (flips between resolved light and dark). */
export function toggleTheme(): void {
  const next = useResolvedThemeStore.getState().theme === 'dark' ? 'light' : 'dark';
  setThemeMode(next);
}
