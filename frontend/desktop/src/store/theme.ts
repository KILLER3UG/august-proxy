/* ── Theme re-exports (Phase 2.4) ──────────────────────────────────── */
/* Thin re-export so existing `@/store/theme` imports keep working.    */
/* Source of truth is `@/lib/theme` which adds 'system' mode + textSize.*/

export {
  $themeMode,
  $textSize,
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
import { atom } from 'nanostores';
import { $themeMode, setThemeMode } from '@/lib/theme';

function resolvedTheme(): 'light' | 'dark' {
  const mode = $themeMode.get();
  if (mode === 'system') {
    if (typeof window === 'undefined') return 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

export const $theme = atom<'light' | 'dark'>(resolvedTheme());
$themeMode.subscribe(() => $theme.set(resolvedTheme()));

/** Backward-compat toggle (flips between resolved light and dark). */
export function toggleTheme(): void {
  const next = $theme.get() === 'dark' ? 'light' : 'dark';
  setThemeMode(next);
}
